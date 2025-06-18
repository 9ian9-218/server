import argparse
import asyncio
import json
import logging
import os
import ssl
import uuid

import cv2
from aiohttp import web, WSMsgType
from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaBlackhole, MediaRecorder, MediaRelay
from av import VideoFrame

ROOT = os.path.dirname(__file__)

logger = logging.getLogger("pc")
pcs = set() #一个集合，用于存储所有活跃的 RTCPeerConnection 实例，方便统一管理和清理
relay = MediaRelay()  #MediaRelay 实例，用于将一个媒体流（如摄像头视频）转发给多个client，避免重复读取源流

users = {}  # user_id: {'ws': ws, 'name': name} dir字典


class VideoTransformTrack(MediaStreamTrack):  #继承 MediaStreamTrack 类，用于处理视频流
    
    kind = "video"

    def __init__(self, track, transform):
        super().__init__()  # don't forget this!
        self.track = track 
        self.transform = transform

    async def recv(self):  #接受视频帧并进行处理
        frame = await self.track.recv()

        if self.transform == "cartoon":
            img = frame.to_ndarray(format="bgr24")

            # prepare color
            img_color = cv2.pyrDown(cv2.pyrDown(img)) # downsample the image
            for _ in range(6):
                img_color = cv2.bilateralFilter(img_color, 9, 9, 7)
            img_color = cv2.pyrUp(cv2.pyrUp(img_color)) # upsample the image

            # prepare edges
            img_edges = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
            img_edges = cv2.adaptiveThreshold(
                cv2.medianBlur(img_edges, 7),
                255,
                cv2.ADAPTIVE_THRESH_MEAN_C,
                cv2.THRESH_BINARY,
                9,
                2,
            )
            img_edges = cv2.cvtColor(img_edges, cv2.COLOR_GRAY2RGB)

            # combine color and edges
            img = cv2.bitwise_and(img_color, img_edges)

            # rebuild a VideoFrame, preserving timing information
            new_frame = VideoFrame.from_ndarray(img, format="bgr24")
            new_frame.pts = frame.pts
            new_frame.time_base = frame.time_base
            return new_frame
        elif self.transform == "edges":
            # perform edge detection
            img = frame.to_ndarray(format="bgr24")
            img = cv2.cvtColor(cv2.Canny(img, 100, 200), cv2.COLOR_GRAY2BGR)

            # rebuild a VideoFrame, preserving timing information
            new_frame = VideoFrame.from_ndarray(img, format="bgr24")
            new_frame.pts = frame.pts
            new_frame.time_base = frame.time_base
            return new_frame
        elif self.transform == "rotate":
            # rotate image
            img = frame.to_ndarray(format="bgr24")
            rows, cols, _ = img.shape
            M = cv2.getRotationMatrix2D((cols / 2, rows / 2), frame.time * 45, 1)
            img = cv2.warpAffine(img, M, (cols, rows))

            # rebuild a VideoFrame, preserving timing information
            new_frame = VideoFrame.from_ndarray(img, format="bgr24")
            new_frame.pts = frame.pts
            new_frame.time_base = frame.time_base
            return new_frame
        else:
            return frame


#向client发送web页面的html代码和JavaScript脚本
async def index(request):
    content = open(os.path.join(ROOT, "index.html"), "r", encoding="utf-8").read()
    return web.Response(content_type="text/html", text=content)


async def javascript(request):
    content = open(os.path.join(ROOT, "client.js"), "r", encoding="utf-8").read()
    return web.Response(content_type="application/javascript", text=content)

#处理客户端发送的offer请求，创建RTCPeerConnection实例，并设置媒体流
async def offer(request):
    params = await request.json()
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

    pc = RTCPeerConnection()
    pc_id = "PeerConnection(%s)" % uuid.uuid4()
    pcs.add(pc)

    def log_info(msg, *args):
        logger.info(pc_id + " " + msg, *args)

    log_info("Created for %s", request.remote)
    
    if args.record_to:
        recorder = MediaRecorder(args.record_to)
    else:
        recorder = MediaBlackhole()
    
    #server收到自定义data后，发还给client
    @pc.on("datachannel")
    def on_datachannel(channel):
        @channel.on("message")
        def on_message(message):
            # 回显自定义数据
            if isinstance(message, str) and message.startswith("[custom]"):
                channel.send(message)
            elif isinstance(message, str) and message.startswith("ping"):
                channel.send("pong" + message[18:])

    #如果pc连接状态发生变化，打印日志并在连接失败时关闭连接
    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        log_info("Connection state is %s", pc.connectionState)
        if pc.connectionState == "failed":
            await pc.close()
            pcs.discard(pc)

    #处理echo模式的音频和视频流，并发送回客户端
    @pc.on("track")
    def on_track(track):
        log_info("Track %s received", track.kind)

        if track.kind == "audio":
            #pc.addTrack(player.audio)
            #recorder.addTrack(track)
            pc.addTrack(relay.subscribe(track))
            if args.record_to:
                recorder.addTrack(relay.subscribe(track))
        elif track.kind == "video":
            pc.addTrack(
                VideoTransformTrack(
                    relay.subscribe(track), transform=params["video_transform"]
                )
            )
            if args.record_to:
                recorder.addTrack(relay.subscribe(track))

        @track.on("ended")
        async def on_ended():
            log_info("Track %s ended", track.kind)
            await recorder.stop()

    # handle offer
    await pc.setRemoteDescription(offer)
    await recorder.start()

    # send answer
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    #发送offer相对应的answer给客户端
    return web.Response(
        content_type="application/json",
        text=json.dumps(
            {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}
        ),
    )


#处理WebSocket连接，管理用户连接和信令消息的转发
async def ws_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    user_id = str(uuid.uuid4())
    user_name = None

    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                data = json.loads(msg.data)
                if data["type"] == "join":
                    user_name = data["name"]
                    users[user_id] = {"ws": ws, "name": user_name}
                    # 告诉client端他自己的id
                    await ws.send_json({"type": "self_id", "id": user_id})
                    await broadcast_user_list()
                elif data["type"] == "signal":
                    # 转发信令消息到目标用户
                    target_id = data["to"]
                    if target_id in users:
                        await users[target_id]["ws"].send_json(
                            {"type": "signal", "from": user_id, "data": data["data"]}
                        )
                elif data["type"] == "peer_request":
                    # 转发请求到目标用户
                    target_id = data["to"]
                    if target_id in users:
                        await users[target_id]["ws"].send_json(
                            {
                                "type": "peer_request",
                                "from": user_id,
                                "fromName": users[user_id]["name"],
                            }
                        )
                elif data["type"] == "peer_accept":
                    # 通知发起方可以发offer
                    target_id = data["to"]
                    if target_id in users:
                        await users[target_id]["ws"].send_json(
                            {"type": "peer_accept", "from": user_id}
                        )
            elif msg.type == WSMsgType.ERROR:
                print("ws connection closed with exception %s" % ws.exception())
    finally:
        # 用户离开
        if user_id in users:
            del users[user_id]
            await broadcast_user_list()
    return ws

#广播用户列表给所有连接的用户
async def broadcast_user_list():
    user_list = [{"id": uid, "name": u["name"]} for uid, u in users.items()]
    for u in users.values():
        await u["ws"].send_json({"type": "user_list", "users": user_list})


async def on_shutdown(app):
    # close peer connections
    coros = [pc.close() for pc in pcs]
    await asyncio.gather(*coros)
    pcs.clear()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="WebRTC audio / video / data-channels demo"
    )

    #parser.add_argument("--cert-file", help="SSL certificate file (for HTTPS)")
    #parser.add_argument("--key-file", help="SSL key file (for HTTPS)")

    #以下两行为公网部署的默认指定证书和密钥文件，删除注释后启用并使用https访问，会显示不安全
    parser.add_argument("--cert-file", default=os.path.join(ROOT, "certificate", "server.crt"), help="SSL certificate file (for HTTPS)")
    parser.add_argument("--key-file", default=os.path.join(ROOT, "certificate", "server.key"), help="SSL key file (for HTTPS)")

    parser.add_argument(
        "--host", default="0.0.0.0", help="Host for HTTP server (default: 0.0.0.0)"
    )
    parser.add_argument(
        "--port", type=int, default=4445, help="Port for HTTP server (default: 4445)"
    )
    parser.add_argument("--record-to", help="Write received media to a file.")
    parser.add_argument("--verbose", "-v", action="count")
    args = parser.parse_args()

    if args.verbose:
        logging.basicConfig(level=logging.DEBUG)
    else:
        logging.basicConfig(level=logging.INFO)

    if args.cert_file:
        ssl_context = ssl.SSLContext()
        ssl_context.load_cert_chain(args.cert_file, args.key_file)
    else:
        ssl_context = None

    app = web.Application()
    app.on_shutdown.append(on_shutdown)
    app.router.add_get("/", index)
    app.router.add_get("/client.js", javascript)
    app.router.add_post("/offer", offer)
    app.router.add_get("/ws", ws_handler)
    web.run_app(
        app, access_log=None, host=args.host, port=args.port, ssl_context=ssl_context
    )
