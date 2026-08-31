const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);

// Configure Socket.IO with high-speed binary streaming support
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 5e8, // 500 MB buffer for socket streams
    pingTimeout: 30000,
    pingInterval: 10000
});

// Vault storage directory for persistent offline sharing
const VAULT_DIR = path.resolve(__dirname, 'vault_storage');
if (!fs.existsSync(VAULT_DIR)) {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
}

// Enable CORS and optimized headers for all endpoints
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-File-Id, X-File-Name, X-File-Mime, X-Chunk-Index, X-Total-Chunks, X-Expiry, X-Encrypted, X-Burn');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Enable JSON for metadata and raw streams for high-speed file chunk streaming
app.use(express.json({ limit: '100mb' }));
app.use(express.raw({ limit: '500mb', type: ['application/octet-stream', 'application/x-binary', 'binary/octet-stream'] }));

// Static asset caching with Cache-Control headers for ultra-fast load
app.use(express.static(path.resolve(__dirname, 'public'), {
    maxAge: '1d',
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        }
    }
}));

// In-Memory index for Cloud Vault items: fileId -> metadata
// Metadata: { id, name, originalName, mime, size, filePath, createdAt, expiresAt, isEncrypted, burnAfterDownload, downloadsCount, maxDownloads }
const vaultIndex = new Map();

// Helper to load existing vault files into memory index on startup
function initVaultStore() {
    try {
        const metaPath = path.join(VAULT_DIR, '_vault_index.json');
        if (fs.existsSync(metaPath)) {
            const raw = fs.readFileSync(metaPath, 'utf8');
            const list = JSON.parse(raw);
            const now = Date.now();
            list.forEach(item => {
                if (item.expiresAt > now && fs.existsSync(item.filePath)) {
                    vaultIndex.set(item.id, item);
                } else if (fs.existsSync(item.filePath)) {
                    try { fs.unlinkSync(item.filePath); } catch (e) {}
                }
            });
            console.log(`[VAULT] Restored ${vaultIndex.size} active files from storage`);
        }
    } catch (e) {
        console.error('[VAULT] Error loading vault index:', e);
    }
}

function saveVaultIndex() {
    try {
        const metaPath = path.join(VAULT_DIR, '_vault_index.json');
        const list = Array.from(vaultIndex.values());
        fs.writeFileSync(metaPath, JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {
        console.error('[VAULT] Error saving vault index:', e);
    }
}

initVaultStore();

// Automated garbage collection every 30 seconds
setInterval(() => {
    const now = Date.now();
    let modified = false;
    for (const [id, file] of vaultIndex.entries()) {
        if (now > file.expiresAt || (file.maxDownloads && file.downloadsCount >= file.maxDownloads)) {
            try {
                if (fs.existsSync(file.filePath)) {
                    fs.unlinkSync(file.filePath);
                }
            } catch (err) {
                console.error(`[VAULT] Error deleting expired file ${id}:`, err);
            }
            vaultIndex.delete(id);
            modified = true;
            console.log(`[VAULT] Cleaned up expired/downloaded file: ${id} (${file.name})`);
        }
    }
    if (modified) saveVaultIndex();
}, 30000);

// Helper for parsing expiry strings
function calculateExpiryTime(expiryStr) {
    const now = Date.now();
    switch (expiryStr) {
        case '1h': return now + 1 * 3600 * 1000;
        case '6h': return now + 6 * 3600 * 1000;
        case '24h':
        case '1d': return now + 24 * 3600 * 1000;
        case '48h':
        case '2d': return now + 48 * 3600 * 1000;
        case '168h':
        case '7d': return now + 7 * 24 * 3600 * 1000;
        case 'burn': return now + 24 * 3600 * 1000; // 1-day safety max or auto-destruct on 1st download
        default:
            const parsed = parseInt(expiryStr, 10);
            if (!isNaN(parsed) && parsed > 0) {
                return now + parsed * 60 * 1000; // minutes
            }
            return now + 24 * 3600 * 1000; // default 24h
    }
}

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------

app.get('/', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

app.get('/void', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'public', 'void.html'));
});

// Fast Health Check Endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        serverTime: Date.now(),
        appName: 'Aether Quantum Transfer Engine',
        version: '3.0.0',
        activePeers: users.size,
        vaultItems: vaultIndex.size,
        uptime: Math.floor(process.uptime()),
        memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    });
});

// -------------------------------------------------------------
// CLOUD VAULT API (Persistent Offline Mode - Multi-GB support)
// -------------------------------------------------------------

// Initiate a Cloud Vault upload session
app.post('/api/vault/init', (req, res) => {
    try {
        const { name, size, mime, expiry, isEncrypted, burnAfterDownload, maxDownloads } = req.body;
        if (!name || size === undefined) {
            return res.status(400).json({ error: 'Missing file name or size' });
        }

        const fileId = crypto.randomBytes(6).toString('hex'); // 12 char unique ID
        const diskFilename = `${fileId}_${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const filePath = path.join(VAULT_DIR, diskFilename);

        const expiresAt = calculateExpiryTime(expiry || '24h');
        const isBurn = burnAfterDownload === true || expiry === 'burn';

        const fileEntry = {
            id: fileId,
            name: name,
            mime: mime || 'application/octet-stream',
            size: Number(size),
            filePath: filePath,
            createdAt: Date.now(),
            expiresAt: expiresAt,
            isEncrypted: Boolean(isEncrypted),
            burnAfterDownload: isBurn,
            downloadsCount: 0,
            maxDownloads: isBurn ? 1 : (Number(maxDownloads) || 0),
            uploadedBytes: 0,
            complete: false
        };

        // Create empty file on disk
        fs.writeFileSync(filePath, Buffer.alloc(0));
        vaultIndex.set(fileId, fileEntry);
        saveVaultIndex();

        console.log(`[VAULT INIT] Session created: ${fileId} for "${name}" (${(size/1024/1024).toFixed(2)} MB), Expiry: ${new Date(expiresAt).toISOString()}`);

        res.json({
            success: true,
            fileId,
            expiresAt,
            downloadUrl: `/api/vault/download/${fileId}`,
            portalUrl: `/v/${fileId}`
        });
    } catch (err) {
        console.error('[VAULT INIT] Error:', err);
        res.status(500).json({ error: 'Failed to initialize vault session' });
    }
});

// Stream / Append a chunk to a vault file on disk (Zero Node.js RAM accumulation)
app.post('/api/vault/chunk/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    const fileEntry = vaultIndex.get(fileId);

    if (!fileEntry) {
        return res.status(404).json({ error: 'Vault session not found or expired' });
    }

    const chunk = req.body;
    if (!chunk || !Buffer.isBuffer(chunk)) {
        return res.status(400).json({ error: 'Invalid binary chunk body' });
    }

    try {
        fs.appendFileSync(fileEntry.filePath, chunk);
        fileEntry.uploadedBytes += chunk.length;

        if (fileEntry.uploadedBytes >= fileEntry.size) {
            fileEntry.complete = true;
            saveVaultIndex();
            console.log(`[VAULT COMPLETE] File ${fileId} ("${fileEntry.name}") fully saved to disk (${(fileEntry.uploadedBytes/1024/1024).toFixed(2)} MB)`);
        }

        res.json({
            success: true,
            uploadedBytes: fileEntry.uploadedBytes,
            complete: fileEntry.complete
        });
    } catch (err) {
        console.error(`[VAULT CHUNK] Error appending to ${fileId}:`, err);
        res.status(500).json({ error: 'Disk write failed' });
    }
});

// Single-request upload for small-to-medium files (Backward Compatibility)
app.post('/api/upload', (req, res) => {
    try {
        const { name, mime, data, expiry, isEncrypted, burnAfterDownload } = req.body;
        if (!name || !data) {
            return res.status(400).json({ error: 'Invalid file data' });
        }

        const fileId = crypto.randomBytes(6).toString('hex');
        const buffer = Buffer.from(data, 'base64');
        const diskFilename = `${fileId}_${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const filePath = path.join(VAULT_DIR, diskFilename);

        fs.writeFileSync(filePath, buffer);

        const expiresAt = calculateExpiryTime(expiry || '24h');
        const isBurn = burnAfterDownload === true || expiry === 'burn';

        const fileEntry = {
            id: fileId,
            name: name,
            mime: mime || 'application/octet-stream',
            size: buffer.length,
            filePath: filePath,
            createdAt: Date.now(),
            expiresAt: expiresAt,
            isEncrypted: Boolean(isEncrypted),
            burnAfterDownload: isBurn,
            downloadsCount: 0,
            maxDownloads: isBurn ? 1 : 0,
            uploadedBytes: buffer.length,
            complete: true
        };

        vaultIndex.set(fileId, fileEntry);
        saveVaultIndex();

        console.log(`[HTTP UPLOAD] File saved: ${name} (${buffer.length} bytes), ID: ${fileId}`);
        res.json({
            success: true,
            fileId,
            name,
            size: buffer.length,
            downloadUrl: `/api/vault/download/${fileId}`,
            portalUrl: `/v/${fileId}`,
            expiresAt
        });
    } catch (err) {
        console.error('[HTTP UPLOAD] Error:', err);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Get File Metadata for Receiver
app.get('/api/vault/info/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    const file = vaultIndex.get(fileId);

    if (!file || !fs.existsSync(file.filePath)) {
        return res.status(404).json({ error: 'File expired or not found' });
    }

    res.json({
        id: file.id,
        name: file.name,
        size: file.size,
        mime: file.mime,
        createdAt: file.createdAt,
        expiresAt: file.expiresAt,
        isEncrypted: file.isEncrypted,
        burnAfterDownload: file.burnAfterDownload,
        downloadsCount: file.downloadsCount,
        maxDownloads: file.maxDownloads
    });
});

// High-Speed Streaming Download with Range support & Zero Memory Buffer
app.get('/api/vault/download/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    const file = vaultIndex.get(fileId);

    if (!file || !fs.existsSync(file.filePath)) {
        return res.status(404).send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <title>AETHER | Link Expired</title>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body { background: #07090e; color: #f8fafc; font-family: 'Segoe UI', system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
                    .card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); padding: 40px; border-radius: 28px; max-width: 450px; }
                    h1 { color: #f43f5e; margin-bottom: 12px; font-weight: 800; }
                    p { color: #94a3b8; font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
                    a { display: inline-block; background: linear-gradient(135deg, #06b6d4, #6366f1); color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 16px; font-weight: 700; font-size: 13px; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>Transfer Expired</h1>
                    <p>This quantum transmission has expired, reached its download limit, or was purged by self-destruct.</p>
                    <a href="/void">Launch Aether Vault</a>
                </div>
            </body>
            </html>
        `);
    }

    // Increment download counter
    file.downloadsCount += 1;
    saveVaultIndex();

    const stat = fs.statSync(file.filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
    res.setHeader('Accept-Ranges', 'bytes');

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const stream = fs.createReadStream(file.filePath, { start, end });
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': chunksize
        });
        stream.pipe(res);
    } else {
        res.setHeader('Content-Length', fileSize);
        const stream = fs.createReadStream(file.filePath);
        stream.pipe(res);
    }

    // If burn-after-download is set, schedule file purge after response finishes
    if (file.burnAfterDownload || (file.maxDownloads && file.downloadsCount >= file.maxDownloads)) {
        res.on('finish', () => {
            setTimeout(() => {
                try {
                    if (fs.existsSync(file.filePath)) fs.unlinkSync(file.filePath);
                    vaultIndex.delete(fileId);
                    saveVaultIndex();
                    console.log(`[VAULT BURN] Self-destruct executed for file: ${fileId}`);
                } catch (e) {}
            }, 2000);
        });
    }
});

// Backward compatible download route
app.get('/api/download/:fileId', (req, res) => {
    res.redirect(`/api/vault/download/${req.params.fileId}`);
});

// -------------------------------------------------------------
// INTERACTIVE DOWNLOAD PORTAL /v/:fileId
// -------------------------------------------------------------
app.get('/v/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    const file = vaultIndex.get(fileId);

    if (!file || !fs.existsSync(file.filePath)) {
        return res.redirect(`/api/vault/download/${fileId}`);
    }

    const safeName = file.name.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const sizeFormatted = file.size > 1024 * 1024 * 1024 
        ? `${(file.size / (1024 * 1024 * 1024)).toFixed(2)} GB`
        : file.size > 1024 * 1024 
        ? `${(file.size / (1024 * 1024)).toFixed(2)} MB`
        : `${(file.size / 1024).toFixed(2)} KB`;

    const remainingHours = Math.max(0, Math.round((file.expiresAt - Date.now()) / (1000 * 3600)));
    const expiryText = remainingHours > 24 
        ? `${Math.round(remainingHours / 24)} days left` 
        : `${remainingHours} hours left`;

    res.send(`
<!DOCTYPE html>
<html lang="en" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>AETHER | Download "${safeName}"</title>
    <link rel="icon" type="image/png" href="/logo.png">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700;900&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Outfit', sans-serif; background: #07090e; color: white; min-height: 100vh; overflow-x: hidden; }
        .glass { background: rgba(12, 17, 29, 0.65); backdrop-filter: blur(30px); border: 1px solid rgba(255, 255, 255, 0.08); }
        .glow-btn { background: linear-gradient(135deg, #06b6d4, #6366f1); transition: all 0.3s cubic-bezier(0.19, 1, 0.22, 1); box-shadow: 0 10px 30px -10px rgba(6, 182, 212, 0.5); }
        .glow-btn:hover { transform: translateY(-3px) scale(1.02); box-shadow: 0 20px 40px -10px rgba(6, 182, 212, 0.7); }
    </style>
</head>
<body class="flex flex-col items-center justify-center p-6 selection:bg-cyan-500/30">
    <div class="fixed inset-0 pointer-events-none -z-10" style="background: radial-gradient(circle at 50% 30%, rgba(6,182,212,0.12) 0%, transparent 60%);"></div>

    <nav class="fixed top-0 left-0 w-full p-8 flex justify-between items-center z-50">
        <a href="/" class="flex items-center gap-4 text-white no-underline">
            <img src="/logo.png" alt="AETHER" class="w-10 h-10 object-contain">
            <span class="text-2xl font-black tracking-tighter">AETHER</span>
        </a>
        <a href="/void" class="glass px-6 py-2.5 rounded-2xl text-xs font-black uppercase tracking-widest text-cyan-400 hover:bg-white/10 transition-all">Open Vault</a>
    </nav>

    <main class="w-full max-w-lg glass p-10 md:p-14 rounded-[3.5rem] shadow-2xl text-center relative border border-cyan-500/20 my-20">
        <div class="w-24 h-24 rounded-3xl bg-cyan-500/10 border border-cyan-500/20 mx-auto flex items-center justify-center mb-8 shadow-inner">
            <svg class="w-12 h-12 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
        </div>

        <div class="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-300 text-[10px] font-black uppercase tracking-[0.2em] mb-4">
            ${file.isEncrypted ? '🔒 AES-256 Encrypted' : '⚡ Direct Cloud Stream'}
        </div>

        <h2 class="text-3xl md:text-4xl font-black tracking-tight text-white mb-2 break-all">${safeName}</h2>
        <p class="text-slate-400 font-bold text-sm mb-8">${sizeFormatted} • <span class="text-cyan-400">${expiryText}</span></p>

        ${file.burnAfterDownload ? '<p class="text-rose-400 text-xs font-black tracking-wider uppercase mb-6 bg-rose-500/10 py-2 px-4 rounded-xl border border-rose-500/20">⚠️ Burn on Download: File will permanently delete once downloaded</p>' : ''}

        ${file.isEncrypted ? `
        <div class="mb-8 text-left space-y-2">
            <label class="text-[10px] font-black uppercase tracking-widest text-slate-400 block px-1">Decryption Key / Password</label>
            <input type="password" id="decrypt-key" placeholder="Enter transfer password" class="w-full bg-slate-900/90 border border-cyan-500/30 rounded-2xl py-4 px-5 text-sm text-white focus:outline-none focus:border-cyan-400 transition-all">
        </div>
        ` : ''}

        <button id="btn-download" onclick="startDownload()" class="glow-btn w-full py-5 rounded-2xl text-black font-black text-sm uppercase tracking-widest flex items-center justify-center gap-3">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
            Download Now
        </button>

        <div id="decrypt-progress" class="hidden mt-6 text-left">
            <div class="flex justify-between text-[10px] font-black uppercase tracking-widest text-cyan-400 mb-2">
                <span>Decrypting Stream...</span>
                <span id="decrypt-pct">0%</span>
            </div>
            <div class="w-full bg-slate-900 rounded-full h-3 overflow-hidden p-0.5 border border-white/5">
                <div id="decrypt-bar" class="bg-cyan-400 h-full rounded-full w-0 transition-all duration-200"></div>
            </div>
        </div>

        <p class="text-[10px] text-slate-500 uppercase tracking-widest mt-8 font-bold">Zero-Knowledge Storage • Hardware Speed Velocity</p>
    </main>

    <script>
        const isEncrypted = ${file.isEncrypted ? 'true' : 'false'};
        const fileId = "${fileId}";
        const originalFilename = "${safeName}";

        // Check if hash has password fragment (e.g., #key=mySecretPassword)
        window.addEventListener('DOMContentLoaded', () => {
            const hash = window.location.hash;
            if (hash && hash.includes('key=')) {
                const key = decodeURIComponent(hash.split('key=')[1].split('&')[0]);
                const keyInput = document.getElementById('decrypt-key');
                if (keyInput) keyInput.value = key;
            }
        });

        async function startDownload() {
            const btn = document.getElementById('btn-download');
            if (!isEncrypted) {
                window.location.href = '/api/vault/download/' + fileId;
                btn.innerHTML = 'Starting Download...';
                setTimeout(() => { btn.innerHTML = 'Downloaded ✓'; }, 3000);
                return;
            }

            const keyInput = document.getElementById('decrypt-key');
            const password = keyInput ? keyInput.value.trim() : '';
            if (!password) {
                alert('Please enter the decryption password or passphrase!');
                return;
            }

            try {
                btn.disabled = true;
                btn.innerHTML = 'Downloading Ciphertext...';
                const progressDiv = document.getElementById('decrypt-progress');
                const bar = document.getElementById('decrypt-bar');
                const pct = document.getElementById('decrypt-pct');
                if (progressDiv) progressDiv.classList.remove('hidden');

                const response = await fetch('/api/vault/download/' + fileId);
                if (!response.ok) throw new Error('Download failed from server');

                const cipherBuffer = await response.arrayBuffer();
                btn.innerHTML = 'Decrypting AES-256...';

                // Client-side AES-GCM Decryption
                const decryptedData = await decryptAesGcm(cipherBuffer, password);
                
                // Trigger download of decrypted file
                const blob = new Blob([decryptedData]);
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = originalFilename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 2000);

                if (bar) bar.style.width = '100%';
                if (pct) pct.textContent = '100%';
                btn.innerHTML = 'Decrypted & Saved ✓';
            } catch (err) {
                console.error(err);
                alert('Decryption failed! Incorrect password or corrupted payload.');
                btn.disabled = false;
                btn.innerHTML = 'Try Again';
            }
        }

        async function decryptAesGcm(cipherData, password) {
            const bytes = new Uint8Array(cipherData);
            // First 16 bytes: Salt, Next 12 bytes: IV, Remaining: Ciphertext + Auth Tag
            if (bytes.length < 28) throw new Error('Invalid encrypted package');
            const salt = bytes.slice(0, 16);
            const iv = bytes.slice(16, 28);
            const data = bytes.slice(28);

            const enc = new TextEncoder();
            const keyMaterial = await window.crypto.subtle.importKey(
                "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]
            );
            const key = await window.crypto.subtle.deriveKey(
                { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
                keyMaterial,
                { name: "AES-GCM", length: 256 },
                false,
                ["decrypt"]
            );
            return await window.crypto.subtle.decrypt(
                { name: "AES-GCM", iv: iv }, key, data
            );
        }
    </script>
</body>
</html>
    `);
});

// -------------------------------------------------------------
// WEBRTC SIGNALING & BINARY SOCKET RELAY ENGINE
// -------------------------------------------------------------

const users = new Map();
const handshakes = new Set();

io.on('connection', (socket) => {
    const rawIp = socket.handshake.headers['x-forwarded-for'] || socket.request.socket.remoteAddress;
    const clientIp = (rawIp || '127.0.0.1').split(',')[0].trim().replace(/^.*:/, '');

    function getNetworkRoom(ip) {
        let cleanIp = ip.replace(/^::ffff:/, '');
        if (cleanIp.includes('.')) {
            return `ip-${cleanIp.split('.').slice(0, 2).join('.')}`;
        } else if (cleanIp.includes(':')) {
            return `ip-${cleanIp.split(':').slice(0, 2).join(':')}`;
        }
        return `ip-${cleanIp}`;
    }

    socket.on('register', ({ displayName, roomCode }) => {
        const ipRoomId = getNetworkRoom(clientIp);
        const linkRoomId = roomCode ? `room-${roomCode}` : null;
        
        users.set(socket.id, { ip: clientIp, displayName, ipRoomId, linkRoomId });
        
        socket.join(ipRoomId);
        if (linkRoomId) socket.join(linkRoomId);

        const peersMap = new Map();
        users.forEach((user, id) => {
            if (id !== socket.id) {
                if (user.ipRoomId === ipRoomId || (linkRoomId && user.linkRoomId === linkRoomId)) {
                    peersMap.set(id, { id, displayName: user.displayName });
                }
            }
        });
        
        socket.emit('init', { id: socket.id, peers: Array.from(peersMap.values()) });

        const notifyJoined = (roomId) => {
            if (!roomId) return;
            socket.to(roomId).emit('user-joined', {
                id: socket.id,
                displayName: displayName
            });
        };
        
        notifyJoined(ipRoomId);
        if (linkRoomId && linkRoomId !== ipRoomId) notifyJoined(linkRoomId);
    });

    socket.on('signal', ({ target, signal }) => {
        const sender = users.get(socket.id);
        const receiver = users.get(target);
        if (sender && receiver) {
            io.to(target).emit('signal', {
                sender: socket.id,
                signal: signal
            });
        }
    });

    socket.on('request-connect', ({ targetId, intent, pin }) => {
        const sender = users.get(socket.id);
        if (sender) {
            io.to(targetId).emit('incoming-request', {
                senderId: socket.id,
                senderName: sender.displayName,
                pin: pin,
                intent: intent
            });
        }
    });

    socket.on('accept-connect', ({ senderId }) => {
        handshakes.add(`${senderId}-${socket.id}`);
        handshakes.add(`${socket.id}-${senderId}`);
        io.to(senderId).emit('request-accepted', { receiverId: socket.id });
    });

    socket.on('decline-connect', ({ senderId }) => {
        io.to(senderId).emit('request-declined');
    });

    // High-speed Raw Binary Socket Relay Handlers (No Base64 String Overhead)
    socket.on('relay-start', ({ targetId, metadata }) => {
        io.to(targetId).emit('relay-start', {
            senderId: socket.id,
            metadata
        });
    });

    socket.on('relay-chunk', ({ targetId, chunk, index }) => {
        io.to(targetId).emit('relay-chunk', {
            senderId: socket.id,
            chunk,
            index
        });
    });

    socket.on('relay-end', ({ targetId }) => {
        io.to(targetId).emit('relay-end', {
            senderId: socket.id
        });
    });

    socket.on('relay-abort', ({ targetId }) => {
        io.to(targetId).emit('relay-abort', {
            senderId: socket.id
        });
    });

    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        if (user) {
            if (user.ipRoomId) socket.to(user.ipRoomId).emit('user-left', socket.id);
            if (user.linkRoomId) socket.to(user.linkRoomId).emit('user-left', socket.id);
            users.delete(socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

server.listen(PORT, () => {
    const localIp = getLocalIp();
    console.log(`
    ==================================================
    🚀 AETHER Quantum P2P & Encrypted Cloud Vault Server
    --------------------------------------------------
    Local:   http://localhost:${PORT}
    Network: http://${localIp}:${PORT}
    Storage: ${VAULT_DIR}
    ==================================================
    `);
});
