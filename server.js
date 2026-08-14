const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8 // 100 MB buffer limit for socket streams
});

// Enable CORS for all Express HTTP endpoints (Upload/Download/Health)
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Middleware for parsing JSON and large payloads
app.use(express.json({ limit: '100mb' }));
app.use(express.raw({ limit: '100mb', type: 'application/octet-stream' }));
app.use(express.static(path.resolve(__dirname, 'public')));

// Store temporary HTTP shared files: fileId -> { name, mime, data, createdAt, expiresAt }
const httpFiles = new Map();

// Auto cleanup expired HTTP files every minute
setInterval(() => {
    const now = Date.now();
    for (const [id, file] of httpFiles.entries()) {
        if (now > file.expiresAt) {
            httpFiles.delete(id);
            console.log(`[HTTP SHARE] Expired file auto-removed: ${id}`);
        }
    }
}, 60000);

app.get('/', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

app.get('/void', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'public', 'void.html'));
});

// Health check endpoint for hosting diagnostics
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        appName: 'Aether Transfer System',
        activeUsers: users.size,
        sharedFilesCount: httpFiles.size,
        uptime: process.uptime()
    });
});

// Tier 3 HTTP Upload Endpoint for link/QR code sharing
app.post('/api/upload', (req, res) => {
    try {
        const { name, mime, data } = req.body;
        if (!name || !data) {
            return res.status(400).json({ error: 'Invalid file data' });
        }

        const fileId = crypto.randomBytes(4).toString('hex'); // 8 char hex ID
        const buffer = Buffer.from(data, 'base64');
        const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes expiry

        httpFiles.set(fileId, {
            name,
            mime: mime || 'application/octet-stream',
            data: buffer,
            size: buffer.length,
            createdAt: Date.now(),
            expiresAt
        });

        console.log(`[HTTP SHARE] New file uploaded: ${name} (${buffer.length} bytes), ID: ${fileId}`);
        res.json({
            success: true,
            fileId,
            name,
            size: buffer.length,
            downloadUrl: `/api/download/${fileId}`,
            expiresInMinutes: 15
        });
    } catch (err) {
        console.error('[HTTP SHARE] Upload error:', err);
        res.status(500).json({ error: 'File upload failed' });
    }
});

// Tier 3 HTTP Download Endpoint
app.get('/api/download/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    const file = httpFiles.get(fileId);

    if (!file) {
        return res.status(404).send(`
            <!DOCTYPE html>
            <html>
            <head><title>AETHER | File Expired or Not Found</title></head>
            <body style="background:#090a0f; color:#fff; font-family:sans-serif; text-align:center; padding-top:100px;">
                <h1 style="color:#ef4444;">File Link Expired or Invalid</h1>
                <p style="color:#94a3b8;">This file download link has expired or has already been removed.</p>
                <a href="/void" style="color:#06b6d4; text-decoration:none; font-weight:bold;">← Return to Aether App</a>
            </body>
            </html>
        `);
    }

    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', file.size);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
    res.send(file.data);
});

// Store users: socket.id -> { ip, displayName, ipRoomId, linkRoomId }
const users = new Map();
// Store handshakes: "sender-receiver" -> true
const handshakes = new Set();

io.on('connection', (socket) => {
    // Capture IP address (Handling proxies like Render/Netlify/Vercel)
    const rawIp = socket.handshake.headers['x-forwarded-for'] || socket.request.socket.remoteAddress;
    const clientIp = (rawIp || '127.0.0.1').split(',')[0].trim().replace(/^.*:/, '');
    
    console.log(`User connected: ${socket.id} from ${clientIp}`);

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
        
        console.log(`[DEBUG] User Registered: ${displayName} (${socket.id}) | Room: ${roomCode || 'Auto-IP'}`);

        // Send existing peers to the new user
        const peersMap = new Map();
        users.forEach((user, id) => {
            if (id !== socket.id) {
                if (user.ipRoomId === ipRoomId || (linkRoomId && user.linkRoomId === linkRoomId)) {
                    peersMap.set(id, { id, displayName: user.displayName });
                }
            }
        });
        
        const peersList = Array.from(peersMap.values());
        socket.emit('init', { id: socket.id, peers: peersList });

        // Notify others in rooms
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

    // WebRTC Signaling
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

    // Handshake requests
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

    // Tier 2: Socket Server Relay Fallback (For when WebRTC P2P fails)
    socket.on('relay-start', ({ targetId, metadata }) => {
        console.log(`[SOCKET RELAY] Transmission started from ${socket.id} to ${targetId}`);
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
        console.log(`[SOCKET RELAY] Transmission finished from ${socket.id} to ${targetId}`);
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
    🚀 AETHER Multi-Method Signaling & Relay Server
    --------------------------------------------------
    Local Access:   http://localhost:${PORT}
    Network Access: http://${localIp}:${PORT}
    ==================================================
    `);
});

