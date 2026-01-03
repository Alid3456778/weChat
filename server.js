const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.static('public'));
app.get('/health', (req, res) => res.send('OK'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const users = new Map();

wss.on('connection', (ws) => {
    ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        
        if (data.type === 'register') {
            users.set(data.username, ws);
            ws.username = data.username;
            ws.send(JSON.stringify({ type: 'registered', username: data.username }));
            broadcast({ type: 'online-users', users: Array.from(users.keys()) });
        }
        
        else if (data.type === 'check-online') {
            ws.send(JSON.stringify({ 
                type: 'status', 
                friend: data.friend, 
                online: users.has(data.friend) 
            }));
        }
        
        else if (data.type === 'offer' || data.type === 'answer' || data.type === 'ice-candidate') {
            const target = users.get(data.to);
            if (target) target.send(JSON.stringify(data));
        }
        
        else if (data.type === 'get-online-users') {
            ws.send(JSON.stringify({ 
                type: 'online-users', 
                users: Array.from(users.keys()).filter(u => u !== ws.username) 
            }));
        }
    });
    
    ws.on('close', () => {
        if (ws.username) {
            users.delete(ws.username);
            broadcast({ type: 'online-users', users: Array.from(users.keys()) });
        }
    });
});

function broadcast(data) {
    users.forEach(ws => ws.send(JSON.stringify(data)));
}

// server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on http://0.0.0.0:${PORT}`));