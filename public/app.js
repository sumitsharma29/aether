const ADJECTIVES = ['Ethereal', 'Quantum', 'Neural', 'Astral', 'Luminous', 'Spectral', 'Hyper', 'Sonic', 'Vortex', 'Prime'];
const NOUNS = ['Node', 'Pulse', 'Wave', 'Core', 'Link', 'Drift', 'Gate', 'Beam', 'Flux', 'Cell'];

function generateName() {
    return `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${NOUNS[Math.floor(Math.random() * NOUNS.length)]}`;
}

// Room ID logic
const urlParams = new URLSearchParams(window.location.search);
let roomCode = urlParams.get('room') || Math.floor(100000 + Math.random() * 900000).toString();
try {
    const display = document.getElementById('room-id-display');
    if (display) display.textContent = roomCode;
} catch (e) { console.error('UI Init Error:', e); }

if (!urlParams.get('room')) {
    const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?room=' + roomCode;
    window.history.pushState({ path: newUrl }, '', newUrl);
}

// Global State
let myId = null;
let myName = generateName();
let peers = new Map(); // peerId -> { name, element, pc, isWebrtcDirect }
let selectedPeerId = null;
let currentPIN = null;
let pendingRequest = null;
let isTransferring = false;
let shouldAbort = false;
let currentShareUrl = '';
let history = [];
try {
    history = JSON.parse(localStorage.getItem('aether_history') || '[]');
} catch (e) { console.error('Storage Error:', e); }

const CHUNK_SIZE = 128 * 1024; // 128KB chunk size

// Status Indicator
let statusIndicator = null;
function createStatusIndicator() {
    if (statusIndicator) return;
    statusIndicator = document.createElement('div');
    statusIndicator.className = 'fixed bottom-4 right-4 z-[200] px-4 py-2 rounded-full text-[9px] font-black uppercase tracking-widest glass border border-white/5 flex items-center gap-2';
    statusIndicator.innerHTML = '<span class="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></span> <span>Connecting...</span>';
    document.body.appendChild(statusIndicator);
}

function updateStatus(peersCount) {
    if (!statusIndicator) createStatusIndicator();
    const color = peersCount > 0 ? 'bg-green-500' : 'bg-cyan-500';
    statusIndicator.innerHTML = `<span class="w-2 h-2 rounded-full ${color}"></span> <span>Online • Peers: ${peersCount}</span>`;
}

// DOM Elements Initialization
let myDisplayName, peersContainer, emptyState, fileInput, httpFileInput, notification, dragOverlay, settingsPanel;
let modalSelection, modalPinDisplay, modalIncoming, modalReady, modalProgress, modalQr, btnSelectFile;

function initDOMElements() {
    myDisplayName = document.getElementById('my-display-name');
    peersContainer = document.getElementById('peers-container');
    emptyState = document.getElementById('empty-state');
    fileInput = document.getElementById('file-input');
    httpFileInput = document.getElementById('http-file-input');
    notification = document.getElementById('notification');
    dragOverlay = document.getElementById('drag-overlay');
    settingsPanel = document.getElementById('settings-panel');

    modalSelection = document.getElementById('modal-selection');
    modalPinDisplay = document.getElementById('modal-pin-display');
    modalIncoming = document.getElementById('modal-incoming');
    modalReady = document.getElementById('modal-ready');
    modalProgress = document.getElementById('modal-progress');
    modalQr = document.getElementById('modal-qr');
    btnSelectFile = document.getElementById('btn-select-file');

    if (myDisplayName) myDisplayName.textContent = myName;
    const roomDisplay = document.getElementById('room-id-display');
    if (roomDisplay) roomDisplay.textContent = roomCode;

    if (btnSelectFile) {
        btnSelectFile.onclick = () => {
            if (fileInput) fileInput.click();
            closeModals();
        };
    }

    const btnCancel = document.getElementById('btn-cancel-transfer');
    if (btnCancel) {
        btnCancel.onclick = () => {
            shouldAbort = true;
            showNotification('Aborting transmission...');
            if (selectedPeerId && socket) {
                socket.emit('relay-abort', { targetId: selectedPeerId });
            }
        };
    }
}

// Smart Backend Signaling & API Server Resolution
const RENDER_BACKEND_URL = "https://aether-innt.onrender.com";
const isStaticHost = window.location.hostname.includes("netlify.app") || 
                     window.location.hostname.includes("vercel.app") || 
                     window.location.hostname.includes("github.io");

const SERVER_BASE_URL = isStaticHost ? RENDER_BACKEND_URL : window.location.origin;

// Safe Socket Initialization
let socket = null;
let scriptInjected = false;

function initSocket() {
    if (typeof io === 'undefined') {
        if (!scriptInjected) {
            scriptInjected = true;
            console.log(`[AETHER] Dynamically loading Socket.IO client from ${SERVER_BASE_URL}...`);
            const script1 = document.createElement('script');
            script1.src = 'https://cdn.socket.io/4.8.1/socket.io.min.js';
            document.head.appendChild(script1);

            const script2 = document.createElement('script');
            script2.src = `${SERVER_BASE_URL}/socket.io/socket.io.js`;
            document.head.appendChild(script2);
        }
        console.warn('[AETHER] Socket.IO client script pending. Retrying in 500ms...');
        setTimeout(initSocket, 500);
        return;
    }

    if (socket) return; // Already initialized

    try {
        console.log(`[AETHER] Connecting socket to backend server: ${SERVER_BASE_URL}`);
        socket = io(SERVER_BASE_URL, {
            transports: ['websocket', 'polling'],
            reconnectionAttempts: 10
        });

        socket.on('connect', () => {
            updateStatus(peers.size);
            console.log(`[AETHER] Connected! ID: ${socket.id} | Room: ${roomCode}`);
            socket.emit('register', { displayName: myName, roomCode: roomCode });
        });

        socket.on('init', (data) => {
            myId = data.id;
            console.log(`[AETHER] Initialized. Peers count: ${data.peers.length}`);
            data.peers.forEach(p => addPeerUI(p.id, p.displayName));
            updateStatus(peers.size);
        });

        socket.on('user-joined', (p) => {
            console.log(`[AETHER] Peer Joined: ${p.displayName}`);
            addPeerUI(p.id, p.displayName);
            updateStatus(peers.size);
            showNotification(`${p.displayName} Detected`);
        });

        socket.on('user-left', (id) => {
            console.log(`[AETHER] Peer Left: ${id}`);
            removePeerUI(id);
            updateStatus(peers.size);
        });

        socket.on('signal', (data) => {
            const peer = peers.get(data.sender);
            if (peer && peer.pc) {
                try { peer.pc.signal(data.signal); } catch (e) {}
            }
        });

        socket.on('incoming-request', (data) => {
            pendingRequest = data;
            const msgEl = document.getElementById('incoming-msg');
            const pinEl = document.getElementById('receiver-pin');
            if (msgEl) msgEl.textContent = `${data.senderName} requesting link`;
            if (pinEl) pinEl.textContent = data.pin;
            showModal(modalIncoming);
            pulseHaptic([100, 50, 100]);
        });

        socket.on('request-accepted', (data) => {
            showNotification('Neural Tunnel Connected');
            closeModals();
            initConnection(data.receiverId, true);
            showModal(modalReady);
            playSound('connect');
        });

        socket.on('request-declined', () => {
            showNotification('Link Aborted', 4000);
            closeModals();
        });

        socket.on('relay-start', ({ senderId, metadata }) => {
            incomingFileData = { metadata, chunks: [], receivedSize: 0, startTime: Date.now(), mode: 'SOCKET RELAY' };
            showModal(modalProgress);
            const statusEl = document.getElementById('progress-status');
            const fileEl = document.getElementById('progress-filename');
            if (statusEl) statusEl.innerHTML = `🔄 SOCKET RELAY MODE <span class="block text-[10px] opacity-50 mt-1">Receiving Stream</span>`;
            if (fileEl) fileEl.textContent = metadata.name;
        });

        socket.on('relay-chunk', ({ senderId, chunk, index }) => {
            try {
                const arrayBuf = base64ToArrayBuffer(chunk);
                processIncomingChunk(arrayBuf);
            } catch (e) { console.error('Relay chunk error:', e); }
        });

        socket.on('relay-end', ({ senderId }) => {
            finishIncomingTransfer();
        });

        socket.on('relay-abort', ({ senderId }) => {
            closeModals();
            showNotification('Transfer aborted by sender');
            incomingFileData = { metadata: null, chunks: [], receivedSize: 0, startTime: 0, mode: 'P2P' };
        });

    } catch (err) {
        console.error('Socket initialization error:', err);
    }
}

// --- Audio & Haptics ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playSound(type) {
    const soundSetting = document.getElementById('setting-sound');
    if (soundSetting && !soundSetting.checked) return;
    
    try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        const now = audioCtx.currentTime;
        
        if (type === 'connect') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, now);
            osc.frequency.exponentialRampToValueAtTime(880, now + 0.1);
            gain.gain.setValueAtTime(0.1, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
            osc.start(now);
            osc.stop(now + 0.1);
        } else if (type === 'notify') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(330, now);
            gain.gain.setValueAtTime(0.05, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
            osc.start(now);
            osc.stop(now + 0.05);
        } else if (type === 'success') {
            [523.25, 659.25, 783.99].forEach((freq, i) => {
                const o = audioCtx.createOscillator();
                const g = audioCtx.createGain();
                o.connect(g); g.connect(audioCtx.destination);
                o.frequency.setValueAtTime(freq, now + (i * 0.1));
                g.gain.setValueAtTime(0.1, now + (i * 0.1));
                g.gain.exponentialRampToValueAtTime(0.01, now + (i * 0.1) + 0.2);
                o.start(now + (i * 0.1));
                o.stop(now + (i * 0.1) + 0.2);
            });
        }
    } catch (e) {}
}

function pulseHaptic(pattern = 10) {
    const hapticSetting = document.getElementById('setting-haptic');
    if (hapticSetting && hapticSetting.checked && navigator.vibrate) {
        navigator.vibrate(pattern);
    }
}

// --- UI Helpers ---
window.showNotification = function(msg, duration = 3000) {
    if (!notification) notification = document.getElementById('notification');
    if (!notification) return;
    const span = notification.querySelector('span');
    if (span) span.textContent = msg;
    notification.classList.remove('translate-y-40', 'opacity-0');
    playSound('notify');
    pulseHaptic(20);
    setTimeout(() => {
        notification.classList.add('translate-y-40', 'opacity-0');
    }, duration);
};

window.showModal = function(modal) {
    if (modal) modal.classList.remove('hidden');
};

window.closeModals = function() {
    [modalSelection, modalPinDisplay, modalIncoming, modalReady, modalProgress, modalQr].forEach(m => {
        if (m) m.classList.add('hidden');
    });
};

window.toggleSettings = function() {
    if (!settingsPanel) settingsPanel = document.getElementById('settings-panel');
    if (!settingsPanel) return;
    const isHidden = settingsPanel.classList.contains('hidden');
    if (isHidden) {
        settingsPanel.classList.remove('hidden');
        setTimeout(() => settingsPanel.classList.remove('scale-90', 'opacity-0'), 10);
    } else {
        settingsPanel.classList.add('scale-90', 'opacity-0');
        setTimeout(() => settingsPanel.classList.add('hidden'), 300);
    }
};

window.copyRoomLink = function() {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
        showNotification('Room link copied! Send to recipient');
    });
};

function generatePIN() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

// --- Peer UI ---
function addPeerUI(id, name) {
    if (peers.has(id)) return;
    if (emptyState) emptyState.classList.add('hidden');
    
    const el = document.createElement('div');
    el.id = `peer-${id}`;
    el.className = 'absolute transform -translate-x-1/2 -translate-y-1/2 cursor-pointer transition-all duration-1000 float group';
    
    const angle = Math.random() * Math.PI * 2;
    const radius = 25 + Math.random() * 15;
    el.style.left = `${50 + Math.cos(angle) * radius}%`;
    el.style.top = `${50 + Math.sin(angle) * radius}%`;
    
    el.innerHTML = `
        <div class="flex flex-col items-center gap-4">
            <div class="w-20 h-20 rounded-[2rem] glass flex items-center justify-center text-2xl font-black border-2 border-cyan-500/20 group-hover:border-cyan-400 group-hover:shadow-[0_0_40px_hsla(var(--primary),0.4)] transition-all btn-aether">
                ${name.charAt(0)}
            </div>
            <span class="text-[9px] font-black uppercase tracking-[0.4em] text-cyan-300 bg-cyan-500/10 px-4 py-1.5 rounded-xl border border-cyan-500/20 opacity-0 group-hover:opacity-100 transition-all transform translate-y-3 group-hover:translate-y-0 shadow-2xl backdrop-blur-md">${name}</span>
        </div>
    `;
    
    el.onclick = () => selectPeer(id);
    if (peersContainer) peersContainer.appendChild(el);
    peers.set(id, { name, element: el, pc: null, isWebrtcDirect: false });
}

window.selectPeer = function(id) {
    selectedPeerId = id;
    const peer = peers.get(id);
    if (!peer) return;

    const peerNameEl = document.getElementById('selected-peer-name');
    if (peerNameEl) peerNameEl.textContent = peer.name;
    showModal(modalSelection);
    drawBeam(id);
};

function removePeerUI(id) {
    const el = document.getElementById(`peer-${id}`);
    if (el) el.remove();
    
    const beam = document.getElementById('quantum-beam');
    if (selectedPeerId === id && beam) beam.remove();
    
    const peer = peers.get(id);
    if (peer && peer.pc) {
        try { peer.pc.destroy(); } catch (e) {}
    }
    
    peers.delete(id);
    if (peers.size === 0 && emptyState) emptyState.classList.remove('hidden');
}

// --- Handshake Handlers ---
window.handleSelection = function(intent) {
    closeModals();
    currentPIN = generatePIN();
    const callerPinEl = document.getElementById('caller-pin');
    if (callerPinEl) callerPinEl.textContent = currentPIN;
    showModal(modalPinDisplay);
    if (socket) socket.emit('request-connect', { targetId: selectedPeerId, intent, pin: currentPIN });
};

window.cancelRequest = function() {
    closeModals();
    selectedPeerId = null;
};

window.acceptRequest = function() {
    if (!pendingRequest) return;
    if (socket) socket.emit('accept-connect', { senderId: pendingRequest.senderId });
    initConnection(pendingRequest.senderId, false);
    closeModals();
};

window.declineRequest = function() {
    if (!pendingRequest) return;
    if (socket) socket.emit('decline-connect', { senderId: pendingRequest.senderId });
    pendingRequest = null;
    closeModals();
};

// --- Connection Setup (WebRTC P2P + Socket Relay) ---
function initConnection(targetId, initiator) {
    let pc = null;
    const peer = peers.get(targetId);
    
    if (typeof SimplePeer !== 'undefined') {
        try {
            pc = new SimplePeer({
                initiator,
                trickle: true,
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' }
                    ]
                }
            });

            pc.on('signal', (signal) => {
                if (socket) socket.emit('signal', { target: targetId, signal });
            });

            pc.on('connect', () => {
                console.log(`[AETHER] WebRTC P2P Direct Tunnel established with ${targetId}`);
                if (peer) peer.isWebrtcDirect = true;
                showNotification('⚡ P2P Direct Tunnel Ready');
                playSound('connect');
            });

            pc.on('data', (data) => handleIncomingData(data, targetId, 'webrtc'));

            pc.on('error', (err) => {
                console.warn('[AETHER] WebRTC Error, using Socket Relay fallback:', err);
                if (peer) peer.isWebrtcDirect = false;
            });

            pc.on('close', () => {
                if (peer) peer.isWebrtcDirect = false;
            });

            if (peer) peer.pc = pc;
        } catch (e) {
            console.warn('WebRTC init exception:', e);
            if (peer) peer.isWebrtcDirect = false;
        }
    } else {
        if (peer) peer.isWebrtcDirect = false;
    }
}

// --- Multi-Method File Transmission ---
function setupFileInputListeners() {
    if (fileInput) {
        fileInput.onchange = async (e) => {
            const files = Array.from(e.target.files);
            if (files.length === 0 || !selectedPeerId) return;
            
            fileInput.value = '';
            isTransferring = true;
            shouldAbort = false;
            
            for (let i = 0; i < files.length; i++) {
                if (shouldAbort) break;
                await sendFileMultiTier(files[i], selectedPeerId, i + 1, files.length);
            }
            
            isTransferring = false;
            shouldAbort = false;
        };
    }

    if (httpFileInput) {
        httpFileInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            httpFileInput.value = '';
            showNotification('Uploading & generating QR Link...');

            try {
                const base64Data = await fileToBase64(file);
                const response = await fetch(SERVER_BASE_URL + '/api/upload', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: file.name,
                        mime: file.type,
                        data: base64Data
                    })
                });

                const result = await response.json();
                if (result.success) {
                    const fullUrl = SERVER_BASE_URL + result.downloadUrl;
                    currentShareUrl = fullUrl;

                    const inputEl = document.getElementById('share-url-input');
                    if (inputEl) inputEl.value = fullUrl;
                    
                    const qrContainer = document.getElementById('qr-code-container');
                    if (qrContainer) {
                        qrContainer.innerHTML = '';
                        if (typeof QRCode !== 'undefined') {
                            new QRCode(qrContainer, {
                                text: fullUrl,
                                width: 180,
                                height: 180,
                                colorDark: "#090a0f",
                                colorLight: "#ffffff",
                                correctLevel: QRCode.CorrectLevel.H
                            });
                        } else {
                            qrContainer.innerHTML = `
                                <div class="p-4 bg-slate-900 text-cyan-300 rounded-xl font-mono text-[10px] text-center max-w-[200px] break-all">
                                    <p class="font-bold text-white mb-2">DOWNLOAD LINK:</p>
                                    ${fullUrl}
                                </div>
                            `;
                        }
                    }

                    showModal(modalQr);
                    showNotification('Link & QR Code Ready!');
                    playSound('success');
                    addToHistory(file.name, 'HTTP Link');
                } else {
                    showNotification('Upload failed. Try smaller file.');
                }
            } catch (err) {
                console.error('HTTP upload error:', err);
                showNotification('Failed to generate link');
            }
        };
    }
}

async function sendFileMultiTier(file, targetId, index = 1, total = 1) {
    const peer = peers.get(targetId);
    const useWebRTC = peer && peer.pc && peer.isWebrtcDirect && peer.pc.connected;
    
    showModal(modalProgress);
    const modeBadge = useWebRTC ? '⚡ WEBRTC DIRECT P2P' : '🔄 SOCKET SERVER RELAY';
    
    const statusEl = document.getElementById('progress-status');
    const fileEl = document.getElementById('progress-filename');
    if (statusEl) statusEl.innerHTML = `${modeBadge} <span class="block text-[10px] opacity-50 mt-1">Transmitting File ${index} of ${total}</span>`;
    if (fileEl) fileEl.textContent = file.name;

    const readChunk = (file, offset) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsArrayBuffer(slice);
        });
    };

    let offset = 0;
    let startTime = Date.now();
    const metadata = { name: file.name, size: file.size, mime: file.type };

    if (useWebRTC) {
        peer.pc.send(JSON.stringify({ type: 'metadata', ...metadata }));
    } else {
        if (socket) socket.emit('relay-start', { targetId, metadata });
    }

    let chunkIndex = 0;
    while (offset < file.size) {
        if (shouldAbort) {
            if (useWebRTC) peer.pc.send(JSON.stringify({ type: 'abort' }));
            else if (socket) socket.emit('relay-abort', { targetId });
            return;
        }

        if (useWebRTC && peer.pc.bufferSize > 4 * 1024 * 1024) {
            await new Promise(r => setTimeout(r, 40));
            continue;
        }

        const chunk = await readChunk(file, offset);

        if (useWebRTC) {
            peer.pc.send(chunk);
        } else {
            const base64Chunk = arrayBufferToBase64(chunk);
            if (socket) socket.emit('relay-chunk', { targetId, chunk: base64Chunk, index: chunkIndex });
        }

        offset += chunk.byteLength;
        chunkIndex++;

        const percent = Math.round((offset / file.size) * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = (offset / 1024 / 1024 / (elapsed || 0.1)).toFixed(2);

        const fillEl = document.getElementById('progress-bar-fill');
        const percentEl = document.getElementById('progress-percent');
        const speedEl = document.getElementById('progress-speed');

        if (fillEl) fillEl.style.width = `${percent}%`;
        if (percentEl) percentEl.textContent = `${percent}%`;
        if (speedEl) speedEl.textContent = `${speed} MB/s`;

        if (chunkIndex % 5 === 0) {
            await new Promise(r => setTimeout(r, 5));
        }
    }

    if (useWebRTC) {
        peer.pc.send(JSON.stringify({ type: 'eof' }));
    } else {
        if (socket) socket.emit('relay-end', { targetId });
    }

    if (index === total) {
        setTimeout(() => {
            closeModals();
            showNotification(`Transmission Complete (${modeBadge})`);
            playSound('success');
            addToHistory(file.name, 'sent');
        }, 800);
    }
}

// --- Incoming Data Stream Handler ---
let incomingFileData = { metadata: null, chunks: [], receivedSize: 0, startTime: 0, mode: 'P2P' };

function handleIncomingData(data, senderId, sourceMode = 'webrtc') {
    try {
        let msg = null;
        if (typeof data === 'string') {
            msg = JSON.parse(data);
        } else if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
            try {
                const decoded = new TextDecoder().decode(data);
                if (decoded.startsWith('{"type":"metadata"')) msg = JSON.parse(decoded);
                else if (decoded.startsWith('{"type":"eof"')) msg = JSON.parse(decoded);
                else if (decoded.startsWith('{"type":"abort"')) msg = JSON.parse(decoded);
            } catch (e) {}
        }

        if (msg) {
            if (msg.type === 'metadata') {
                incomingFileData = { metadata: msg, chunks: [], receivedSize: 0, startTime: Date.now(), mode: '⚡ WEBRTC P2P' };
                showModal(modalProgress);
                const statusEl = document.getElementById('progress-status');
                const fileEl = document.getElementById('progress-filename');
                if (statusEl) statusEl.innerHTML = `⚡ WEBRTC P2P <span class="block text-[10px] opacity-50 mt-1">Receiving Stream</span>`;
                if (fileEl) fileEl.textContent = msg.name;
            } else if (msg.type === 'abort') {
                closeModals();
                showNotification('Transfer Aborted');
                incomingFileData = { metadata: null, chunks: [], receivedSize: 0, startTime: 0, mode: 'P2P' };
            } else if (msg.type === 'eof') {
                finishIncomingTransfer();
            }
            return;
        }

        processIncomingChunk(data);
    } catch (e) { console.error('Incoming data error:', e); }
}

function processIncomingChunk(data) {
    if (!incomingFileData.metadata) return;
    
    incomingFileData.chunks.push(data);
    incomingFileData.receivedSize += data.byteLength || data.length || 0;
    
    const percent = Math.min(100, Math.round((incomingFileData.receivedSize / incomingFileData.metadata.size) * 100));
    const elapsed = (Date.now() - incomingFileData.startTime) / 1000;
    const speed = (incomingFileData.receivedSize / 1024 / 1024 / (elapsed || 0.1)).toFixed(2);
    
    const fillEl = document.getElementById('progress-bar-fill');
    const percentEl = document.getElementById('progress-percent');
    const speedEl = document.getElementById('progress-speed');

    if (fillEl) fillEl.style.width = `${percent}%`;
    if (percentEl) percentEl.textContent = `${percent}%`;
    if (speedEl) speedEl.textContent = `${speed} MB/s`;
}

function finishIncomingTransfer() {
    if (!incomingFileData.metadata) return;

    try {
        const blob = new Blob(incomingFileData.chunks, { type: incomingFileData.metadata.mime || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = incomingFileData.metadata.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
        console.error('Download trigger error:', e);
    }

    setTimeout(() => {
        closeModals();
        showNotification(`File Received (${incomingFileData.mode})`);
        playSound('success');
        if (incomingFileData.metadata) {
            addToHistory(incomingFileData.metadata.name, 'received');
        }
        incomingFileData = { metadata: null, chunks: [], receivedSize: 0, startTime: 0, mode: 'P2P' };
    }, 800);
}

// --- Tier 3 Exposed Window Functions ---
window.openHttpShareInput = function() {
    if (!httpFileInput) httpFileInput = document.getElementById('http-file-input');
    if (httpFileInput) httpFileInput.click();
};

window.copyShareUrl = function() {
    const input = document.getElementById('share-url-input');
    if (input && input.value) {
        navigator.clipboard.writeText(input.value).then(() => {
            showNotification('Download link copied to clipboard!');
        });
    }
};

window.nativeShareUrl = function() {
    if (navigator.share && currentShareUrl) {
        navigator.share({
            title: 'Aether File Share',
            text: 'Download file from Aether:',
            url: currentShareUrl
        }).catch(() => {});
    } else {
        copyShareUrl();
    }
};

// Utilities
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const res = reader.result;
            const base64 = res.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

// History
function addToHistory(name, type) {
    history.unshift({ name, type, time: new Date().toISOString() });
    if (history.length > 15) history.pop();
    try { localStorage.setItem('aether_history', JSON.stringify(history)); } catch (e) {}
    renderHistory();
}

function renderHistory() {
    const list = document.getElementById('history-list');
    if (!list) return;
    
    if (history.length === 0) {
        list.innerHTML = '<p class="text-slate-500 text-xs text-center mt-20 font-bold uppercase tracking-widest italic opacity-50">Transmission History Empty</p>';
        return;
    }

    list.innerHTML = history.map(item => `
        <div class="glass glass-bordered p-6 rounded-2xl border-white/5 group hover:bg-white/5 transition-all">
            <div class="flex justify-between items-start gap-4 mb-2">
                <span class="text-[8px] font-black uppercase tracking-widest ${item.type === 'sent' ? 'text-purple-400' : 'text-cyan-400'}">${item.type}</span>
                <span class="text-[8px] font-black text-slate-600">${new Date(item.time).toLocaleTimeString()}</span>
            </div>
            <p class="text-[10px] font-bold text-white truncate">${item.name}</p>
        </div>
    `).join('');
}

window.toggleHistory = function() {
    const drawer = document.getElementById('history-drawer');
    if (!drawer) return;
    const isOpen = drawer.classList.contains('translate-x-0');
    if (isOpen) {
        drawer.classList.add('translate-x-full');
        drawer.classList.remove('translate-x-0');
    } else {
        renderHistory();
        drawer.classList.remove('translate-x-full');
        drawer.classList.add('translate-x-0');
    }
};

window.toggleDebug = function() {
    const panel = document.getElementById('debug-console');
    if (panel) panel.classList.toggle('hidden');
};

// Quantum Beam Effect
function drawBeam(targetId) {
    const existing = document.getElementById('quantum-beam');
    if (existing) existing.remove();

    const targetEl = document.getElementById(`peer-${targetId}`);
    if (!targetEl) return;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "quantum-beam";
    svg.style.position = "fixed";
    svg.style.inset = "0";
    svg.style.pointerEvents = "none";
    svg.style.zIndex = "10";

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    const rect = targetEl.getBoundingClientRect();
    
    line.setAttribute("x1", window.innerWidth / 2);
    line.setAttribute("y1", window.innerHeight / 2);
    line.setAttribute("x2", rect.left + rect.width / 2);
    line.setAttribute("y2", rect.top + rect.height / 2);
    line.setAttribute("stroke", "rgba(34, 211, 238, 0.4)");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-dasharray", "10, 10");
    line.style.animation = "beam-flow 1s linear infinite";

    svg.appendChild(line);
    document.body.appendChild(svg);
}

const animStyle = document.createElement('style');
animStyle.textContent = `
    @keyframes beam-flow {
        from { stroke-dashoffset: 20; }
        to { stroke-dashoffset: 0; }
    }
`;
document.head.appendChild(animStyle);

window.addEventListener('click', (e) => {
    if (!e.target.closest('.group') && !e.target.closest('.modal')) {
        const beam = document.getElementById('quantum-beam');
        if (beam) beam.remove();
    }
});

// Run Initialization when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initDOMElements();
        setupFileInputListeners();
        createStatusIndicator();
        initSocket();
    });
} else {
    initDOMElements();
    setupFileInputListeners();
    createStatusIndicator();
    initSocket();
}
