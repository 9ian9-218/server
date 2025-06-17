// get DOM elements
var dataChannelLog = document.getElementById('data-channel'),
    iceConnectionLog = document.getElementById('ice-connection-state'),
    iceGatheringLog = document.getElementById('ice-gathering-state'),
    signalingLog = document.getElementById('signaling-state');

// peer connection
var pc = null;

// data channel
var dc = null, dcInterval = null;

let ws = null, myId = null, myName = null, peerId = null,localStream = null;

function createPeerConnection() {
    var config = {
        sdpSemantics: 'unified-plan' //unified-plan 支持多路音视频流（比如多摄像头、多麦克风），并且是现代浏览器的推荐和默认选项
    };

    if (document.getElementById('use-stun') && document.getElementById('use-stun').checked) {
        config.iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
    }

    if (document.getElementById('use-turn') && document.getElementById('use-turn').checked) {
        config.iceServers = [{
                urls: ['turn:120.79.253.49:3479'],
                username: '9ian9',
                credential: '666'
            }];
    }

    pc = new RTCPeerConnection(config); // 创建一个新的 RTCPeerConnection 实例，可在config里设置数据流形式、stun服务器等参数

    // register some listeners to help debugging
    pc.addEventListener('icegatheringstatechange', () => {
        iceGatheringLog.textContent += ' -> ' + pc.iceGatheringState;
    }, false);
    iceGatheringLog.textContent = pc.iceGatheringState;

    pc.addEventListener('iceconnectionstatechange', () => {
        iceConnectionLog.textContent += ' -> ' + pc.iceConnectionState;
    }, false);
    iceConnectionLog.textContent = pc.iceConnectionState;

    pc.addEventListener('signalingstatechange', () => {
        signalingLog.textContent += ' -> ' + pc.signalingState;
    }, false);
    signalingLog.textContent = pc.signalingState;

    // connect audio / video
    pc.addEventListener('track', (evt) => {
        if (evt.track.kind === 'video') {
            document.getElementById('video').srcObject = evt.streams[0];
        } else if (evt.track.kind === 'audio') {
            document.getElementById('audio').srcObject = evt.streams[0];
        }
    });

    return pc;
}

function enumerateInputDevices() {
    const populateSelect = (select, devices) => {
        let counter = 1;
        select.innerHTML = ''; //清空下拉框中原有的所有选项，确保不会重复添加
        devices.forEach((device) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || ('Device #' + counter);
            select.appendChild(option);
            counter += 1;
        });
    };

    navigator.mediaDevices.enumerateDevices().then((devices) => {
        populateSelect(
            document.getElementById('audio-input'),
            devices.filter((device) => device.kind == 'audioinput')//筛选出音频输入设备
        );
        populateSelect(
            document.getElementById('video-input'),
            devices.filter((device) => device.kind == 'videoinput')//筛选出视频输入设备
        );
    }).catch((e) => {
        alert(e);//如果获取设备列表失败，弹出错误提示
        console.error('Error enumerating devices:', e);
    });
}
  
function negotiate() {//实现client与server的协商（建立连接、交换SDP等）
    return pc.createOffer().then((offer) => {
        return pc.setLocalDescription(offer);
    }).then(() => {
        // wait for ICE gathering to complete
        return new Promise((resolve) => { //收集完成才调用resolve
            if (pc.iceGatheringState === 'complete') {
                resolve();
            } else {
                function checkState() {
                    if (pc.iceGatheringState === 'complete') {
                        pc.removeEventListener('icegatheringstatechange', checkState);
                        resolve();
                    }
                }
                pc.addEventListener('icegatheringstatechange', checkState);
            }
        });
        //以上为收集本地ice候选者的逻辑，确保在发送offer之前ICE候选者已经收集完成
    }).then(() => {
        var offer = pc.localDescription;
        var codec;

        //根据web上的选择确定sdp的语音和视频的编码形式
        codec = document.getElementById('audio-codec') ? document.getElementById('audio-codec').value : 'default';
        if (codec !== 'default') {
            offer.sdp = sdpFilterCodec('audio', codec, offer.sdp);
        }

        codec = document.getElementById('video-codec') ? document.getElementById('video-codec').value : 'default';
        if (codec !== 'default') {
            offer.sdp = sdpFilterCodec('video', codec, offer.sdp);
        }

        document.getElementById('offer-sdp').textContent = offer.sdp;
        
        return fetch('/offer', {//确定请求体内容是一个 JSON 字符串
            body: JSON.stringify({
                sdp: offer.sdp,
                type: offer.type,
                video_transform: document.getElementById('video-transform') ? document.getElementById('video-transform').value : ''
            }),
            headers: {
                'Content-Type': 'application/json'//告诉服务器请求体是 JSON 格式
            },
            method: 'POST'
        });
    }).then((response) => {
        return response.json();
    }).then((answer) => {//answer为接续为json的response
        document.getElementById('answer-sdp').textContent = answer.sdp;
        return pc.setRemoteDescription(answer);//将服务器返回的answer设置为远端描述
    }).catch((e) => {
        alert(e);
    });
}

function startEcho() {//回显模式
    document.getElementById('user-list-area') && (document.getElementById('user-list-area').style.display = 'none');
    pc = createPeerConnection();
    let lastPingTime = 0; // 用于计算RTT

    if (document.getElementById('use-datachannel').checked) {//若启用了数据传输
        var parameters = JSON.parse(document.getElementById('datachannel-parameters').value);

        dc = pc.createDataChannel('chat', parameters);
        dc.addEventListener('close', () => {
            clearInterval(dcInterval);
            dataChannelLog.textContent += '- close\n';
        });
        dc.addEventListener('open', () => {
            dataChannelLog.textContent += '- open\n';
            dcInterval = setInterval(() => {
                var message = 'ping ' + Date.now();
                dataChannelLog.textContent += '> ' + message + '\n';
                dc.send(message); // 关键：要真正发送ping消息
                lastPingTime = Date.now(); // 记录发送时间
            }, 1000);
        });
        
        dc.addEventListener('message', (evt) => {

            dataChannelLog.textContent += '< ' + evt.data +' '+ Date.now() + '\n';
            if (evt.data.startsWith("[custom]")) {
                var received = evt.data.substring(8);
                document.getElementById('chat-data').textContent += '< '+received +' '+ Date.now()+'\n';
            }
            if (evt.data.substring(0, 4) === 'pong') {
                var elapsed_ms = Date.now() - lastPingTime;
                dataChannelLog.textContent += ' RTT ' + elapsed_ms + ' ms\n';
            }
        });
    }

    // Build media constraints.
    const constraints = {
        audio: false,
        video: false
    };

    //确定是否使用音频和视频输入及音视频输入的设备，及视频的分辨率
    if (document.getElementById('use-audio').checked) {
        const audioConstraints = {};
        const device = document.getElementById('audio-input').value;
        if (device) {
            audioConstraints.deviceId = { exact: device };
        }
        constraints.audio = Object.keys(audioConstraints).length ? audioConstraints : true;
    }

    if (document.getElementById('use-video').checked) {
        const videoConstraints = {};
        const device = document.getElementById('video-input').value;
        if (device) {
            videoConstraints.deviceId = { exact: device };
        }
        const resolution = document.getElementById('video-resolution').value;
        if (resolution) {
            const dimensions = resolution.split('x');
            videoConstraints.width = parseInt(dimensions[0], 0);
            videoConstraints.height = parseInt(dimensions[1], 0);
        }
        constraints.video = Object.keys(videoConstraints).length ? videoConstraints : true;
    }

    if (constraints.audio || constraints.video) {
        if (constraints.video) {
            document.getElementById('media').style.display = 'block';
        }
        navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
            stream.getTracks().forEach((track) => {
                pc.addTrack(track, stream);
            });
            return negotiate();
        }, (err) => {
            alert('Could not acquire media: ' + err);
        });
    } else {
        negotiate();
    }
}


function sendCustomData() {
    var mode = document.getElementById('send-mode').value;
    var input = document.getElementById('data-input').value;
    if (mode === 'peer') {
        if (dc && dc.readyState === "open") {
            document.getElementById('chat-data').textContent += '> '+input +' '+ Date.now()+'\n'; 
            dc.send(input);
            dataChannelLog.textContent += '> ' +'[custom]'+ input + ' ' + Date.now() + '\n';// 发送时也在日志中显示
        } else {
            alert("DataChannel not open");
        }
    } else {
        // echo模式保持原逻辑
        if (dc && dc.readyState === "open") {
            dc.send("[custom]" + input);
            dataChannelLog.textContent += '> ' +'[custom]'+ input + ' ' + Date.now() + '\n';
            document.getElementById('chat-data').textContent += '> '+input +' '+ Date.now()+'\n';
        } else {
            alert("DataChannel not open");
        }
    }
}

function stop() {
    if (dc) dc.close();
    if (pc) pc.close();
    if (ws) {
        ws.close();
        ws = null;
    }
    document.getElementById('stop').style.display = 'none';
    document.getElementById('start').style.display = 'inline-block';
    document.getElementById('user-list-area') && (document.getElementById('user-list-area').style.display = 'none');
    document.getElementById('chat-data').textContent = '';
    document.getElementById('main-content').style.display = 'none';
    // 其它UI重置...
}

// SDP过滤器函数，用于根据指定的编解码器过滤SDP
function sdpFilterCodec(kind, codec, realSdp) { 
    var allowed = []
    var rtxRegex = new RegExp('a=fmtp:(\\d+) apt=(\\d+)\r$');
    var codecRegex = new RegExp('a=rtpmap:([0-9]+) ' + escapeRegExp(codec))
    var videoRegex = new RegExp('(m=' + kind + ' .*?)( ([0-9]+))*\\s*$')

    var lines = realSdp.split('\n');

    var isKind = false;
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('m=' + kind + ' ')) {
            isKind = true;
        } else if (lines[i].startsWith('m=')) {
            isKind = false;
        }

        if (isKind) {
            var match = lines[i].match(codecRegex);
            if (match) {
                allowed.push(parseInt(match[1]));
            }

            match = lines[i].match(rtxRegex);
            if (match && allowed.includes(parseInt(match[2]))) {
                allowed.push(parseInt(match[1]));
            }
        }
    }

    var skipRegex = 'a=(fmtp|rtcp-fb|rtpmap):([0-9]+)';
    var sdp = '';

    isKind = false;
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('m=' + kind + ' ')) {
            isKind = true;
        } else if (lines[i].startsWith('m=')) {
            isKind = false;
        }

        if (isKind) {
            var skipMatch = lines[i].match(skipRegex);
            if (skipMatch && !allowed.includes(parseInt(skipMatch[2]))) {
                continue;
            } else if (lines[i].match(videoRegex)) {
                sdp += lines[i].replace(videoRegex, '$1 ' + allowed.join(' ')) + '\n';
            } else {
                sdp += lines[i] + '\n';
            }
        } else {
            sdp += lines[i] + '\n';
        }
    }

    return sdp;
}

//防止datachannel中输入的正则表达式字符被误解
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

function startPeer() {//点对点通信模式
    ws = new WebSocket('ws://' + location.host + '/ws');
    ws.onopen = function() {
        ws.send(JSON.stringify({type: 'join', name: myName}));
        document.getElementById('user-list-area').style.display = '';
    };
    ws.onmessage = function(event) {
        let msg = JSON.parse(event.data);
        if (msg.type === 'self_id') {
            myId = msg.id;
        } else if (msg.type === 'user_list') {
            updateUserList(msg.users);
        } else if (msg.type === 'signal') {
            handleSignal(msg.from, msg.data);
        } else if (msg.type === 'peer_request') {
            if (confirm(msg.fromName + " 想和你通信，是否同意？")) {
                acceptPeer(msg.from);
            }
        } else if (msg.type === 'peer_accept') {
            // 对方同意，A发起WebRTC连接
            peerId = msg.from;
            pc = createPeerConnection();
            getLocalStream().then(stream => {
                if (stream) {
                    stream.getTracks().forEach(track => {
                        pc.addTrack(track, stream);
                    });
                }
            });
            dc = pc.createDataChannel('chat');
            dc.onopen = () => {
                dataChannelLog.textContent += '- open\n';
            };
            dc.onclose = () => {
                dataChannelLog.textContent += '- close\n';
            };
            dc.onmessage = (evt) => {
                dataChannelLog.textContent += '< ' + evt.data +' '+ Date.now() + '\n';
                document.getElementById('chat-data').textContent +='< ' + evt.data+' '+ Date.now()+'\n';
            };
            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    ws.send(JSON.stringify({
                        type: 'signal',
                        to: peerId,
                        data: {type: 'candidate', candidate: event.candidate}
                    }));
                }
            };

            //点击对方id后，通过websocket发送Offer给对应id的用户
            pc.createOffer().then(offer => {
                document.getElementById('offer-sdp').textContent = offer.sdp; // 显示Offer
                return pc.setLocalDescription(offer);
            }).then(() => {
                ws.send(JSON.stringify({
                    type: 'signal',
                    to: peerId,
                    data: {type: 'offer', sdp: pc.localDescription}
                }));
            });
        }
    };
}

enumerateInputDevices();

function start() {
    var mode = document.getElementById('send-mode').value;
    myName = document.getElementById('user-name').value;

    document.getElementById('start').style.display = 'none';
    document.getElementById('stop').style.display = 'inline-block';
    document.getElementById('main-content').style.display = 'block';


    if (mode === 'echo') {
        startEcho();
    } else if (mode === 'peer') {
        startPeer();
    }
}

//peer模式下，clients收到信令消息时的处理函数
function handleSignal(from, data) {
    if (data.type === 'offer') {
        // B 端收到 offer，建立 PeerConnection 并回复 answer
        peerId = from;
        pc = createPeerConnection();
        getLocalStream().then(stream => {
            if (stream) {
                stream.getTracks().forEach(track => {
                    pc.addTrack(track, stream);
                });
            }
        });
        pc.ondatachannel = (event) => {
            dc = event.channel;
            dc.onopen = () => {
                dataChannelLog.textContent += '- open\n';
            };
            dc.onclose = () => {
                dataChannelLog.textContent += '- close\n';
            };
            dc.onmessage = (evt) => {
                dataChannelLog.textContent += '< ' + evt.data + ' '+Date.now()  +'\n';
                document.getElementById('chat-data').textContent += '< ' + evt.data + ' '+Date.now()  +'\n';
            };
        };

        // 处理 ICE 事件
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                ws.send(JSON.stringify({
                    type: 'signal',
                    to: peerId,
                    data: {type: 'candidate', candidate: event.candidate}
                }));
            }
        };
        //收到建联消息，设置对方为远端描述并创建 Answer通过WebSocket发送给对方
        pc.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(() => {
            document.getElementById('offer-sdp').textContent = data.sdp.sdp; // 显示对方Offer
            return pc.createAnswer();
        }).then(answer => {
            document.getElementById('answer-sdp').textContent = answer.sdp; // 显示本地Answer
            return pc.setLocalDescription(answer);
        }).then(() => {
            ws.send(JSON.stringify({
                type: 'signal',
                to: peerId,
                data: {type: 'answer', sdp: pc.localDescription}
            }));
        });

    // 如果是Answer则设置其远端描述，此时peerconnection已经建立
    } else if (data.type === 'answer') {
        document.getElementById('answer-sdp').textContent = data.sdp.sdp; // 显示对方Answer
        pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    // 如果是ICE候选者，则添加到PeerConnection中
    } else if (data.type === 'candidate') {
        pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
}

function updateUserList(users) {
    const ul = document.getElementById('user-list');
    ul.innerHTML = '';
    users.forEach(u => {
        if (u.id !== myId) {
            const li = document.createElement('li');
            li.textContent = `${u.name} (${u.id})`;
            li.style.cursor = 'pointer';
            li.onclick = function() {
                ws.send(JSON.stringify({type: 'peer_request', to: u.id}));
            };
            ul.appendChild(li);
        }
    });
}

function acceptPeer(fromId) {
    ws.send(JSON.stringify({type: 'peer_accept', to: fromId}));
}



async function getLocalStream() {
    const constraints = {};
    // 音频
    if (document.getElementById('use-audio').checked) {
        const audioConstraints = {};
        const device = document.getElementById('audio-input').value;
        if (device) {
            audioConstraints.deviceId = { exact: device };
        }
        constraints.audio = Object.keys(audioConstraints).length ? audioConstraints : true;
    }
    // 视频
    if (document.getElementById('use-video').checked) {
        const videoConstraints = {};
        const device = document.getElementById('video-input').value;
        if (device) {
            videoConstraints.deviceId = { exact: device };
        }
        const resolution = document.getElementById('video-resolution').value;
        if (resolution) {
            const dimensions = resolution.split('x');
            videoConstraints.width = parseInt(dimensions[0], 0);
            videoConstraints.height = parseInt(dimensions[1], 0);
        }
        // 帧率
        const framerate = document.getElementById('video-framerate')?.value;
        if (framerate) {
            videoConstraints.frameRate = parseInt(framerate, 10);
        }
        constraints.video = Object.keys(videoConstraints).length ? videoConstraints : true;
    }

    if (constraints.audio || constraints.video) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia(constraints);

            // transform 处理（如美颜/特效）
            const transform = document.getElementById('video-transform')?.value;
            if (constraints.video && transform && transform !== 'none') {
                const transformedStream = await applyVideoTransform(stream, transform);
                return transformedStream;
            }
            return stream;
        } catch (err) {
            alert('无法获取音视频流: ' + err);
            return null;
        }
    } else {
        return null;
    }
}
