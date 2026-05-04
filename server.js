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

app.use(express.static(path.resolve(__dirname, 'public')));

app.get('/', (req, res) => {
    console.log('Root request received');
    res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

app.get('/void', (req, res) => {
    console.log('Void request received');
    res.sendFile(path.resolve(__dirname, 'public', 'void.html'));
});

// Store users: socket.id -> { ip, displayName, roomId }
const users = new Map();
// Store handshakes: "sender-receiver" -> true
const handshakes = new Set();

io.on('connection', (socket) => {
    // Capture IP address for local discovery
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.request.socket.remoteAddress;
    
    console.log(`User connected: ${socket.id} from ${clientIp}`);

    function getNetworkRoom(ip) {
        if (ip.includes('192.168.') || ip.includes('10.') || ip.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./) || ip === '::1' || ip === '127.0.0.1' || ip.includes('::ffff:192.168.') || ip.includes('::ffff:127.0.0.1')) {
            return 'local-network';
        }
        return `ip-${ip}`;
    }

    socket.on('register', ({ displayName, roomCode }) => {
        const ipRoomId = getNetworkRoom(clientIp);
        const linkRoomId = roomCode ? `room-${roomCode}` : null;
        
        users.set(socket.id, { ip: clientIp, displayName, ipRoomId, linkRoomId });
        
        socket.join(ipRoomId);
        if (linkRoomId) socket.join(linkRoomId);
        
        console.log(`User ${displayName} (${socket.id}) joined rooms: ${ipRoomId} ${linkRoomId ? ', ' + linkRoomId : ''}`);

        // Notify others in the rooms
        const notifyJoined = (roomId) => {
            if (!roomId) return;
            socket.to(roomId).emit('user-joined', {
                id: socket.id,
                displayName: displayName
            });
        };
        
        notifyJoined(ipRoomId);
        if (linkRoomId && linkRoomId !== ipRoomId) notifyJoined(linkRoomId);

        // Send existing peers to the new user
        const peersMap = new Map();
        users.forEach((user, id) => {
            if (id !== socket.id) {
                if (user.ipRoomId === ipRoomId || (linkRoomId && user.linkRoomId === linkRoomId)) {
                    peersMap.set(id, { id, displayName: user.displayName });
                }
            }
        });
        socket.emit('init', { id: socket.id, peers: Array.from(peersMap.values()) });
    });

    socket.on('signal', ({ target, signal }) => {
        const sender = users.get(socket.id);
        const receiver = users.get(target);
        
        if (sender && receiver) {
            const shareRoom = sender.ipRoomId === receiver.ipRoomId || 
                              (sender.linkRoomId && sender.linkRoomId === receiver.linkRoomId);
            if (shareRoom) {
                io.to(target).emit('signal', {
                    sender: socket.id,
                    signal: signal
                });
            }
        }
    });

    socket.on('request-connect', ({ targetId, intent, pin }) => {
        const sender = users.get(socket.id);
        if (sender) {
            io.to(targetId).emit('incoming-request', {
                senderId: socket.id,
                senderName: sender.displayName,
                pin: pin
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
server.listen(PORT, () => {
    console.log(`Aether Signaling Server running on port ${PORT}`);
});
