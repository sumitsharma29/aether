const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/void', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'void.html'));
});

// Store users: socket.id -> { ip, displayName, roomId }
const users = new Map();
// Store handshakes: "sender-receiver" -> true
const handshakes = new Set();

io.on('connection', (socket) => {
    // Capture IP address for local discovery
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.request.socket.remoteAddress;
    
    console.log(`User connected: ${socket.id} from ${clientIp}`);

    socket.on('register', ({ displayName }) => {
        // Automatically join room named after IP for local network discovery
        const roomId = `ip-${clientIp}`;
        
        users.set(socket.id, { ip: clientIp, displayName, roomId });
        socket.join(roomId);

        // Notify others in the same room
        socket.to(roomId).emit('peer-joined', {
            id: socket.id,
            displayName: displayName
        });

        // Send existing peers to the new user
        const peers = [];
        users.forEach((user, id) => {
            if (id !== socket.id && user.roomId === roomId) {
                peers.push({ id, displayName: user.displayName });
            }
        });
        socket.emit('peer-list', peers);
    });

    socket.on('signal', ({ to, signal }) => {
        // Only allow signaling if both parties are in the same IP room
        const sender = users.get(socket.id);
        const receiver = users.get(to);
        
        if (sender && receiver && sender.roomId === receiver.roomId) {
            io.to(to).emit('signal', {
                from: socket.id,
                signal: signal
            });
        }
    });

    socket.on('request-handshake', ({ to, pin }) => {
        const sender = users.get(socket.id);
        if (sender) {
            io.to(to).emit('incoming-handshake', {
                from: socket.id,
                fromName: sender.displayName,
                pin: pin
            });
        }
    });

    socket.on('accept-handshake', ({ to }) => {
        handshakes.add(`${to}-${socket.id}`);
        handshakes.add(`${socket.id}-${to}`);
        io.to(to).emit('handshake-accepted', { from: socket.id });
    });

    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        if (user) {
            socket.to(user.roomId).emit('peer-left', socket.id);
            users.delete(socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Aether Signaling Server running on port ${PORT}`);
});
