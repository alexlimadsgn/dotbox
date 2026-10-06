
import { Player } from './types';

export const GRID_SIZE = 8; // Aumentado para 8x8 pontos (7x7 quadrados) para partidas com muitos jogadores

export const PLAYERS_INIT: Player[] = [
  { id: 0, name: 'Jogador 1', color: '#3b82f6', score: 0 }, // Azul
  { id: 1, name: 'Jogador 2', color: '#ef4444', score: 0 }, // Vermelho
  { id: 2, name: 'Jogador 3', color: '#10b981', score: 0 }, // Esmeralda
  { id: 3, name: 'Jogador 4', color: '#f59e0b', score: 0 }, // Âmbar
  { id: 4, name: 'Jogador 5', color: '#a855f7', score: 0 }, // Roxo
  { id: 5, name: 'Jogador 6', color: '#ec4899', score: 0 }, // Rosa
  { id: 6, name: 'Jogador 7', color: '#06b6d4', score: 0 }, // Ciano
];

export const BOX_SIZE = 48; // Reduzido para caber o grid 8x8 em telas padrão
export const DOT_RADIUS = 4; // Ajustado proporcionalmente
