import { io } from 'socket.io-client';

// Mesma origem: em produção o servidor Node serve o site; em dev o Vite faz proxy de /socket.io.
export const socket = io({ autoConnect: false });

type AckResponse<T> = ({ ok: true } & T) | { ok: false; error: string };

export function request<T = {}>(event: string, payload: object = {}): Promise<{ ok: true } & T> {
  return new Promise((resolve, reject) => {
    socket.timeout(10000).emit(event, payload, (err: Error | null, res: AckResponse<T>) => {
      if (err) return reject(new Error('Sem resposta do servidor.'));
      if (!res.ok) return reject(new Error((res as { error: string }).error));
      resolve(res);
    });
  });
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
