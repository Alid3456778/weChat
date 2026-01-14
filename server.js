const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(__dirname));

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Store connected clients
const clients = new Map();
let adminClient = null;
const userQueue = [];
const activeChats = new Map();
const chatHistory = new Map();

// Generate unique ID
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// Broadcast to all clients
function broadcast(message, excludeId = null) {
    clients.forEach((client, id) => {
        if (id !== excludeId && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(message));
        }
    });
}

// Send to specific client
function sendToClient(clientId, message) {
    const client = clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
    }
}

// Update user list for admin
function updateUserList() {
    if (!adminClient) return;

    const userList = Array.from(clients.values())
        .filter(c => c.type === 'user')
        .map(c => ({
            id: c.id,
            username: c.username,
            type: c.type,
            inChat: activeChats.has(c.id)
        }));

    sendToClient(adminClient.id, {
        type: 'userList',
        users: userList
    });
}

// Update queue positions
function updateQueue() {
    userQueue.forEach((userId, index) => {
        sendToClient(userId, {
            type: 'queuePosition',
            position: index + 1
        });
    });
}

// WebSocket connection handler
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
        switch (data.type) {
            case 'join':
                handleJoin(ws, data);
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

            case 'offer':
            case 'answer':
            case 'iceCandidate':
                handleWebRTC(data);
                break;

            case 'requestVideo':
                handleVideoRequest(data);
                break;

            default:
                console.log('Unknown message type:', data.type);
        }
    }

    function handleJoin(ws, data) {
        clientId = generateId();

        const client = {
            id: clientId,
            ws: ws,
            username: data.username,
            type: data.userType
        };

        clients.set(clientId, client);

        // Send welcome message
        ws.send(JSON.stringify({
            type: 'welcome',
            userId: clientId
        }));

        if (data.userType === 'admin') {
            if (adminClient) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'An admin is already connected'
                }));
                ws.close();
                return;
            }
            adminClient = client;
            console.log(`Admin ${data.username} connected`);
            updateUserList();
        } else {
            console.log(`User ${data.username} connected`);
            
            // Add to queue if admin exists
            if (adminClient) {
                userQueue.push(clientId);
                updateQueue();
                updateUserList();
            } else {
                ws.send(JSON.stringify({
                    type: 'queuePosition',
                    position: 0
                }));
            }
        }
    }

    function handleSelectUser(data) {
        if (!adminClient || clients.get(clientId)?.type !== 'admin') {
            return;
        }

        const userId = data.userId;
        const user = clients.get(userId);

        if (!user || user.type !== 'user') {
            sendToClient(clientId, {
                type: 'error',
                message: 'User not found'
            });
            return;
        }

        // Remove from queue
        const queueIndex = userQueue.indexOf(userId);
        if (queueIndex > -1) {
            userQueue.splice(queueIndex, 1);
        }

        // Create active chat
        activeChats.set(userId, adminClient.id);
        activeChats.set(adminClient.id, userId);

        // Get chat history if exists
        const chatKey = `${adminClient.id}-${userId}`;
        const messages = chatHistory.get(chatKey) || [];

        // Notify both parties
        sendToClient(adminClient.id, {
            type: 'chatStarted',
            with: {
                id: userId,
                username: user.username,
                type: user.type
            },
            messages: messages
        });

        sendToClient(userId, {
            type: 'chatStarted',
            with: {
                id: adminClient.id,
                username: adminClient.username,
                type: adminClient.type
            },
            messages: messages
        });

        // Update queue positions for remaining users
        updateQueue();
        updateUserList();
    }

    function handleChatMessage(data) {
        const fromClient = clients.get(clientId);
        if (!fromClient) return;

        const toId = data.to;
        const toClient = clients.get(toId);

        if (!toClient) return;

        const message = {
            from: fromClient.username,
            text: data.text,
            timestamp: new Date().toISOString()
        };

        // Store in chat history
        let chatKey;
        if (fromClient.type === 'admin') {
            chatKey = `${clientId}-${toId}`;
        } else {
            chatKey = `${toId}-${clientId}`;
        }

        if (!chatHistory.has(chatKey)) {
            chatHistory.set(chatKey, []);
        }
        chatHistory.get(chatKey).push(message);

        // Send to recipient
        sendToClient(toId, {
            type: 'message',
            from: fromClient.username,
            text: data.text,
            timestamp: message.timestamp
        });
    }

    function handleEndChat(data) {
        const fromClient = clients.get(clientId);
        if (!fromClient) return;

        let otherUserId;
        if (fromClient.type === 'admin') {
            otherUserId = data.userId;
        } else {
            otherUserId = activeChats.get(clientId);
        }

        // Remove from active chats
        activeChats.delete(clientId);
        activeChats.delete(otherUserId);

        // Notify other user
        if (otherUserId) {
            const otherClient = clients.get(otherUserId);
            if (otherClient) {
                if (otherClient.type === 'user') {
                    // Put user back in queue
                    userQueue.push(otherUserId);
                    sendToClient(otherUserId, {
                        type: 'chatEnded',
                        queuePosition: userQueue.length
                    });
                } else {
                    sendToClient(otherUserId, {
                        type: 'chatEnded'
                    });
                }
            }
        }

        updateQueue();
        updateUserList();
    }

    function handleWebRTC(data) {
        const toId = data.to;
        if (toId) {
            sendToClient(toId, {
                type: data.type,
                [data.type]: data[data.type],
                offer: data.offer,
                answer: data.answer,
                candidate: data.candidate,
                from: clientId
            });
        }
    }

    function handleVideoRequest(data) {
        if (clients.get(clientId)?.type !== 'admin') {
            return;
        }

        sendToClient(data.userId, {
            type: 'videoRequest'
        });
    }
});

function handleDisconnect(clientId) {
    if (!clientId) return;

    const client = clients.get(clientId);
    if (!client) return;

    console.log(`${client.username} disconnected`);

    if (client.type === 'admin') {
        // Admin disconnected
        adminClient = null;

        // End all active chats
        activeChats.forEach((partnerId, userId) => {
            if (userId !== clientId) {
                sendToClient(userId, {
                    type: 'chatEnded'
                });
            }
        });

        activeChats.clear();
        userQueue.length = 0;

        // Notify all users
        clients.forEach((c, id) => {
            if (c.type === 'user' && id !== clientId) {
                sendToClient(id, {
                    type: 'queuePosition',
                    position: 0
                });
            }
        });
    } else {
        // User disconnected
        const queueIndex = userQueue.indexOf(clientId);
        if (queueIndex > -1) {
            userQueue.splice(queueIndex, 1);
            updateQueue();
        }

        // If in active chat, notify admin
        const partnerId = activeChats.get(clientId);
        if (partnerId) {
            activeChats.delete(clientId);
            activeChats.delete(partnerId);
            sendToClient(partnerId, {
                type: 'chatEnded'
            });
        }

        updateUserList();
    }

    clients.delete(clientId);
}

// Start server
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`WebSocket server is ready`);
});