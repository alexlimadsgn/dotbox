export type Player = {
  id: number;
  name: string;
  color: string;
  score: number;
  connected?: boolean;
  left?: boolean;
};

export type Line = {
  id: string;
  p1: [number, number]; // [row, col]
  p2: [number, number];
  ownerId: number | null;
  orientation: 'horizontal' | 'vertical';
};

export type Box = {
  id: string;
  row: number;
  col: number;
  ownerId: number | null;
};

export type MatchStatus = 'waiting' | 'playing' | 'finished';

// Estado da sala tal como o servidor o envia
export interface RoomState {
  code: string;
  status: MatchStatus;
  players: Player[];
  hostId: number | null;
  currentTurn: number;
  lines: Record<string, number | null>;
  boxes: Record<string, number | null>;
  winner: Player | null;
  startDelay: number;
  turnEndsAt: number | null;
}

export interface ChatMessage {
  id: string;
  player_id: number;
  player_name: string;
  content: string;
  created_at: string;
}
