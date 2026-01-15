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

const clients = new Map();
let adminClient = null;
const userQueue = [];
const activeChats = new Map();
const chatHistory = new Map();
const messageQueues = new Map(); // Separate queues for priority handling

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

function sendToClient(clientId, message) {
    const client = clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
        // Priority messages (chat) sent immediately
        if (message.priority === true) {
            client.ws.send(JSON.stringify(message));
            console.log(`💬 Priority message sent to ${clientId}`);
        } else {
            // Low priority messages (video frames) queued
            if (!messageQueues.has(clientId)) {
                messageQueues.set(clientId, []);
            }
            const queue = messageQueues.get(clientId);
            
            // HARD LIMIT: Only 1 frame in queue
            if (queue.length >= 1) {
                queue.shift(); // Remove oldest frame immediately
            }
            
            queue.push(message);
        }
    }
}

// Process message queues FAST for all clients
function processMessageQueues() {
    messageQueues.forEach((queue, clientId) => {
        const client = clients.get(clientId);
        if (client && client.ws.readyState === WebSocket.OPEN && queue.length > 0) {
            const message = queue.shift();
            client.ws.send(JSON.stringify(message));
        }
    });
}

// Process queues every 50ms (faster than before)
setInterval(processMessageQueues, 50);

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

function updateQueue() {
    userQueue.forEach((userId, index) => {
        sendToClient(userId, {
            type: 'queuePosition',
            position: index + 1
        });
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
        console.log('Received message type:', data.type);
        
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
            case 'startVideoStream':
                handleStartVideoStream(data);
                break;
            case 'stopVideoStream':
                handleStopVideoStream(data);
                break;
            case 'videoFrame':
                handleVideoFrame(data);
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
            console.log(`✅ Admin ${data.username} connected`);
            updateUserList();
        } else {
            console.log(`✅ User ${data.username} connected`);
            
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

        const queueIndex = userQueue.indexOf(userId);
        if (queueIndex > -1) {
            userQueue.splice(queueIndex, 1);
        }

        activeChats.set(userId, adminClient.id);
        activeChats.set(adminClient.id, userId);

        const chatKey = `${adminClient.id}-${userId}`;
        const messages = chatHistory.get(chatKey) || [];

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

        // Send with priority flag
        sendToClient(toId, {
            type: 'message',
            from: fromClient.username,
            text: data.text,
            timestamp: message.timestamp,
            priority: true // HIGH PRIORITY - send immediately
        });

        console.log(`💬 Message from ${fromClient.username} to ${toClient.username}`);
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

        activeChats.delete(clientId);
        activeChats.delete(otherUserId);

        if (otherUserId) {
            const otherClient = clients.get(otherUserId);
            if (otherClient) {
                // Stop video stream
                sendToClient(otherUserId, {
                    type: 'stopVideoStream'
                });

                if (otherClient.type === 'user') {
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

    function handleStartVideoStream(data) {
        if (clients.get(clientId)?.type !== 'admin') {
            return;
        }

        const userId = data.userId;
        console.log(`📹 Admin requesting video stream from user ${userId}`);
        
        sendToClient(userId, {
            type: 'startVideoStream'
        });
    }

    function handleStopVideoStream(data) {
        if (clients.get(clientId)?.type !== 'admin') {
            return;
        }

        const userId = data.userId;
        console.log(`⏸️ Admin stopping video stream from user ${userId}`);
        
        sendToClient(userId, {
            type: 'stopVideoStream'
        });
    }

    function handleVideoFrame(data) {
        const fromClient = clients.get(clientId);
        if (!fromClient || fromClient.type !== 'user') {
            return;
        }

        const toId = data.to;
        
        // Forward the frame to admin (low priority)
        if (toId && clients.has(toId)) {
            sendToClient(toId, {
                type: 'videoFrame',
                frame: data.frame,
                from: clientId,
                priority: false // LOW PRIORITY - queued
            });
        }
    }
});

function handleDisconnect(clientId) {
    if (!clientId) return;

    const client = clients.get(clientId);
    if (!client) return;

    console.log(`❌ ${client.username} disconnected`);

    // Clean up message queue
    messageQueues.delete(clientId);

    if (client.type === 'admin') {
        adminClient = null;

        activeChats.forEach((partnerId, userId) => {
            if (userId !== clientId) {
                sendToClient(userId, {
                    type: 'stopVideoStream'
                });
                sendToClient(userId, {
                    type: 'chatEnded'
                });
            }
        });

        activeChats.clear();
        userQueue.length = 0;

        clients.forEach((c, id) => {
            if (c.type === 'user' && id !== clientId) {
                sendToClient(id, {
                    type: 'queuePosition',
                    position: 0
                });
            }
        });
    } else {
        const queueIndex = userQueue.indexOf(clientId);
        if (queueIndex > -1) {
            userQueue.splice(queueIndex, 1);
            updateQueue();
        }

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

server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`✅ WebSocket server ready`);
    console.log(`✅ Frame streaming enabled`);
    console.log(`🌐 Access at http://localhost:${PORT}`);
});