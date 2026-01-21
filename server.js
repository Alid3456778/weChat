const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map(); // roomId -> { admin, users: [], chats: Map() }
const clients = new Map(); // clientId -> { ws, username, type, roomId }

function generateRoomId() {
    return Math.random().toString(36).substring(2, 10);
}

function generateClientId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

function sendToClient(clientId, message) {
    const client = clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
    }
}

function getRoomUsers(roomId) {
    const room = rooms.get(roomId);
    if (!room) return [];
    
    return room.users.map(userId => {
        const client = clients.get(userId);
        return {
            id: userId,
            username: client.username,
            type: client.type,
            inChat: room.activeChats.has(userId)
        };
    });
}

function updateAdminUserList(roomId) {
    const room = rooms.get(roomId);
    if (!room || !room.admin) return;

    const userList = getRoomUsers(roomId);
    sendToClient(room.admin, {
        type: 'userList',
        users: userList
    });
}

wss.on('connection', (ws) => {
    let clientId = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(ws, data);
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });

    ws.on('close', () => {
        handleDisconnect(clientId);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });

    function handleMessage(ws, data) {
        console.log('📨 Received:', data.type);
        
        switch (data.type) {
            case 'createRoom':
                handleCreateRoom(ws, data);
                break;
            case 'joinRoom':
                handleJoinRoom(ws, data);
                break;
            case 'selectUser':
                handleSelectUser(data);
                break;
            case 'message':
                handleChatMessage(data);
                break;
            case 'endChat':
                handleEndChat(data);
                break;
            case 'webrtc-offer':
                handleWebRTCOffer(data);
                break;
            case 'webrtc-answer':
                handleWebRTCAnswer(data);
                break;
            case 'webrtc-ice':
                handleWebRTCIce(data);
                break;
            default:
                console.log('Unknown message type:', data.type);
        }
    }

    function handleCreateRoom(ws, data) {
        const ADMIN_PASSWORD = 'admin123';
        
        if (data.password !== ADMIN_PASSWORD) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Incorrect admin password'
            }));
            return;
        }

        const roomId = generateRoomId();
        clientId = generateClientId();

        // Create room
        rooms.set(roomId, {
            admin: clientId,
            users: [],
            activeChats: new Map(),
            chatHistory: new Map()
        });

        // Create client
        clients.set(clientId, {
            ws: ws,
            username: data.username,
            type: 'admin',
            roomId: roomId
        });

        // Send room URL to admin
        const roomUrl = `${data.origin || 'http://localhost:' + PORT}?room=${roomId}`;
        
        ws.send(JSON.stringify({
            type: 'roomCreated',
            userId: clientId,
            roomId: roomId,
            roomUrl: roomUrl
        }));

        console.log(`✅ Admin ${data.username} created room: ${roomId}`);
        console.log(`🔗 Room URL: ${roomUrl}`);
    }

    function handleJoinRoom(ws, data) {
        const roomId = data.roomId;
        const room = rooms.get(roomId);

        if (!room) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Room not found'
            }));
            return;
        }

        clientId = generateClientId();

        // Add user to room
        room.users.push(clientId);

        // Create client
        clients.set(clientId, {
            ws: ws,
            username: data.username,
            type: 'user',
            roomId: roomId
        });

        ws.send(JSON.stringify({
            type: 'welcome',
            userId: clientId,
            roomId: roomId
        }));

        console.log(`✅ User ${data.username} joined room: ${roomId}`);

        // Notify admin of new user
        updateAdminUserList(roomId);
    }

    function handleSelectUser(data) {
        const admin = clients.get(clientId);
        if (!admin || admin.type !== 'admin') return;

        const roomId = admin.roomId;
        const room = rooms.get(roomId);
        if (!room) return;

        const userId = data.userId;
        const user = clients.get(userId);

        if (!user || user.type !== 'user') {
            sendToClient(clientId, {
                type: 'error',
                message: 'User not found'
            });
            return;
        }

        // Set active chat
        room.activeChats.set(userId, clientId);
        room.activeChats.set(clientId, userId);

        const chatKey = `${clientId}-${userId}`;
        const messages = room.chatHistory.get(chatKey) || [];

        // Send to ADMIN
        sendToClient(clientId, {
            type: 'chatStarted',
            with: {
                id: userId,
                username: user.username,
                type: user.type
            },
            messages: messages
        });

        // Send to USER
        sendToClient(userId, {
            type: 'chatStarted',
            with: {
                id: clientId,
                username: admin.username,
                type: admin.type
            },
            messages: messages
        });

        updateAdminUserList(roomId);
        console.log(`✅ Chat started: ${admin.username} ↔ ${user.username}`);
    }

    function handleChatMessage(data) {
        const fromClient = clients.get(clientId);
        if (!fromClient) return;

        const roomId = fromClient.roomId;
        const room = rooms.get(roomId);
        if (!room) return;

        const toId = data.to;
        const toClient = clients.get(toId);
        if (!toClient) return;

        const message = {
            from: fromClient.username,
            text: data.text,
            timestamp: new Date().toISOString()
        };

        // Save to history
        let chatKey;
        if (fromClient.type === 'admin') {
            chatKey = `${clientId}-${toId}`;
        } else {
            chatKey = `${toId}-${clientId}`;
        }

        if (!room.chatHistory.has(chatKey)) {
            room.chatHistory.set(chatKey, []);
        }
        room.chatHistory.get(chatKey).push(message);

        // Send to recipient
        sendToClient(toId, {
            type: 'message',
            from: fromClient.username,
            text: data.text,
            timestamp: message.timestamp
        });

        console.log(`💬 Message: ${fromClient.username} → ${toClient.username}`);
    }

    function handleEndChat(data) {
        const fromClient = clients.get(clientId);
        if (!fromClient) return;

        const roomId = fromClient.roomId;
        const room = rooms.get(roomId);
        if (!room) return;

        let otherUserId;
        if (fromClient.type === 'admin') {
            otherUserId = data.userId;
        } else {
            otherUserId = room.activeChats.get(clientId);
        }

        // Clear active chats
        room.activeChats.delete(clientId);
        room.activeChats.delete(otherUserId);

        if (otherUserId) {
            sendToClient(otherUserId, {
                type: 'chatEnded'
            });
        }

        updateAdminUserList(roomId);
    }

    function handleWebRTCOffer(data) {
        const toId = data.to;
        if (clients.has(toId)) {
            sendToClient(toId, {
                type: 'webrtc-offer',
                offer: data.offer,
                from: clientId
            });
            console.log(`🔄 WebRTC offer: ${clientId} → ${toId}`);
        }
    }

    function handleWebRTCAnswer(data) {
        const toId = data.to;
        if (clients.has(toId)) {
            sendToClient(toId, {
                type: 'webrtc-answer',
                answer: data.answer,
                from: clientId
            });
            console.log(`🔄 WebRTC answer: ${clientId} → ${toId}`);
        }
    }

    function handleWebRTCIce(data) {
        const toId = data.to;
        if (clients.has(toId)) {
            sendToClient(toId, {
                type: 'webrtc-ice',
                candidate: data.candidate,
                from: clientId
            });
        }
    }
});

function handleDisconnect(clientId) {
    if (!clientId) return;

    const client = clients.get(clientId);
    if (!client) return;

    console.log(`❌ ${client.username} disconnected`);

    const roomId = client.roomId;
    const room = rooms.get(roomId);

    if (room) {
        if (client.type === 'admin') {
            // Admin left - notify all users and close room
            room.users.forEach(userId => {
                sendToClient(userId, {
                    type: 'roomClosed',
                    message: 'Admin left the room'
                });
            });

            // Clean up room
            rooms.delete(roomId);
            console.log(`🗑️ Room ${roomId} closed`);
        } else {
            // User left - remove from room
            const userIndex = room.users.indexOf(clientId);
            if (userIndex > -1) {
                room.users.splice(userIndex, 1);
            }

            // End active chat
            const partnerId = room.activeChats.get(clientId);
            if (partnerId) {
                room.activeChats.delete(clientId);
                room.activeChats.delete(partnerId);
                sendToClient(partnerId, {
                    type: 'chatEnded'
                });
            }

            updateAdminUserList(roomId);
        }
    }

    clients.delete(clientId);
}

server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`✅ WebSocket server ready`);
    console.log(`🎥 WebRTC signaling enabled`);
    console.log(`🌐 Access at http://localhost:${PORT}`);
});