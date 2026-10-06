// Worker DotBox: serve o site (dist/) e encaminha cada sala para o seu Durable Object.
// Cada sala é um GameRoom: guarda o estado no storage, fala com os jogadores por WebSocket
// (com hibernação) e usa um alarm para o tempo de cada turno e para a limpeza da sala.
import { DurableObject } from 'cloudflare:workers';

interface Env {
  ROOMS: DurableObjectNamespace<GameRoom>;
  ASSETS: Fetcher;
}

type Status = 'waiting' | 'playing' | 'finished';

interface RoomPlayer {
  id: number;
  name: string;
  color: string;
  score: number;
  token: string;
  left: boolean;
}

interface Room {
  code: string;
  status: Status;
  players: RoomPlayer[];
  currentTurn: number;
  lines: Record<string, number | null>;
  boxes: Record<string, number | null>;
  winner: Omit<RoomPlayer, 'token'> | null;
  startDelay: number;
  turnEndsAt: number | null;
  chat: ChatMessage[];
  lastSeen: number;
  finishedAt: number | null;
}

interface ChatMessage {
  id: string;
  player_id: number;
  player_name: string;
  content: string;
  created_at: string;
}

type Result = { ok: true; [key: string]: unknown } | { ok: false; error: string };

const GRID_SIZE = 8;
const MAX_PLAYERS = 7;
const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#a855f7', '#ec4899', '#06b6d4'];
const IDLE_ROOM_MS = 10 * 60 * 1000; // sala sem ninguém ligado
const FINISHED_ROOM_MS = 5 * 60 * 1000; // sala terminada
const MAX_CHAT_HISTORY = 100;
const CODE_RE = /^[A-Z0-9]{4}$/;

const cleanName = (name: unknown) => String(name || 'Jogador').trim().slice(0, 12) || 'Jogador';
const fail = (error: string): Result => ({ ok: false, error });

function emptyBoard() {
  const lines: Record<string, number | null> = {};
  const boxes: Record<string, number | null> = {};
  for (let r = 0; r < GRID_SIZE; r++) for (let c = 0; c < GRID_SIZE - 1; c++) lines[`h-${r}-${c}`] = null;
  for (let r = 0; r < GRID_SIZE - 1; r++) for (let c = 0; c < GRID_SIZE; c++) lines[`v-${r}-${c}`] = null;
  for (let r = 0; r < GRID_SIZE - 1; r++) for (let c = 0; c < GRID_SIZE - 1; c++) boxes[`box-${r}-${c}`] = null;
  return { lines, boxes };
}

const stripToken = ({ token, ...p }: RoomPlayer) => p;

export class GameRoom extends DurableObject<Env> {
  room: Room | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<Room>('room')) ?? null;
    });
  }

  // --- RPC: reservar o código para uma sala nova ---
  async claim(code: string): Promise<boolean> {
    if (this.room) return false;
    this.room = {
      code,
      status: 'waiting',
      players: [],
      currentTurn: 0,
      ...emptyBoard(),
      winner: null,
      startDelay: 30,
      turnEndsAt: null,
      chat: [],
      lastSeen: Date.now(),
      finishedAt: null,
    };
    await this.persist();
    return true;
  }

  // --- WebSocket ---
  async fetch(request: Request): Promise<Response> {
    if (!this.room) return new Response('Sala não encontrada.', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Esperado WebSocket.', { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: { id?: number; type?: string; [key: string]: any };
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    const result = this.room ? this.handle(ws, msg.type ?? '', msg) : fail('Sala não encontrada.');
    ws.send(JSON.stringify({ type: 'ack', id: msg.id, ...result }));
    await this.persist();
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, 'bye');
    } catch {}
    if (!this.room) return;
    this.room.lastSeen = Date.now();
    this.broadcast(ws);
    await this.persist();
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011);
  }

  // --- Alarm: fim do tempo do turno e limpeza da sala ---
  async alarm() {
    const room = this.room;
    if (!room) return;
    const now = Date.now();

    if (room.status === 'playing' && room.turnEndsAt !== null && room.turnEndsAt <= now) {
      room.currentTurn = this.nextActiveTurn();
      this.startTurnTimer();
      this.sendAll({ type: 'turnTimeout' });
      this.broadcast();
    }

    const nobodyConnected = this.connectedTokens().size === 0;
    const expiredFinished = room.status === 'finished' && room.finishedAt !== null && now - room.finishedAt > FINISHED_ROOM_MS;
    const expiredIdle = nobodyConnected && now - room.lastSeen > IDLE_ROOM_MS;
    if (expiredFinished || expiredIdle) {
      this.ctx.getWebSockets().forEach((ws) => ws.close(4001, 'Sala encerrada'));
      this.room = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.persist();
  }

  // --- Lógica do jogo ---
  private handle(ws: WebSocket, type: string, msg: Record<string, any>): Result {
    const room = this.room!;
    if (type === 'join') return this.join(ws, msg);

    const player = this.playerFor(ws);
    if (!player) return fail('Não estás nesta sala.');
    const isHost = this.hostId() === player.id;

    switch (type) {
      case 'leave': {
        ws.serializeAttachment(null);
        this.removePlayer(player);
        return { ok: true };
      }

      case 'setDelay': {
        if (room.status !== 'waiting' || !isHost) return fail('Sem permissão.');
        room.startDelay = Math.min(300, Math.max(5, Math.round(Number(msg.seconds) || 30)));
        this.broadcast();
        return { ok: true };
      }

      case 'start': {
        if (!isHost) return fail('Só o líder pode iniciar.');
        if (room.status !== 'waiting') return fail('Jogo já iniciado.');
        if (room.players.length < 2) return fail('São precisos 2 jogadores.');
        Object.assign(room, emptyBoard(), { status: 'playing', currentTurn: 0, winner: null });
        room.players.forEach((p) => (p.score = 0));
        this.startTurnTimer();
        this.broadcast();
        return { ok: true };
      }

      case 'move': {
        const lineId = String(msg.lineId);
        if (room.status !== 'playing') return fail('O jogo não está a decorrer.');
        if (room.currentTurn !== player.id) return fail('Não é a tua vez.');
        if (!(lineId in room.lines) || room.lines[lineId] !== null) return fail('Jogada inválida.');

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
          this.finishGame();
        } else {
          if (captured === 0) room.currentTurn = this.nextActiveTurn();
          this.startTurnTimer();
        }
        this.broadcast();
        return { ok: true };
      }

      case 'chat': {
        const content = String(msg.content || '').trim().slice(0, 300);
        if (!content) return fail('Mensagem inválida.');
        const chatMsg: ChatMessage = {
          id: crypto.randomUUID(),
          player_id: player.id,
          player_name: player.name,
          content,
          created_at: new Date().toISOString(),
        };
        room.chat.push(chatMsg);
        if (room.chat.length > MAX_CHAT_HISTORY) room.chat.shift();
        this.sendAll({ type: 'chat', msg: chatMsg });
        return { ok: true };
      }
    }
    return fail('Pedido desconhecido.');
  }

  // Entrar na sala (ou voltar a ela, se o token já lá estiver).
  private join(ws: WebSocket, msg: Record<string, any>): Result {
    const room = this.room!;
    const token = String(msg.token || '');
    if (!token) return fail('Token em falta.');

    let player = room.players.find((p) => p.token === token && !p.left);
    if (player) {
      if (msg.name) player.name = cleanName(msg.name);
      // O mesmo jogador noutro separador deixa de controlar o lugar.
      for (const other of this.ctx.getWebSockets()) {
        if (other !== ws && other.deserializeAttachment()?.token === token) {
          other.serializeAttachment(null);
          other.close(4000, 'Ligado noutro separador');
        }
      }
    } else {
      if (msg.resumeOnly) return fail('Já não estás nesta sala.');
      if (room.status !== 'waiting') return fail('Jogo já iniciado.');
      if (room.players.length >= MAX_PLAYERS) return fail('Sala cheia.');
      const id = room.players.length;
      player = { id, name: cleanName(msg.name), color: COLORS[id], score: 0, token, left: false };
      room.players.push(player);
    }

    ws.serializeAttachment({ token });
    room.lastSeen = Date.now();
    this.broadcast();
    return { ok: true, playerId: player.id, state: this.publicState(), chat: room.chat };
  }

  private removePlayer(player: RoomPlayer) {
    const room = this.room!;
    if (room.status === 'waiting') {
      room.players.splice(room.players.indexOf(player), 1);
      // Re-numera os jogadores do lobby (id == índice) e avisa cada um do novo id.
      room.players.forEach((p, i) => {
        p.id = i;
        p.color = COLORS[i];
      });
      for (const ws of this.ctx.getWebSockets()) {
        const p = this.playerFor(ws);
        if (p) ws.send(JSON.stringify({ type: 'you', playerId: p.id }));
      }
    } else {
      player.left = true;
      if (room.status === 'playing') {
        if (this.activePlayers().length <= 1) this.finishGame();
        else if (room.currentTurn === player.id) {
          room.currentTurn = this.nextActiveTurn();
          this.startTurnTimer();
        }
      }
    }
    this.broadcast();
  }

  private finishGame() {
    const room = this.room!;
    room.status = 'finished';
    room.turnEndsAt = null;
    room.finishedAt = Date.now();
    const ranked = [...this.activePlayers()].sort((a, b) => b.score - a.score);
    room.winner = ranked[0] ? stripToken(ranked[0]) : null;
  }

  private startTurnTimer() {
    this.room!.turnEndsAt = Date.now() + this.room!.startDelay * 1000;
  }

  private nextActiveTurn() {
    const room = this.room!;
    const n = room.players.length;
    for (let step = 1; step <= n; step++) {
      const idx = (room.currentTurn + step) % n;
      if (!room.players[idx].left) return idx;
    }
    return room.currentTurn;
  }

  // --- Helpers ---
  private activePlayers() {
    return this.room!.players.filter((p) => !p.left);
  }

  private hostId() {
    return this.activePlayers()[0]?.id ?? null;
  }

  private playerFor(ws: WebSocket) {
    const token = ws.deserializeAttachment()?.token;
    return token ? this.room?.players.find((p) => p.token === token && !p.left) : undefined;
  }

  private connectedTokens(exclude?: WebSocket) {
    const tokens = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const token = ws !== exclude && ws.readyState === WebSocket.OPEN ? ws.deserializeAttachment()?.token : null;
      if (token) tokens.add(token);
    }
    return tokens;
  }

  private publicState(exclude?: WebSocket) {
    const room = this.room!;
    const connected = this.connectedTokens(exclude);
    return {
      code: room.code,
      status: room.status,
      players: room.players.map((p) => ({ ...stripToken(p), connected: connected.has(p.token) })),
      hostId: this.hostId(),
      currentTurn: room.currentTurn,
      lines: room.lines,
      boxes: room.boxes,
      winner: room.winner,
      startDelay: room.startDelay,
      turnEndsAt: room.turnEndsAt,
    };
  }

  private sendAll(data: object, exclude?: WebSocket) {
    const payload = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude || !ws.deserializeAttachment()) continue;
      try {
        ws.send(payload);
      } catch {}
    }
  }

  private broadcast(exclude?: WebSocket) {
    this.sendAll({ type: 'state', state: this.publicState(exclude) }, exclude);
  }

  private async persist() {
    const room = this.room;
    if (!room) return;
    await this.ctx.storage.put('room', room);

    // Um único alarm: o mais próximo entre fim do turno e limpeza da sala.
    const candidates: number[] = [];
    if (room.status === 'playing' && room.turnEndsAt !== null) candidates.push(room.turnEndsAt);
    if (room.status === 'finished' && room.finishedAt !== null) candidates.push(room.finishedAt + FINISHED_ROOM_MS + 1000);
    if (this.connectedTokens().size === 0) candidates.push(room.lastSeen + IDLE_ROOM_MS + 1000);
    if (candidates.length) await this.ctx.storage.setAlarm(Math.min(...candidates));
    else await this.ctx.storage.deleteAlarm();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Criar sala: gera um código livre e reserva-o.
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      for (let attempt = 0; attempt < 10; attempt++) {
        const code = Math.random().toString(36).substring(2, 6).toUpperCase().padEnd(4, 'X');
        if (await env.ROOMS.getByName(code).claim(code)) return Response.json({ code });
      }
      return Response.json({ error: 'Não foi possível criar a sala.' }, { status: 503 });
    }

    // Ligação WebSocket à sala.
    const match = url.pathname.match(/^\/ws\/([A-Za-z0-9]+)$/);
    if (match) {
      const code = match[1].toUpperCase();
      if (!CODE_RE.test(code)) return new Response('Código inválido.', { status: 400 });
      return env.ROOMS.getByName(code).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
