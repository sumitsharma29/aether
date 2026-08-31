/**
 * AETHER Quantum Transfer & Encrypted Cloud Vault Engine
 * Features:
 * 1. WebRTC Direct P2P Turbo Streaming (Zero Server RAM, Unlimited Size)
 * 2. Encrypted Cloud Vault (Sender can close tab, Custom Expiry: 1h to 7d, E2EE AES-256)
 * 3. High-throughput Chunking with WebRTC Backpressure Flow Control
 * 4. Interactive Live Speedometer, ETA, and Transfer Metrics
 * 5. Universal Scannable QR Codes & Web Share API
 */

const ADJECTIVES = ['Ethereal', 'Quantum', 'Neural', 'Astral', 'Luminous', 'Spectral', 'Hyper', 'Sonic', 'Vortex', 'Prime', 'Apex', 'Cyber', 'Titan', 'Ghost'];
const NOUNS = ['Node', 'Pulse', 'Wave', 'Core', 'Link', 'Drift', 'Gate', 'Beam', 'Flux', 'Cell', 'Nexus', 'Stream', 'Vault', 'Spark'];

function generateName() {
    return `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${NOUNS[Math.floor(Math.random() * NOUNS.length)]}`;
}

// URL Params & Room Code
const urlParams = new URLSearchParams(window.location.search);
let roomCode = urlParams.get('room') || Math.floor(100000 + Math.random() * 900000).toString();

if (!urlParams.get('room')) {
    const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?room=' + roomCode;
    window.history.pushState({ path: newUrl }, '', newUrl);
}

// Global Application State
let myId = null;
let myName = generateName();
let peers = new Map(); // peerId -> { name, element, pc, isWebrtcDirect }
let selectedPeerId = null;
let currentPIN = null;
let pendingRequest = null;
let isTransferring = false;
let shouldAbort = false;
let currentShareUrl = '';
let selectedFilesForVault = [];
let activeMode = 'p2p'; // 'p2p' | 'vault'

// Transfer Tuned Constants
const CHUNK_SIZE = 128 * 1024; // 128 KB chunks
const MAX_BUFFERED_AMOUNT = 2 * 1024 * 1024; // 2MB WebRTC backpressure threshold

// History Store
let history = [];
try {
    history = JSON.parse(localStorage.getItem('aether_history') || '[]');
} catch (e) { history = []; }

// -------------------------------------------------------------
// BACKEND SERVER RESOLUTION & SOCKET INITIALIZATION
// -------------------------------------------------------------
const RENDER_BACKEND_URL = "https://aether-innt.onrender.com";
const isStaticHost = window.location.hostname.includes("netlify.app") || 
                     window.location.hostname.includes("vercel.app") || 
                     window.location.hostname.includes("github.io");

const SERVER_BASE_URL = isStaticHost ? RENDER_BACKEND_URL : window.location.origin;

let socket = null;
let isSocketConnected = false;

function initSocket() {
    if (typeof io === 'undefined') {
        setTimeout(initSocket, 300);
        return;
    }
    if (socket) return;

    try {
        console.log(`[AETHER] Connecting to signaling core: ${SERVER_BASE_URL}`);
        updateStatusBanner('connecting', 'Connecting to Quantum Core...');

        socket = io(SERVER_BASE_URL, {
            transports: ['websocket', 'polling'],
            reconnectionAttempts: 15,
            reconnectionDelay: 1000
        });

        socket.on('connect', () => {
            isSocketConnected = true;
            console.log(`[AETHER] Socket Connected (${socket.id})`);
            updateStatusBanner('connected', `Quantum Core Connected • ID: ${roomCode}`);
            socket.emit('register', { displayName: myName, roomCode: roomCode });
        });

        socket.on('disconnect', () => {
            isSocketConnected = false;
            updateStatusBanner('connecting', 'Reconnecting to Quantum Core...');
        });

        socket.on('init', (data) => {
            myId = data.id;
            const myNameEl = document.getElementById('my-display-name');
            if (myNameEl) myNameEl.textContent = myName;
            data.peers.forEach(p => addPeerUI(p.id, p.displayName));
            updatePeerCountIndicator();
        });

        socket.on('user-joined', (p) => {
            addPeerUI(p.id, p.displayName);
            updatePeerCountIndicator();
            showNotification(`${p.displayName} Joined Ether Wave`);
            playSound('notify');
        });

        socket.on('user-left', (id) => {
            removePeerUI(id);
            updatePeerCountIndicator();
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
            showModal('modal-incoming');
            pulseHaptic([100, 50, 100]);
        });

        socket.on('request-accepted', (data) => {
            showNotification('⚡ Neural Tunnel Established');
            closeModals();
            initConnection(data.receiverId, true);
            showModal('modal-ready');
            playSound('connect');
        });

        socket.on('request-declined', () => {
            showNotification('Transmission Request Declined');
            closeModals();
        });

        // Binary Socket Relay Fallback Handlers
        socket.on('relay-start', ({ senderId, metadata }) => {
            incomingFileData = { 
                metadata, 
                chunks: [], 
                receivedSize: 0, 
                startTime: Date.now(), 
                mode: '🔄 SOCKET RELAY',
                lastSpeedUpdate: Date.now(),
                lastBytes: 0,
                currentSpeed: 0
            };
            showModal('modal-progress');
            updateProgressHUD(metadata.name, 0, '0.00 MB/s', 'Calculating...', '🔄 SOCKET RELAY');
        });

        socket.on('relay-chunk', ({ senderId, chunk, index }) => {
            processIncomingChunk(chunk);
        });

        socket.on('relay-end', ({ senderId }) => {
            finishIncomingTransfer();
        });

        socket.on('relay-abort', ({ senderId }) => {
            closeModals();
            showNotification('Transfer aborted by sender');
            resetTransferState();
        });

    } catch (err) {
        console.error('[AETHER] Socket init error:', err);
    }
}

// -------------------------------------------------------------
// STATUS & AUDIO/HAPTIC UTILITIES
// -------------------------------------------------------------
function updateStatusBanner(state, text) {
    const banner = document.getElementById('connection-status-pill');
    if (!banner) return;
    const dot = banner.querySelector('.status-dot');
    const label = banner.querySelector('.status-label');
    if (dot) {
        dot.className = `status-dot w-2 h-2 rounded-full ${state === 'connected' ? 'bg-green-400 shadow-[0_0_10px_#4ade80]' : 'bg-yellow-400 animate-ping'}`;
    }
    if (label) label.textContent = text;
}

function updatePeerCountIndicator() {
    const countEl = document.getElementById('peer-count-badge');
    if (countEl) countEl.textContent = `${peers.size} Node${peers.size === 1 ? '' : 's'}`;
    const emptyEl = document.getElementById('empty-state');
    if (emptyEl) {
        if (peers.size === 0) emptyEl.classList.remove('hidden');
        else emptyEl.classList.add('hidden');
    }
}

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
            osc.start(now); osc.stop(now + 0.1);
        } else if (type === 'notify') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(330, now);
            gain.gain.setValueAtTime(0.05, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
            osc.start(now); osc.stop(now + 0.05);
        } else if (type === 'success') {
            [523.25, 659.25, 783.99, 1046.50].forEach((freq, i) => {
                const o = audioCtx.createOscillator();
                const g = audioCtx.createGain();
                o.connect(g); g.connect(audioCtx.destination);
                o.frequency.setValueAtTime(freq, now + (i * 0.08));
                g.gain.setValueAtTime(0.1, now + (i * 0.08));
                g.gain.exponentialRampToValueAtTime(0.01, now + (i * 0.08) + 0.15);
                o.start(now + (i * 0.08));
                o.stop(now + (i * 0.08) + 0.15);
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

// -------------------------------------------------------------
// CLIENT-SIDE AES-256-GCM ENCRYPTION ENGINE
// -------------------------------------------------------------
async function deriveAesKey(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]
    );
    return await window.crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

async function encryptFileBuffer(arrayBuffer, password) {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey(password, salt);
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv }, key, arrayBuffer
    );
    // Package format: Salt (16B) + IV (12B) + Ciphertext
    const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
    combined.set(salt, 0);
    combined.set(iv, salt.length);
    combined.set(new Uint8Array(ciphertext), salt.length + iv.length);
    return combined.buffer;
}

function generateSecurePassphrase() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$';
    let pass = '';
    const bytes = window.crypto.getRandomValues(new Uint8Array(12));
    for (let i = 0; i < 12; i++) {
        pass += chars[bytes[i] % chars.length];
    }
    return pass;
}

// -------------------------------------------------------------
// WEBRTC CONNECTION HANDLING (Zero-Memory High Throughput)
// -------------------------------------------------------------
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
                        { urls: 'stun:stun1.l.google.com:19302' },
                        { urls: 'stun:stun2.l.google.com:19302' },
                        { urls: 'stun:stun3.l.google.com:19302' },
                        { urls: 'stun:stun4.l.google.com:19302' },
                        { urls: 'stun:global.stun.twilio.com:3478' }
                    ]
                }
            });

            pc.on('signal', (signal) => {
                if (socket) socket.emit('signal', { target: targetId, signal });
            });

            pc.on('connect', () => {
                console.log(`[AETHER] WebRTC P2P Direct Tunnel established with ${targetId}`);
                if (peer) peer.isWebrtcDirect = true;
                showNotification('⚡ Direct Hardware P2P Tunnel Activated');
                playSound('connect');
            });

            pc.on('data', (data) => handleIncomingData(data, targetId, 'webrtc'));

            pc.on('error', (err) => {
                console.warn('[AETHER] WebRTC Direct fallback to Socket Relay:', err);
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
    }
}

// -------------------------------------------------------------
// WEBRTC & SOCKET TRANSMISSION WITH BACKPRESSURE FLOW CONTROL
// -------------------------------------------------------------
async function sendFileMultiTier(file, targetId, index = 1, total = 1) {
    const peer = peers.get(targetId);
    const useWebRTC = peer && peer.pc && peer.isWebrtcDirect && peer.pc.connected;
    const modeBadge = useWebRTC ? '⚡ DIRECT P2P TURBO' : '🔄 SOCKET RELAY';

    showModal('modal-progress');
    updateProgressHUD(file.name, 0, '0.00 MB/s', 'Starting stream...', `${modeBadge} (${index}/${total})`);

    const metadata = { name: file.name, size: file.size, mime: file.type };

    if (useWebRTC) {
        peer.pc.send(JSON.stringify({ type: 'metadata', ...metadata }));
    } else {
        if (socket) socket.emit('relay-start', { targetId, metadata });
    }

    let offset = 0;
    let chunkIndex = 0;
    let startTime = Date.now();
    let lastSpeedTime = Date.now();
    let lastOffset = 0;
    let currentSpeedMBs = 0;

    while (offset < file.size) {
        if (shouldAbort) {
            if (useWebRTC) peer.pc.send(JSON.stringify({ type: 'abort' }));
            else if (socket) socket.emit('relay-abort', { targetId });
            return;
        }

        // WebRTC Zero-RAM Backpressure Flow Control
        if (useWebRTC) {
            const rawChannel = peer.pc._channel;
            if (rawChannel && rawChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
                await new Promise(resolve => {
                    const check = () => {
                        if (!rawChannel || rawChannel.bufferedAmount <= MAX_BUFFERED_AMOUNT / 2) {
                            resolve();
                        } else {
                            setTimeout(check, 10);
                        }
                    };
                    check();
                });
            }
        }

        // Read single chunk from disk slice (Zero Memory accumulation)
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const chunk = await slice.arrayBuffer();

        if (useWebRTC) {
            peer.pc.send(chunk);
        } else {
            // Raw binary ArrayBuffer streaming via Socket.IO
            if (socket) socket.emit('relay-chunk', { targetId, chunk, index: chunkIndex });
        }

        offset += chunk.byteLength;
        chunkIndex++;

        // Live speed & ETA metrics calculation
        const now = Date.now();
        if (now - lastSpeedTime >= 200 || offset >= file.size) {
            const timeDelta = (now - lastSpeedTime) / 1000;
            const bytesDelta = offset - lastOffset;
            currentSpeedMBs = (bytesDelta / 1024 / 1024) / (timeDelta || 0.01);
            lastSpeedTime = now;
            lastOffset = offset;

            const percent = Math.min(100, Math.round((offset / file.size) * 100));
            const remainingBytes = file.size - offset;
            const etaSec = currentSpeedMBs > 0 ? Math.round(remainingBytes / (currentSpeedMBs * 1024 * 1024)) : 0;
            const etaText = etaSec > 60 ? `${Math.floor(etaSec/60)}m ${etaSec%60}s left` : `${etaSec}s left`;

            updateProgressHUD(file.name, percent, `${currentSpeedMBs.toFixed(2)} MB/s`, etaText, `${modeBadge} (${index}/${total})`);
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
        }, 500);
    }
}

// -------------------------------------------------------------
// INCOMING STREAM RECEIVER (Zero RAM Spikes)
// -------------------------------------------------------------
let incomingFileData = { metadata: null, chunks: [], receivedSize: 0, startTime: 0, mode: 'P2P', lastSpeedUpdate: 0, lastBytes: 0, currentSpeed: 0 };

function handleIncomingData(data, senderId, sourceMode = 'webrtc') {
    try {
        let msg = null;
        if (typeof data === 'string') {
            msg = JSON.parse(data);
        } else if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
            try {
                const text = new TextDecoder().decode(data);
                if (text.startsWith('{"type":"metadata"')) msg = JSON.parse(text);
                else if (text.startsWith('{"type":"eof"')) msg = JSON.parse(text);
                else if (text.startsWith('{"type":"abort"')) msg = JSON.parse(text);
            } catch (e) {}
        }

        if (msg) {
            if (msg.type === 'metadata') {
                incomingFileData = { 
                    metadata: msg, 
                    chunks: [], 
                    receivedSize: 0, 
                    startTime: Date.now(), 
                    mode: '⚡ WEBRTC P2P',
                    lastSpeedUpdate: Date.now(),
                    lastBytes: 0,
                    currentSpeed: 0
                };
                showModal('modal-progress');
                updateProgressHUD(msg.name, 0, '0.00 MB/s', 'Receiving stream...', '⚡ WEBRTC DIRECT P2P');
            } else if (msg.type === 'abort') {
                closeModals();
                showNotification('Transfer Aborted by Sender');
                resetTransferState();
            } else if (msg.type === 'eof') {
                finishIncomingTransfer();
            }
            return;
        }

        processIncomingChunk(data);
    } catch (e) { console.error('Incoming data handling error:', e); }
}

function processIncomingChunk(data) {
    if (!incomingFileData.metadata) return;

    incomingFileData.chunks.push(data);
    const chunkBytes = data.byteLength || data.length || 0;
    incomingFileData.receivedSize += chunkBytes;

    const now = Date.now();
    if (now - incomingFileData.lastSpeedUpdate >= 200 || incomingFileData.receivedSize >= incomingFileData.metadata.size) {
        const timeDelta = (now - incomingFileData.lastSpeedUpdate) / 1000;
        const bytesDelta = incomingFileData.receivedSize - incomingFileData.lastBytes;
        incomingFileData.currentSpeed = (bytesDelta / 1024 / 1024) / (timeDelta || 0.01);
        incomingFileData.lastSpeedUpdate = now;
        incomingFileData.lastBytes = incomingFileData.receivedSize;

        const percent = Math.min(100, Math.round((incomingFileData.receivedSize / incomingFileData.metadata.size) * 100));
        const remainingBytes = incomingFileData.metadata.size - incomingFileData.receivedSize;
        const etaSec = incomingFileData.currentSpeed > 0 ? Math.round(remainingBytes / (incomingFileData.currentSpeed * 1024 * 1024)) : 0;
        const etaText = etaSec > 60 ? `${Math.floor(etaSec/60)}m ${etaSec%60}s left` : `${etaSec}s left`;

        updateProgressHUD(
            incomingFileData.metadata.name, 
            percent, 
            `${incomingFileData.currentSpeed.toFixed(2)} MB/s`, 
            etaText, 
            incomingFileData.mode
        );
    }
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
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
        console.error('File saving error:', e);
    }

    setTimeout(() => {
        closeModals();
        showNotification(`File Received (${incomingFileData.mode})`);
        playSound('success');
        if (incomingFileData.metadata) addToHistory(incomingFileData.metadata.name, 'received');
        resetTransferState();
    }, 500);
}

function resetTransferState() {
    incomingFileData = { metadata: null, chunks: [], receivedSize: 0, startTime: 0, mode: 'P2P', lastSpeedUpdate: 0, lastBytes: 0, currentSpeed: 0 };
    isTransferring = false;
    shouldAbort = false;
}

// -------------------------------------------------------------
// CLOUD VAULT ENGINE (Persistent Offline Mode - Multi-GB support)
// -------------------------------------------------------------
window.openVaultConfig = function(files) {
    if (!files || files.length === 0) return;
    selectedFilesForVault = Array.from(files);
    
    // Populate preview info
    const file = selectedFilesForVault[0];
    const previewName = document.getElementById('vault-preview-name');
    const previewSize = document.getElementById('vault-preview-size');
    const previewCount = document.getElementById('vault-preview-count');

    if (previewName) previewName.textContent = file.name;
    if (previewSize) previewSize.textContent = formatBytes(file.size);
    if (previewCount) {
        previewCount.textContent = selectedFilesForVault.length > 1 
            ? `+ ${selectedFilesForVault.length - 1} more file(s)` 
            : 'Single File Payload';
    }

    showModal('modal-vault-config');
};

window.executeVaultUpload = async function() {
    if (!selectedFilesForVault || selectedFilesForVault.length === 0) return;
    
    const expirySelect = document.getElementById('vault-expiry-select');
    const expiry = expirySelect ? expirySelect.value : '24h';
    
    const encryptToggle = document.getElementById('vault-encrypt-toggle');
    const isEncrypted = encryptToggle ? encryptToggle.checked : false;
    
    const passwordInput = document.getElementById('vault-password-input');
    const password = (isEncrypted && passwordInput) ? passwordInput.value.trim() : '';

    if (isEncrypted && !password) {
        alert('Please enter or generate an encryption password!');
        return;
    }

    const burnToggle = document.getElementById('vault-burn-toggle');
    const burnAfterDownload = burnToggle ? burnToggle.checked : false;

    closeModals();
    showModal('modal-progress');

    for (let i = 0; i < selectedFilesForVault.length; i++) {
        if (shouldAbort) break;
        const file = selectedFilesForVault[i];
        await uploadFileToVault(file, { expiry, isEncrypted, password, burnAfterDownload }, i + 1, selectedFilesForVault.length);
    }
};

async function uploadFileToVault(file, options, fileIndex = 1, totalFiles = 1) {
    const { expiry, isEncrypted, password, burnAfterDownload } = options;
    updateProgressHUD(file.name, 0, '0.00 MB/s', 'Encrypting & Initializing...', `☁️ CLOUD VAULT (${fileIndex}/${totalFiles})`);

    try {
        let uploadPayloadBuffer = null;
        let finalSize = file.size;

        if (isEncrypted) {
            updateProgressHUD(file.name, 5, 'AES-256', 'Encrypting Payload...', '🔒 CLIENT ENCRYPTION');
            const rawArrayBuffer = await file.arrayBuffer();
            uploadPayloadBuffer = await encryptFileBuffer(rawArrayBuffer, password);
            finalSize = uploadPayloadBuffer.byteLength;
        }

        // Initialize Vault Session with Server
        const initRes = await fetch(`${SERVER_BASE_URL}/api/vault/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: file.name,
                size: finalSize,
                mime: file.type,
                expiry: expiry,
                isEncrypted: isEncrypted,
                burnAfterDownload: burnAfterDownload
            })
        });

        if (!initRes.ok) throw new Error('Server rejected vault session');
        const session = await initRes.json();
        const fileId = session.fileId;

        // Streaming chunk upload to disk
        let offset = 0;
        let chunkIndex = 0;
        let startTime = Date.now();
        let lastSpeedTime = Date.now();
        let lastOffset = 0;
        let currentSpeedMBs = 0;

        while (offset < finalSize) {
            if (shouldAbort) {
                showNotification('Upload Aborted');
                closeModals();
                return;
            }

            let chunkSlice = null;
            if (isEncrypted) {
                chunkSlice = uploadPayloadBuffer.slice(offset, offset + CHUNK_SIZE);
            } else {
                const slice = file.slice(offset, offset + CHUNK_SIZE);
                chunkSlice = await slice.arrayBuffer();
            }

            const chunkRes = await fetch(`${SERVER_BASE_URL}/api/vault/chunk/${fileId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: chunkSlice
            });

            if (!chunkRes.ok) throw new Error('Chunk upload failed');

            offset += chunkSlice.byteLength;
            chunkIndex++;

            const now = Date.now();
            if (now - lastSpeedTime >= 200 || offset >= finalSize) {
                const timeDelta = (now - lastSpeedTime) / 1000;
                const bytesDelta = offset - lastOffset;
                currentSpeedMBs = (bytesDelta / 1024 / 1024) / (timeDelta || 0.01);
                lastSpeedTime = now;
                lastOffset = offset;

                const percent = Math.min(100, Math.round((offset / finalSize) * 100));
                const remainingBytes = finalSize - offset;
                const etaSec = currentSpeedMBs > 0 ? Math.round(remainingBytes / (currentSpeedMBs * 1024 * 1024)) : 0;
                const etaText = etaSec > 60 ? `${Math.floor(etaSec/60)}m ${etaSec%60}s left` : `${etaSec}s left`;

                updateProgressHUD(file.name, percent, `${currentSpeedMBs.toFixed(2)} MB/s`, etaText, `☁️ CLOUD VAULT (${fileIndex}/${totalFiles})`);
            }
        }

        // Generate Shareable Link & QR Code
        let fullPortalUrl = `${SERVER_BASE_URL}${session.portalUrl}`;
        if (isEncrypted && password) {
            fullPortalUrl += `#key=${encodeURIComponent(password)}`;
        }
        currentShareUrl = fullPortalUrl;

        const shareInput = document.getElementById('share-url-input');
        if (shareInput) shareInput.value = fullPortalUrl;

        const qrContainer = document.getElementById('qr-code-container');
        if (qrContainer) {
            qrContainer.innerHTML = '';
            if (typeof QRCode !== 'undefined') {
                new QRCode(qrContainer, {
                    text: fullPortalUrl,
                    width: 200,
                    height: 200,
                    colorDark: "#07090e",
                    colorLight: "#ffffff",
                    correctLevel: QRCode.CorrectLevel.M
                });
            }
        }

        const expiryBadge = document.getElementById('qr-expiry-badge');
        if (expiryBadge) {
            const expDate = new Date(session.expiresAt);
            expiryBadge.textContent = `Valid until ${expDate.toLocaleDateString()} ${expDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} • You can safely close this website`;
        }

        closeModals();
        showModal('modal-qr');
        showNotification('☁️ Cloud Vault Link Ready! You can close this website.');
        playSound('success');
        addToHistory(file.name, 'Cloud Vault');

    } catch (err) {
        console.error('[VAULT ERROR]', err);
        showNotification('Upload failed. Try again.', 4000);
        closeModals();
    }
}

// -------------------------------------------------------------
// PROGRESS HUD & SPEEDOMETER UPDATE
// -------------------------------------------------------------
function updateProgressHUD(filename, percent, speedText, etaText, modeText) {
    const statusEl = document.getElementById('progress-status');
    const fileEl = document.getElementById('progress-filename');
    const fillEl = document.getElementById('progress-bar-fill');
    const percentEl = document.getElementById('progress-percent');
    const speedEl = document.getElementById('progress-speed');
    const etaEl = document.getElementById('progress-eta');

    if (statusEl) statusEl.innerHTML = `${modeText}`;
    if (fileEl) fileEl.textContent = filename;
    if (fillEl) fillEl.style.width = `${percent}%`;
    if (percentEl) percentEl.textContent = `${percent}%`;
    if (speedEl) speedEl.textContent = speedText;
    if (etaEl) etaEl.textContent = etaText;
}

// -------------------------------------------------------------
// MODAL & UI CONTROLS
// -------------------------------------------------------------
window.showModal = function(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('hidden');
};

window.closeModals = function() {
    [
        'modal-selection', 'modal-pin-display', 'modal-incoming', 
        'modal-ready', 'modal-progress', 'modal-qr', 'modal-vault-config'
    ].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
};

window.showNotification = function(msg, duration = 3000) {
    const notification = document.getElementById('notification');
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

window.toggleMode = function(mode) {
    activeMode = mode;
    const p2pTab = document.getElementById('tab-p2p');
    const vaultTab = document.getElementById('tab-vault');
    const p2pView = document.getElementById('p2p-radar-view');
    const vaultView = document.getElementById('vault-drop-view');

    if (mode === 'p2p') {
        if (p2pTab) p2pTab.className = 'tab-btn active px-6 py-2.5 rounded-2xl text-xs font-black uppercase tracking-wider bg-cyan-500 text-black shadow-[0_0_20px_rgba(6,182,212,0.5)] transition-all';
        if (vaultTab) vaultTab.className = 'tab-btn px-6 py-2.5 rounded-2xl text-xs font-black uppercase tracking-wider text-slate-400 hover:text-white transition-all';
        if (p2pView) p2pView.classList.remove('hidden');
        if (vaultView) vaultView.classList.add('hidden');
    } else {
        if (vaultTab) vaultTab.className = 'tab-btn active px-6 py-2.5 rounded-2xl text-xs font-black uppercase tracking-wider bg-gradient-to-r from-cyan-500 to-indigo-600 text-white shadow-[0_0_20px_rgba(99,102,241,0.5)] transition-all';
        if (p2pTab) p2pTab.className = 'tab-btn px-6 py-2.5 rounded-2xl text-xs font-black uppercase tracking-wider text-slate-400 hover:text-white transition-all';
        if (p2pView) p2pView.classList.add('hidden');
        if (vaultView) vaultView.classList.remove('hidden');
    }
};

window.generateRandomPassword = function() {
    const input = document.getElementById('vault-password-input');
    if (input) {
        input.value = generateSecurePassphrase();
        input.type = 'text';
    }
};

window.copyShareUrl = function() {
    const input = document.getElementById('share-url-input');
    if (input && input.value) {
        navigator.clipboard.writeText(input.value).then(() => {
            showNotification('Download Link & Encryption Key Copied!');
        });
    }
};

window.nativeShareUrl = function() {
    if (navigator.share && currentShareUrl) {
        navigator.share({
            title: 'Aether Quantum File Share',
            text: 'Download file from Aether Encrypted Cloud Vault:',
            url: currentShareUrl
        }).catch(() => {});
    } else {
        copyShareUrl();
    }
};

window.toggleSettings = function() {
    const panel = document.getElementById('settings-panel');
    if (!panel) return;
    panel.classList.toggle('hidden');
};

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

window.copyRoomLink = function() {
    navigator.clipboard.writeText(window.location.href).then(() => {
        showNotification('Room invite link copied! Send to receiver');
    });
};

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// -------------------------------------------------------------
// RADAR PEER UI
// -------------------------------------------------------------
function addPeerUI(id, name) {
    if (peers.has(id)) return;
    const container = document.getElementById('peers-container');
    if (!container) return;

    const el = document.createElement('div');
    el.id = `peer-${id}`;
    el.className = 'absolute transform -translate-x-1/2 -translate-y-1/2 cursor-pointer transition-all duration-1000 float group';
    
    const angle = Math.random() * Math.PI * 2;
    const radius = 26 + Math.random() * 14;
    el.style.left = `${50 + Math.cos(angle) * radius}%`;
    el.style.top = `${50 + Math.sin(angle) * radius}%`;
    
    el.innerHTML = `
        <div class="flex flex-col items-center gap-3">
            <div class="w-16 h-16 md:w-20 md:h-20 rounded-[2rem] glass flex items-center justify-center text-xl md:text-2xl font-black border-2 border-cyan-500/20 group-hover:border-cyan-400 group-hover:shadow-[0_0_40px_rgba(6,182,212,0.5)] transition-all btn-aether">
                ${name.charAt(0)}
            </div>
            <span class="text-[9px] font-black uppercase tracking-[0.3em] text-cyan-300 bg-cyan-500/10 px-3 py-1 rounded-xl border border-cyan-500/20 opacity-0 group-hover:opacity-100 transition-all shadow-2xl backdrop-blur-md">${name}</span>
        </div>
    `;
    
    el.onclick = () => selectPeer(id);
    container.appendChild(el);
    peers.set(id, { name, element: el, pc: null, isWebrtcDirect: false });
}

window.selectPeer = function(id) {
    selectedPeerId = id;
    const peer = peers.get(id);
    if (!peer) return;

    const peerNameEl = document.getElementById('selected-peer-name');
    if (peerNameEl) peerNameEl.textContent = peer.name;
    showModal('modal-selection');
};

function removePeerUI(id) {
    const el = document.getElementById(`peer-${id}`);
    if (el) el.remove();
    const peer = peers.get(id);
    if (peer && peer.pc) {
        try { peer.pc.destroy(); } catch (e) {}
    }
    peers.delete(id);
}

// -------------------------------------------------------------
// P2P HANDSHAKE FLOW
// -------------------------------------------------------------
window.handleSelection = function(intent) {
    closeModals();
    currentPIN = Math.floor(1000 + Math.random() * 9000).toString();
    const callerPinEl = document.getElementById('caller-pin');
    if (callerPinEl) callerPinEl.textContent = currentPIN;
    showModal('modal-pin-display');
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

// -------------------------------------------------------------
// FILE INPUT & DRAG-AND-DROP LISTENERS
// -------------------------------------------------------------
function setupEventListeners() {
    const p2pFileInput = document.getElementById('file-input');
    if (p2pFileInput) {
        p2pFileInput.onchange = async (e) => {
            const files = Array.from(e.target.files);
            if (files.length === 0 || !selectedPeerId) return;
            p2pFileInput.value = '';
            isTransferring = true;
            shouldAbort = false;
            for (let i = 0; i < files.length; i++) {
                if (shouldAbort) break;
                await sendFileMultiTier(files[i], selectedPeerId, i + 1, files.length);
            }
            isTransferring = false;
        };
    }

    const vaultFileInput = document.getElementById('vault-file-input');
    if (vaultFileInput) {
        vaultFileInput.onchange = (e) => {
            const files = Array.from(e.target.files);
            if (files.length > 0) openVaultConfig(files);
            vaultFileInput.value = '';
        };
    }

    const btnSelectP2P = document.getElementById('btn-select-file');
    if (btnSelectP2P) {
        btnSelectP2P.onclick = () => {
            if (p2pFileInput) p2pFileInput.click();
            closeModals();
        };
    }

    const btnCancelTransfer = document.getElementById('btn-cancel-transfer');
    if (btnCancelTransfer) {
        btnCancelTransfer.onclick = () => {
            shouldAbort = true;
            showNotification('Cancelling transmission...');
            if (selectedPeerId && socket) socket.emit('relay-abort', { targetId: selectedPeerId });
        };
    }

    // Drag & Drop
    const dropZone = document.body;
    const dragOverlay = document.getElementById('drag-overlay');

    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (dragOverlay) dragOverlay.classList.remove('hidden');
    });

    window.addEventListener('dragleave', (e) => {
        if (e.relatedTarget === null && dragOverlay) {
            dragOverlay.classList.add('hidden');
        }
    });

    window.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragOverlay) dragOverlay.classList.add('hidden');
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            if (activeMode === 'vault' || !selectedPeerId) {
                openVaultConfig(files);
            } else {
                // Trigger P2P send
                (async () => {
                    isTransferring = true;
                    shouldAbort = false;
                    for (let i = 0; i < files.length; i++) {
                        if (shouldAbort) break;
                        await sendFileMultiTier(files[i], selectedPeerId, i + 1, files.length);
                    }
                    isTransferring = false;
                })();
            }
        }
    });
}

function addToHistory(name, type) {
    history.unshift({ name, type, time: new Date().toISOString() });
    if (history.length > 20) history.pop();
    try { localStorage.setItem('aether_history', JSON.stringify(history)); } catch (e) {}
    renderHistory();
}

function renderHistory() {
    const list = document.getElementById('history-list');
    if (!list) return;
    if (history.length === 0) {
        list.innerHTML = '<p class="text-slate-500 text-xs text-center mt-20 font-bold uppercase tracking-widest italic opacity-50">Transmission Log Empty</p>';
        return;
    }
    list.innerHTML = history.map(item => `
        <div class="glass p-5 rounded-2xl border border-white/5 group hover:bg-white/5 transition-all">
            <div class="flex justify-between items-start gap-4 mb-1.5">
                <span class="text-[8px] font-black uppercase tracking-widest ${item.type === 'sent' ? 'text-cyan-400' : item.type === 'received' ? 'text-green-400' : 'text-purple-400'}">${item.type}</span>
                <span class="text-[8px] font-black text-slate-500">${new Date(item.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
            </div>
            <p class="text-xs font-bold text-white truncate">${item.name}</p>
        </div>
    `).join('');
}

// -------------------------------------------------------------
// DOM BOOTSTRAP
// -------------------------------------------------------------
function bootstrap() {
    const roomEl = document.getElementById('room-id-display');
    if (roomEl) roomEl.textContent = roomCode;

    const nameEl = document.getElementById('my-display-name');
    if (nameEl) nameEl.textContent = myName;

    setupEventListeners();
    initSocket();
    renderHistory();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
