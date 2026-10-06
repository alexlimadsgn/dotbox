// Servidor DotBox: serve o build do Vite (dist/) e gere as salas via Socket.IO.
// Todo o estado vive em memória — reiniciar o servidor apaga as partidas.
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const PORT = process.env.PORT || 3001;
const GRID_SIZE = 8;
const MAX_PLAYERS = 7;
const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#a855f7', '#ec4899', '#06b6d4'];
const IDLE_ROOM_MS = 10 * 60 * 1000; // sala sem ninguém ligado
const FINISHED_ROOM_MS = 5 * 60 * 1000; // sala terminada
const MAX_CHAT_HISTORY = 100;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../dist');

const app = express();
app.get('/health', (_req, res) => res.send('ok'));
app.use(express.static(distDir));
app.use((_req, res) => res.sendFile(path.join(distDir, 'index.html')));

const httpServer = createServer(app);
const io = new Server(httpServer);

/** @type {Map<string, any>} */
const rooms = new Map();

// --- Helpers ---

const cleanName = (name) => String(name || 'Jogador').trim().slice(0, 12) || 'Jogador';

function newCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 6).toUpperCase().padEnd(4, 'X');
  } while (rooms.has(code));
  return code;
}

function emptyBoard() {
  const lines = {};
  const boxes = {};
  for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE - 1; c++) lines[`h-${r}-${c}`] = null;
  for (let r = 0; r < GRID_SIZE - 1; r++) for (let c = 0; c < GRID_SIZE; c++) lines[`v-${r}-${c}`] = null;
  for (let r = 0; r < GRID_SIZE - 1; r++) for (let c = 0; c < GRID_SIZE - 1; c++) boxes[`box-${r}-${c}`] = null;
  return { lines, boxes };
}

const activePlayers = (room) => room.players.filter((p) => !p.left);
const hostId = (room) => activePlayers(room)[0]?.id ?? null;

function publicState(room) {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map(({ token, socketId, ...p }) => p),
    hostId: hostId(room),
    currentTurn: room.currentTurn,
    lines: room.lines,
    boxes: room.boxes,
    winner: room.winner,
    startDelay: room.startDelay,
    turnEndsAt: room.turnEndsAt,
  };
}

function broadcast(room) {
  io.to(room.code).emit('state', publicState(room));
}

function nextActiveTurn(room) {
  const n = room.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (room.currentTurn + step) % n;
    if (!room.players[idx].left) return idx;
  }
  return room.currentTurn;
}

function scheduleTurn(room) {
  clearTimeout(room.timer);
  if (room.status !== 'playing') {
    room.turnEndsAt = null;
    return;
  }
  const ms = room.startDelay * 1000;
  room.turnEndsAt = Date.now() + ms;
  room.timer = setTimeout(() => {
    room.currentTurn = nextActiveTurn(room);
    io.to(room.code).emit('turnTimeout');
    scheduleTurn(room);
    broadcast(room);
  }, ms);
}

function finishGame(room) {
  clearTimeout(room.timer);
  room.status = 'finished';
  room.turnEndsAt = null;
  room.finishedAt = Date.now();
  const ranked = [...activePlayers(room)].sort((a, b) => b.score - a.score);
  const { token, socketId, ...winner } = ranked[0] ?? {};
  room.winner = ranked[0] ? winner : null;
}

function deleteRoom(room) {
  clearTimeout(room.timer);
  rooms.delete(room.code);
}

// Re-numera os jogadores no lobby (ids == índice) e avisa cada socket do seu novo id.
function reindexLobby(room) {
  room.players.forEach((p, i) => {
    p.id = i;
    p.color = COLORS[i];
    const s = p.socketId && io.sockets.sockets.get(p.socketId);
    if (s) {
      s.data.playerId = i;
      s.emit('you', { playerId: i });
    }
  });
}

function attach(socket, room, player) {
  // Se o mesmo jogador estava ligado noutro separador, esse deixa de controlar o lugar.
  if (player.socketId && player.socketId !== socket.id) {
    io.sockets.sockets.get(player.socketId)?.leave(room.code);
  }
  player.socketId = socket.id;
  player.connected = true;
  room.lastSeen = Date.now();
  socket.data.code = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
  return { ok: true, playerId: player.id, state: publicState(room), chat: room.chat };
}

function getContext(socket) {
  const room = rooms.get(socket.data.code);
  if (!room) return null;
  const player = room.players[socket.data.playerId];
  if (!player || player.socketId !== socket.id) return null;
  return { room, player };
}

function removePlayer(room, player) {
  if (room.status === 'waiting') {
    room.players.splice(room.players.indexOf(player), 1);
    reindexLobby(room);
  } else {
    player.left = true;
    player.connected = false;
    if (room.status === 'playing') {
      if (activePlayers(room).length <= 1) finishGame(room);
      else if (room.currentTurn === player.id) {
        room.currentTurn = nextActiveTurn(room);
        scheduleTurn(room);
      }
    }
  }
  if (activePlayers(room).length === 0) deleteRoom(room);
  else broadcast(room);
}

// --- Socket handlers ---

io.on('connection', (socket) => {
  const fail = (ack, error) => typeof ack === 'function' && ack({ ok: false, error });

  socket.on('create', ({ name, token } = {}, ack) => {
    if (!token) return fail(ack, 'Token em falta.');
    const code = newCode();
    const room = {
      code,
      status: 'waiting',
      players: [],
      currentTurn: 0,
      ...emptyBoard(),
      winner: null,
      startDelay: 30,
      turnEndsAt: null,
      timer: null,
      chat: [],
      lastSeen: Date.now(),
    };
    const player = { id: 0, name: cleanName(name), color: COLORS[0], score: 0, token, connected: true, left: false };
    room.players.push(player);
    rooms.set(code, room);
    ack?.(attach(socket, room, player));
  });

  // Entrar numa sala (ou voltar a ela, se o token já lá estiver).
  socket.on('join', ({ code, name, token, resumeOnly } = {}, ack) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return fail(ack, 'Sala não encontrada.');

    const existing = room.players.find((p) => p.token === token && !p.left);
    if (existing) {
      if (name) existing.name = cleanName(name);
      const result = attach(socket, room, existing);
      broadcast(room);
      return ack?.(result);
    }
    if (resumeOnly) return fail(ack, 'Já não estás nesta sala.');
    if (room.status !== 'waiting') return fail(ack, 'Jogo já iniciado.');
    if (room.players.length >= MAX_PLAYERS) return fail(ack, 'Sala cheia.');

    const id = room.players.length;
    const player = { id, name: cleanName(name), color: COLORS[id], score: 0, token, connected: true, left: false };
    room.players.push(player);
    const result = attach(socket, room, player);
    broadcast(room);
    ack?.(result);
  });

  socket.on('leave', (_payload, ack) => {
    const ctx = getContext(socket);
    if (ctx) {
      socket.leave(ctx.room.code);
      socket.data = {};
      removePlayer(ctx.room, ctx.player);
    }
    ack?.({ ok: true });
  });

  socket.on('setDelay', ({ seconds } = {}, ack) => {
    const ctx = getContext(socket);
    if (!ctx || ctx.room.status !== 'waiting' || hostId(ctx.room) !== ctx.player.id) return fail(ack, 'Sem permissão.');
    ctx.room.startDelay = Math.min(300, Math.max(5, Math.round(Number(seconds) || 30)));
    broadcast(ctx.room);
    ack?.({ ok: true });
  });

  socket.on('start', (_payload, ack) => {
    const ctx = getContext(socket);
    if (!ctx || hostId(ctx.room) !== ctx.player.id) return fail(ack, 'Só o líder pode iniciar.');
    const { room } = ctx;
    if (room.status !== 'waiting') return fail(ack, 'Jogo já iniciado.');
    if (room.players.length < 2) return fail(ack, 'São precisos 2 jogadores.');
    Object.assign(room, emptyBoard(), { status: 'playing', currentTurn: 0, winner: null });
    room.players.forEach((p) => (p.score = 0));
    scheduleTurn(room);
    broadcast(room);
    ack?.({ ok: true });
  });

  socket.on('move', ({ lineId } = {}, ack) => {
    const ctx = getContext(socket);
    if (!ctx) return fail(ack, 'Não estás nesta sala.');
    const { room, player } = ctx;
    if (room.status !== 'playing') return fail(ack, 'O jogo não está a decorrer.');
    if (room.currentTurn !== player.id) return fail(ack, 'Não é a tua vez.');
    if (!(lineId in room.lines) || room.lines[lineId] !== null) return fail(ack, 'Jogada inválida.');

    room.lines[lineId] = player.id;

    let captured = 0;
    for (const boxId of Object.keys(room.boxes)) {
      if (room.boxes[boxId] !== null) continue;
      const [, r, c] = boxId.split('-').map(Number);
      const sides = [`h-${r}-${c}`, `h-${r + 1}-${c}`, `v-${r}-${c}`, `v-${r}-${c + 1}`];
      if (sides.every((id) => room.lines[id] !== null)) {
        room.boxes[boxId] = player.id;
        captured++;
      }
    }
    player.score += captured;

    if (Object.values(room.boxes).every((owner) => owner !== null)) {
      finishGame(room);
    } else {
      if (captured === 0) room.currentTurn = nextActiveTurn(room);
      scheduleTurn(room);
    }
    broadcast(room);
    ack?.({ ok: true });
  });

  socket.on('chat', ({ content } = {}, ack) => {
    const ctx = getContext(socket);
    const text = String(content || '').trim().slice(0, 300);
    if (!ctx || !text) return fail(ack, 'Mensagem inválida.');
    const msg = {
      id: randomUUID(),
      player_id: ctx.player.id,
      player_name: ctx.player.name,
      content: text,
      created_at: new Date().toISOString(),
    };
    ctx.room.chat.push(msg);
    if (ctx.room.chat.length > MAX_CHAT_HISTORY) ctx.room.chat.shift();
    io.to(ctx.room.code).emit('chat', msg);
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const ctx = getContext(socket);
    if (!ctx) return;
    ctx.player.connected = false;
    ctx.room.lastSeen = Date.now();
    broadcast(ctx.room);
  });
});

// Limpeza periódica de salas abandonadas ou terminadas.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyoneConnected = room.players.some((p) => p.connected);
    if (room.status === 'finished' && now - room.finishedAt > FINISHED_ROOM_MS) deleteRoom(room);
    else if (!anyoneConnected && now - room.lastSeen > IDLE_ROOM_MS) deleteRoom(room);
  }
}, 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`DotBox a correr na porta ${PORT}`);
});
