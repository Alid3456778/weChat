const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

// Serve static files
app.use(express.static('public'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    users: users.size,
    timestamp: new Date().toISOString()
  });
});

const server = http.createServer(app);

// WebSocket server with better configuration
const wss = new WebSocket.Server({ 
  server,
  clientTracking: true,
  perMessageDeflate: false, // Disable compression for lower latency
  maxPayload: 10 * 1024 * 1024 // 10MB max message size
});

const users = new Map();
const userSessions = new Map();

// Heartbeat to detect dead connections
const heartbeat = function() {
  this.isAlive = true;
};

wss.on('connection', (ws, req) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`New connection from ${clientIp}`);
  
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (e) {
      console.error('Invalid JSON:', e);
      return;
    }

    console.log(`Message from ${ws.username || 'unknown'}: ${data.type}`);

    switch(data.type) {
      case 'register':
        handleRegister(ws, data);
        break;
      
      case 'check-online':
        handleCheckOnline(ws, data);
        break;
      
      case 'offer':
      case 'answer':
      case 'ice-candidate':
        handleSignaling(ws, data);
        break;
      
      case 'get-online-users':
        handleGetOnlineUsers(ws);
        break;
      
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      
      case 'typing':
      case 'stop-typing':
        handleTyping(ws, data);
        break;
      
      default:
        console.log(`Unknown message type: ${data.type}`);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`Connection closed: ${ws.username || 'unknown'} (code: ${code})`);
    if (ws.username) {
      users.delete(ws.username);
      userSessions.delete(ws.username);
      broadcastOnlineUsers();
    }
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for ${ws.username || 'unknown'}:`, error.message);
  });
});

function handleRegister(ws, data) {
  const username = data.username.toLowerCase().trim();
  
  // Check if username already exists
  if (users.has(username)) {
    const existingWs = users.get(username);
    // Close existing connection
    existingWs.close(1000, 'New connection established');
  }

  users.set(username, ws);
  ws.username = username;
  
  userSessions.set(username, {
    connectedAt: new Date(),
    lastSeen: new Date()
  });

  ws.send(JSON.stringify({ 
    type: 'registered', 
    username: username 
  }));

  console.log(`User registered: ${username} (Total: ${users.size})`);
  
  // Broadcast updated user list
  broadcastOnlineUsers();
}

function handleCheckOnline(ws, data) {
  const friend = data.friend.toLowerCase().trim();
  const isOnline = users.has(friend);
  
  ws.send(JSON.stringify({ 
    type: 'status', 
    friend: friend, 
    online: isOnline 
  }));

  console.log(`Status check: ${friend} is ${isOnline ? 'online' : 'offline'}`);
}

function handleSignaling(ws, data) {
  const target = users.get(data.to);
  
  if (target && target.readyState === WebSocket.OPEN) {
    // Forward the signaling message
    target.send(JSON.stringify(data));
    console.log(`Forwarded ${data.type} from ${ws.username} to ${data.to}`);
  } else {
    console.log(`Failed to forward ${data.type}: ${data.to} not found or not connected`);
    ws.send(JSON.stringify({ 
      type: 'error', 
      message: `User ${data.to} is not online` 
    }));
  }
}

function handleGetOnlineUsers(ws) {
  const userList = Array.from(users.keys()).filter(u => u !== ws.username);
  
  ws.send(JSON.stringify({ 
    type: 'online-users', 
    users: userList 
  }));
}

function handleTyping(ws, data) {
  const target = users.get(data.to);
  
  if (target && target.readyState === WebSocket.OPEN) {
    target.send(JSON.stringify({
      type: data.type,
      from: ws.username
    }));
  }
}

function broadcastOnlineUsers() {
  const userList = Array.from(users.keys());
  const message = JSON.stringify({ 
    type: 'online-users', 
    users: userList 
  });

  users.forEach((ws, username) => {
    if (ws.readyState === WebSocket.OPEN) {
      const filteredList = userList.filter(u => u !== username);
      ws.send(JSON.stringify({ 
        type: 'online-users', 
        users: filteredList 
      }));
    }
  });

  console.log(`Broadcast user list: ${userList.length} users online`);
}

// Ping clients every 30 seconds to detect dead connections
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`Terminating dead connection: ${ws.username || 'unknown'}`);
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(pingInterval);
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});