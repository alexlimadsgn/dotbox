export type Player = {
  id: number;
  name: string;
  color: string;
  score: number;
  auth_id?: string;
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

export interface Match {
  id: string;
  code: string;
  status: MatchStatus;
  players: Player[];
  current_turn: number;
  winner: Player | null; // stored as JSON
  created_at: string;
  start_delay: number;
}

export interface ChatMessage {
  id: string;
  match_id: string;
  player_id: number;
  player_name: string;
  content: string;
  created_at: string;
};

export type Move = {
  id: string;
  match_id: string;
  player_id: number;
  line_id: string;
  created_at: string;
};
