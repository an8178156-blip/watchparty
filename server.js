// WatchTogether server: serves the website and relays real-time events
// (playback sync, chat, and WebRTC signaling for voice + streaming).
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

app.use(express.static(path.join(__dirname, 'public')));

// ICE servers for WebRTC. STUN is free; add a TURN server through
// environment variables for friends on strict networks (see README).
app.get('/config', (req, res) => {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  res.json({ iceServers });
});

app.get('/room/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Rooms ----------
// room = { users: Map<socketId, {id,name,mic}>, state, stream, messages[] }
const rooms = new Map();
const MODES = ['none', 'youtube', 'url', 'local'];

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, { users: new Map(), state: null, stream: null, messages: [] });
  }
  return rooms.get(id);
}

// Current playback state, with the position moved forward if it is playing.
function currentState(room) {
  const s = room.state;
  if (!s) return null;
  const now = Date.now();
  const time = s.playing ? s.time + (now - s.updatedAt) / 1000 : s.time;
  return { ...s, time, updatedAt: now };
}

function pushMessage(roomId, msg) {
  const room = rooms.get(roomId);
  if (!room) return;
  msg.at = Date.now();
  room.messages.push(msg);
  if (room.messages.length > 100) room.messages.shift();
  io.to(roomId).emit('chat', msg);
}

io.on('connection', (socket) => {
  let roomId = null;
  let user = null;

  socket.on('join', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const id = String(payload?.room || '').replace(/[^\w-]/g, '').slice(0, 40);
    const name = String(payload?.name || '').trim().slice(0, 30) || 'Guest';
    if (!id) return ack({ error: 'Invalid room code' });
    if (roomId) return ack({ error: 'Already in a room' });

    roomId = id;
    const room = getRoom(roomId);
    if (room.users.size >= 12) {
      roomId = null;
      return ack({ error: 'This room is full (12 people max).' });
    }
    user = { id: socket.id, name, mic: false };
    room.users.set(socket.id, user);
    socket.join(roomId);

    ack({
      id: socket.id,
      serverNow: Date.now(),
      users: [...room.users.values()],
      state: currentState(room),
      stream: room.stream,
      messages: room.messages.slice(-50),
    });
    socket.to(roomId).emit('user-joined', user);
    pushMessage(roomId, { system: true, text: `${name} joined` });
  });

  socket.on('chat', (text) => {
    if (!roomId) return;
    text = String(text || '').trim().slice(0, 500);
    if (!text) return;
    pushMessage(roomId, { from: socket.id, name: user.name, text });
  });

  socket.on('sync', (s) => {
    const room = rooms.get(roomId);
    if (!room || !s || !MODES.includes(s.mode)) return;
    const t = Number(s.time);
    room.state = {
      mode: s.mode,
      source: String(s.source || '').slice(0, 2000),
      playing: !!s.playing,
      time: Number.isFinite(t) && t >= 0 ? t : 0,
      updatedAt: Date.now(),
      by: user.name,
    };
    socket.to(roomId).emit('sync', room.state);
  });

  socket.on('get-state', (ack) => {
    const room = rooms.get(roomId);
    if (room && typeof ack === 'function') ack(currentState(room));
  });

  // WebRTC signaling relay (offers, answers, ICE candidates)
  socket.on('signal', (msg) => {
    const room = rooms.get(roomId);
    if (!room || !msg || !room.users.has(msg.to)) return;
    io.to(msg.to).emit('signal', { from: socket.id, data: msg.data });
  });

  socket.on('mic', (on) => {
    if (!roomId) return;
    user.mic = !!on;
    io.to(roomId).emit('user-update', user);
  });

  socket.on('stream-start', (info) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.stream = { by: socket.id, name: user.name, streamId: String(info?.streamId || '').slice(0, 100) };
    socket.to(roomId).emit('stream-start', room.stream);
    pushMessage(roomId, { system: true, text: `${user.name} started streaming` });
  });

  socket.on('stream-stop', () => {
    const room = rooms.get(roomId);
    if (!room || room.stream?.by !== socket.id) return;
    room.stream = null;
    socket.to(roomId).emit('stream-stop');
    pushMessage(roomId, { system: true, text: `${user.name} stopped streaming` });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.users.delete(socket.id);
    socket.to(roomId).emit('user-left', socket.id);
    if (room.stream?.by === socket.id) {
      room.stream = null;
      socket.to(roomId).emit('stream-stop');
    }
    if (room.users.size === 0) rooms.delete(roomId);
    else pushMessage(roomId, { system: true, text: `${user.name} left` });
  });
});

server.listen(PORT, () => {
  console.log(`WatchTogether running at http://localhost:${PORT}`);
});
