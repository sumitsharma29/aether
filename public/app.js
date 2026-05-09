// 1. IMPORTANT: Update this to your ACTUAL Render backend URL
const RENDER_URL = "https://aether-innt.onrender.com"; 

// Smart Discovery Logic
const isLocal = window.location.hostname === "localhost" || 
                window.location.hostname === "127.0.0.1" || 
                window.location.hostname.startsWith("192.168.") || 
                window.location.hostname.startsWith("10.") || 
                window.location.hostname.startsWith("172.");

const isProduction = !isLocal;
const socket = isLocal 
    ? io(window.location.origin, { transports: ['websocket', 'polling'] }) 
    : io(RENDER_URL, { 
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 20,
        timeout: 45000,
        forceNew: true 
    });

// Connection Health Check
const statusIndicator = document.createElement('div');
statusIndicator.className = 'fixed bottom-4 right-4 z-[200] px-4 py-2 rounded-full text-[9px] font-black uppercase tracking-widest glass border border-white/5 flex items-center gap-2';
statusIndicator.innerHTML = '<span class="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></span> <span>Connecting...</span>';
document.body.appendChild(statusIndicator);

function updateStatus(peersCount) {
    const color = peersCount > 0 ? 'bg-green-500' : 'bg-cyan-500';
    statusIndicator.innerHTML = `<span class="w-2 h-2 rounded-full ${color}"></span> <span>Online • Peers: ${peersCount}</span>`;
}





// Configuration
const CHUNK_SIZE = 128 * 1024; // Increased to 128KB for pro performance
let fileWriter = null;
let fileHandle = null;


// State
let myId = null;
let myName = `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${NOUNS[Math.floor(Math.random() * NOUNS.length)]}`;
const peers = new Map();
let selectedPeerId = null;
let currentPIN = null;
let pendingRequest = null;
let isTransferring = false;
let shouldAbort = false;
let history = JSON.parse(localStorage.getItem('aether_history') || '[]');


// Room ID logic
const urlParams = new URLSearchParams(window.location.search);
let roomCode = urlParams.get('room') || Math.floor(100000 + Math.random() * 900000).toString();
// Update URL without reloading to show the room code
if (!urlParams.get('room')) {
    const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?room=' + roomCode;
    window.history.pushState({ path: newUrl }, '', newUrl);
}

// DOM Elements
const myDisplayName = document.getElementById('my-display-name');
const peersContainer = document.getElementById('peers-container');
const emptyState = document.getElementById('empty-state');
const fileInput = document.getElementById('file-input');
const notification = document.getElementById('notification');
const dragOverlay = document.getElementById('drag-overlay');
const settingsPanel = document.getElementById('settings-panel');

// Modals
const modalSelection = document.getElementById('modal-selection');
const modalPinDisplay = document.getElementById('modal-pin-display');
const modalIncoming = document.getElementById('modal-incoming');
const modalReady = document.getElementById('modal-ready');
const modalProgress = document.getElementById('modal-progress');
const btnSelectFile = document.getElementById('btn-select-file');

// Initialize UI
myDisplayName.textContent = myName;
document.getElementById('room-id-display').textContent = roomCode;

function copyRoomLink() {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
        showNotification('Link copied! Send to Phone B');
    });
}

// --- Premium Interaction Engine (Audio & Haptics) ---

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playSound(type) {
    if (!document.getElementById('setting-sound').checked) return;
    
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
        osc.type = 'sine';
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
}

function pulseHaptic(pattern = 10) {
    if (document.getElementById('setting-haptic').checked && navigator.vibrate) {
        navigator.vibrate(pattern);
    }
}

// --- UI Helpers ---

function showNotification(msg, duration = 3000) {
    const span = notification.querySelector('span');
    if (span) span.textContent = msg;
    notification.classList.remove('translate-y-40', 'opacity-0');
    playSound('notify');
    pulseHaptic(20);
    setTimeout(() => {
        notification.classList.add('translate-y-40', 'opacity-0');
    }, duration);
}

function showModal(modal) {
    modal.classList.remove('hidden');
}

function closeModals() {
    [modalSelection, modalPinDisplay, modalIncoming, modalReady, modalProgress].forEach(m => m.classList.add('hidden'));
}

function toggleSettings() {
    const isHidden = settingsPanel.classList.contains('hidden');
    if (isHidden) {
        settingsPanel.classList.remove('hidden');
        setTimeout(() => {
            settingsPanel.classList.remove('scale-90', 'opacity-0');
        }, 10);
    } else {
        settingsPanel.classList.add('scale-90', 'opacity-0');
        setTimeout(() => settingsPanel.classList.add('hidden'), 300);
    }
}

function generatePIN() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

// --- Socket Events ---

socket.on('connect', () => {
    updateStatus(peers.size);
    console.log(`[AETHER] Connected! ID: ${socket.id} | Room: ${roomCode}`);
    socket.emit('register', { 
        displayName: myName,
        roomCode: roomCode 
    });
});

socket.on('init', (data) => {
    myId = data.id;
    console.log(`[AETHER] Initialized. Existing Peers: ${data.peers.length}`);
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


socket.on('init', (data) => {
    myId = data.id;
    data.peers.forEach(p => addPeerUI(p.id, p.displayName));
});

socket.on('user-joined', (p) => {
    addPeerUI(p.id, p.displayName);
    showNotification(`${p.displayName} Detected`);
});

socket.on('user-left', (id) => {
    removePeerUI(id);
});

// --- Peer Management ---

function addPeerUI(id, name) {
    if (peers.has(id)) return;
    emptyState.classList.add('hidden');
    
    const el = document.createElement('div');
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
    peersContainer.appendChild(el);
    peers.set(id, { name, element: el, pc: null });
}

function selectPeer(id) {
    selectedPeerId = id;
    const peer = peers.get(id);
    if (peer && peer.pc && peer.pc.connected) {
        fileInput.click();
    } else {
        document.getElementById('selected-peer-name').textContent = peer.name;
        showModal(modalSelection);
        drawBeam(id);
    }
}

function removePeerUI(id) {
    const el = document.getElementById(`peer-${id}`);
    if (el) el.remove();
    
    // Cleanup visual beam if it belongs to this peer
    const beam = document.getElementById('quantum-beam');
    if (selectedPeerId === id && beam) beam.remove();
    
    peers.delete(id);
    if (peers.size === 0) emptyState.classList.remove('hidden');
}

// --- Handshake ---

function handleSelection(intent) {
    closeModals();
    currentPIN = generatePIN();
    document.getElementById('caller-pin').textContent = currentPIN;
    showModal(modalPinDisplay);
    socket.emit('request-connect', { targetId: selectedPeerId, intent, pin: currentPIN });
}

function cancelRequest() {
    closeModals();
    selectedPeerId = null;
}

socket.on('incoming-request', (data) => {
    pendingRequest = data;
    document.getElementById('incoming-msg').textContent = `${data.senderName} requesting link`;
    document.getElementById('receiver-pin').textContent = data.pin;
    showModal(modalIncoming);
    pulseHaptic([100, 50, 100]);
});

async function acceptRequest() {
    if (!pendingRequest) return;
    
    // Pro Feature: Pre-authorize storage for large files if supported
    if ('showSaveFilePicker' in window && pendingRequest.intent === 'send') {
        try {
            showNotification('Authorize storage for stream...');
        } catch (e) {
            console.warn('Storage API rejected or ignored');
        }
    }

    socket.emit('accept-connect', { senderId: pendingRequest.senderId });
    initWebRTC(pendingRequest.senderId, false);
    closeModals();
}


function declineRequest() {
    if (!pendingRequest) return;
    socket.emit('decline-connect', { senderId: pendingRequest.senderId });
    pendingRequest = null;
    closeModals();
}

socket.on('request-accepted', (data) => {
    showNotification('Aether Tunnel Stable');
    closeModals();
    initWebRTC(data.receiverId, true);
    showModal(modalReady);
    playSound('connect');
});

btnSelectFile.onclick = () => {
    fileInput.click();
    closeModals();
};

socket.on('request-declined', () => {
    showNotification('Link Aborted', 5000);
    closeModals();
});

document.getElementById('btn-cancel-transfer').onclick = () => {
    shouldAbort = true;
    showNotification('Aborting...');
};

// --- WebRTC ---


function initWebRTC(targetId, initiator) {
    const pc = new SimplePeer({
        initiator,
        trickle: true,
        config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
    });

    pc.on('signal', (signal) => socket.emit('signal', { target: targetId, signal }));

    pc.on('connect', () => {
        showNotification('Neural Bridge Established');
        playSound('connect');
    });

    pc.on('data', (data) => handleIncomingData(data, targetId));

    pc.on('error', (err) => {
        console.error('P2P Error:', err);
        removePeerUI(targetId);
        if (isTransferring) {
            shouldAbort = true;
            showNotification('Link Lost');
        }
    });
    pc.on('close', () => {
        removePeerUI(targetId);
        if (isTransferring) {
            shouldAbort = true;
            showNotification('Link Terminated');
        }
    });


    const peer = peers.get(targetId);
    if (peer) peer.pc = pc;
}

socket.on('signal', (data) => {
    const peer = peers.get(data.sender);
    if (peer && peer.pc) peer.pc.signal(data.signal);
});

// --- File Transfer ---

fileInput.onchange = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0 || !selectedPeerId) return;
    
    const peer = peers.get(selectedPeerId);
    if (!peer || !peer.pc) return;

    fileInput.value = ''; // Reset input
    
    isTransferring = true;
    shouldAbort = false;
    
    for (let i = 0; i < files.length; i++) {
        if (shouldAbort) break;
        await sendFile(files[i], peer.pc, i + 1, files.length);
    }
    
    isTransferring = false;
    shouldAbort = false;
};

async function sendFile(file, pc, index = 1, total = 1) {
    showModal(modalProgress);
    document.getElementById('progress-status').textContent = fileWriter ? 'Streaming' : 'RAM Sync';
    document.getElementById('progress-filename').textContent = `[${index}/${total}] ${file.name}`;
    
    // Pro: Show Mode in UI
    const modeIndicator = fileWriter ? 'DIRECT-TO-DISK' : 'RAM-BUFFER';
    document.getElementById('progress-status').innerHTML = `${modeIndicator} <span class="block text-[10px] opacity-50 mt-1">Transmitting File ${index} of ${total}</span>`;

    pc.send(JSON.stringify({ type: 'metadata', name: file.name, size: file.size, mime: file.type }));

    let offset = 0;
    let startTime = Date.now();

    const readChunk = (file, offset) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsArrayBuffer(slice);
        });
    };

    while (offset < file.size) {
        if (shouldAbort) {
            pc.send(JSON.stringify({ type: 'abort' }));
            return;
        }

        if (pc.bufferSize > 4 * 1024 * 1024) {
            await new Promise(r => setTimeout(r, 50));
            continue;
        }

        const chunk = await readChunk(file, offset);
        pc.send(chunk);
        offset += chunk.byteLength;

        const percent = Math.round((offset / file.size) * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = (offset / 1024 / 1024 / (elapsed || 0.1)).toFixed(2);

        document.getElementById('progress-bar-fill').style.width = `${percent}%`;
        document.getElementById('progress-percent').textContent = `${percent}%`;
        document.getElementById('progress-speed').textContent = `${speed} MB/s`;
    }

    pc.send(JSON.stringify({ type: 'eof' }));
    
    if (index === total) {
        setTimeout(() => {
            closeModals();
            showNotification(`Batch Transmission Complete`);
            playSound('success');
            addToHistory(file.name, 'sent');
        }, 1000);
    }
}



let incomingFileData = { metadata: null, chunks: [], receivedSize: 0, startTime: 0 };

async function handleIncomingData(data, senderId) {
    try {
        let msg = null;
        if (typeof data === 'string') {
            msg = JSON.parse(data);
        } else if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
            try {
                const decoded = new TextDecoder().decode(data);
                if (decoded.startsWith('{"type":"metadata"')) msg = JSON.parse(decoded);
                else if (decoded.startsWith('{"type":"eof"')) msg = JSON.parse(decoded);
            } catch (e) {}
        }

        if (msg) {
            if (msg.type === 'metadata') {
                incomingFileData = { metadata: msg, chunks: [], receivedSize: 0, startTime: Date.now() };
                showModal(modalProgress);
                document.getElementById('progress-status').textContent = 'Capturing';
                document.getElementById('progress-filename').textContent = msg.name;

                // Professional: Direct-to-Disk Setup
                if ('showSaveFilePicker' in window && msg.size > 100 * 1024 * 1024) { // Use for files > 100MB
                    try {
                        showNotification('Large file detected: Stream Mode Active');
                        fileHandle = await window.showSaveFilePicker({
                            suggestedName: msg.name,
                        });
                        fileWriter = await fileHandle.createWritable();
                    } catch (e) {
                        console.error('FileSystem Access denied, falling back to RAM mode');
                        fileWriter = null;
                    }
                }
            } else if (msg.type === 'abort') {
                if (fileWriter) {
                    await fileWriter.close();
                    fileWriter = null;
                }
                closeModals();
                showNotification('Transfer Aborted by Sender');
                incomingFileData = { metadata: null, chunks: [], receivedSize: 0, startTime: 0 };
            } else if (msg.type === 'eof') {

                if (fileWriter) {
                    await fileWriter.close();
                    fileWriter = null;
                } else {
                    const blob = new Blob(incomingFileData.chunks, { type: incomingFileData.metadata.mime });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = incomingFileData.metadata.name;
                    a.click();
                }
                
                setTimeout(() => {
                    closeModals();
                    showNotification(`Sync Successful`);
                    playSound('success');
                    addToHistory(incomingFileData.metadata.name, 'received');
                    incomingFileData = { metadata: null, chunks: [], receivedSize: 0, startTime: 0 };
                }, 1000);
            }
            return;
        }

        // Handle raw binary chunks
        if (fileWriter) {
            await fileWriter.write(data);
        } else {
            incomingFileData.chunks.push(data);
        }

        incomingFileData.receivedSize += data.byteLength || data.length || 0;
        const percent = Math.round((incomingFileData.receivedSize / incomingFileData.metadata.size) * 100);
        const elapsed = (Date.now() - incomingFileData.startTime) / 1000;
        const speed = (incomingFileData.receivedSize / 1024 / 1024 / (elapsed || 0.1)).toFixed(2);
        
        document.getElementById('progress-bar-fill').style.width = `${percent}%`;
        document.getElementById('progress-percent').textContent = `${percent}%`;
        document.getElementById('progress-speed').textContent = `${speed} MB/s`;
        
    } catch (e) { 
        console.error('Ether Sync Error:', e);
        showNotification('Sync Interrupted');
    }
}


function addToHistory(name, type) {
    history.unshift({ name, type, time: new Date().toISOString() });
    if (history.length > 15) history.pop();
    localStorage.setItem('aether_history', JSON.stringify(history));
    renderHistory();
}

function renderHistory() {
    const list = document.getElementById('history-list');
    if (!list) return;
    
    if (history.length === 0) {
        list.innerHTML = '<p class="text-slate-500 text-xs text-center mt-20 font-bold uppercase tracking-widest italic opacity-50">Empty Space</p>';
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

function toggleHistory() {
    const drawer = document.getElementById('history-drawer');
    const isOpen = drawer.classList.contains('translate-x-0');
    if (isOpen) {
        drawer.classList.add('translate-x-full');
        drawer.classList.remove('translate-x-0');
    } else {
        renderHistory();
        drawer.classList.remove('translate-x-full');
        drawer.classList.add('translate-x-0');
    }
}


// --- Drag and Drop ---

window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragOverlay.classList.remove('hidden');
});

dragOverlay.addEventListener('dragover', (e) => e.preventDefault());

window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) dragOverlay.classList.add('hidden');
});

window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragOverlay.classList.add('hidden');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        if (peers.size === 1) {
            const [id, peer] = peers.entries().next().value;
            if (peer.pc && peer.pc.connected) {
                sendFile(files[0], peer.pc);
                return;
            }
        }
        showNotification('Select a node to transmit files');
    }
});

// --- Aesthetics & Micro-interactions ---

// Parallax Grid
window.addEventListener('mousemove', (e) => {
    const x = (e.clientX / window.innerWidth - 0.5) * 40;
    const y = (e.clientY / window.innerHeight - 0.5) * 40;
    const grid = document.getElementById('grid-bg');
    if (grid) grid.style.transform = `translate(${x}px, ${y}px)`;
});

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
    line.setAttribute("stroke", "rgba(34, 211, 238, 0.3)");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-dasharray", "10, 10");
    line.style.animation = "beam-flow 1s linear infinite";

    svg.appendChild(line);
    document.body.appendChild(svg);
}

// Add beam flow animation style
const style = document.createElement('style');
style.textContent = `
    @keyframes beam-flow {
        from { stroke-dashoffset: 20; }
        to { stroke-dashoffset: 0; }
    }
`;
document.head.appendChild(style);

// Clear beam on click outside
window.addEventListener('click', (e) => {
    if (!e.target.closest('.group') && !e.target.closest('.modal')) {
        const beam = document.getElementById('quantum-beam');
        if (beam) beam.remove();
    }
});

