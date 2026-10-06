// Ligação WebSocket a uma sala (Durable Object no Cloudflare).
// Pedidos levam um id e o servidor responde com { type: 'ack', id, ok, ... };
// os restantes tipos ('state', 'chat', 'you', 'turnTimeout') são eventos.

type Handler = (data: any) => void;
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

const REQUEST_TIMEOUT_MS = 10000;

class GameSocket {
  private ws: WebSocket | null = null;
  private code: string | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  on(event: string, handler: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: Handler) {
    this.handlers.get(event)?.delete(handler);
  }

  private emit(event: string, data?: any) {
    this.handlers.get(event)?.forEach(h => h(data));
  }

  // Liga-se à sala; resolve quando a ligação abre.
  connect(code: string): Promise<void> {
    this.close();
    this.code = code;
    return this.open(false);
  }

  private open(isReconnect: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${location.host}/ws/${this.code}`);
      this.ws = ws;
      let opened = false;

      ws.onopen = () => {
        opened = true;
        this.emit(isReconnect ? 'reconnect' : 'connect');
        resolve();
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'ack') {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error));
        } else if (msg.type === 'state') {
          this.emit('state', msg.state);
        } else if (msg.type === 'chat') {
          this.emit('chat', msg.msg);
        } else {
          this.emit(msg.type, msg);
        }
      };
      ws.onclose = (e) => {
        if (this.ws !== ws) return; // ligação antiga, já substituída
        this.ws = null;
        this.rejectPending();
        if (!opened) return reject(new Error('Sala não encontrada.'));
        this.emit('disconnect', e.code);
        // 4000: aberto noutro separador; 4001: sala encerrada. Nesses casos não volta a ligar.
        if (e.code !== 4000 && e.code !== 4001 && this.code) {
          this.reconnectTimer = setTimeout(() => this.open(true).catch(() => this.emit('lost')), 1500);
        } else {
          this.emit('lost', e.code);
        }
      };
    });
  }

  request<T = {}>(type: string, payload: object = {}): Promise<{ ok: true } & T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Sem ligação ao servidor.'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Sem resposta do servidor.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, type, ...payload }));
    });
  }

  close() {
    this.code = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000);
    this.rejectPending();
  }

  private rejectPending() {
    this.pending.forEach(p => {
      clearTimeout(p.timer);
      p.reject(new Error('Ligação perdida.'));
    });
    this.pending.clear();
  }
}

export const socket = new GameSocket();
export const request = <T = {}>(type: string, payload: object = {}) => socket.request<T>(type, payload);

export async function createRoomCode(): Promise<string> {
  const res = await fetch('/api/rooms', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao criar sala.');
  return data.code;
}

// Identifica este navegador perante o servidor, para voltar ao mesmo lugar após recarregar.
export function getPlayerToken(): string {
  let token = localStorage.getItem('dotbox-player-token');
  if (!token) {
    token = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('dotbox-player-token', token);
  }
  return token;
}
