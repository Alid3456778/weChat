const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.static('public'));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const users = new Map(); // id -> {ws, name, role, room: null}

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'register') {
        const id = msg.id;
        users.set(id, { ws, name: msg.name, role: msg.role, room: null });
        broadcastUsers();
      } else if (msg.type === 'connect-request') {
        const from = users.get(msg.fromId);
        const toId = msg.toId;
        const to = users.get(toId);
        if (from.role === 'admin' && to && to.role === 'user') {
          from.room = `${from.id}-${toId}`;
          to.room = from.room;
          to.ws.send(JSON.stringify({type: 'connect-response', fromId: from.id, room: from.room}));
          broadcastUsers();
        }
      } else if (msg.type === 'webrtc' && msg.room) {
        users.forEach((u, id) => {
          if (u.room === msg.room && id !== msg.fromId) {
            u.ws.send(JSON.stringify(msg));
          }
        });
      }
    } catch (e) { console.error(e); }
  });

  ws.on('close', () => {
    users.forEach((u, id) => {
      if (u.ws === ws) {
        users.delete(id);
        broadcastUsers();
      }
    });
  });
});

function broadcastUsers() {
  const list = Array.from(users.values()).map(u => ({id: [...users.entries()].find(([k]) => users.get(k) === u)[0], name: u.name, role: u.role, online: true}));
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({type: 'userlist', users: list}));
    }
  });
}

server.listen(PORT, '0.0.0.0', () => console.log(`Server on port ${PORT}`));
