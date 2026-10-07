import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Player, Line, Box, RoomState, ChatMessage } from './types';
import { GRID_SIZE, PLAYERS_INIT, BOX_SIZE, DOT_RADIUS } from './constants';
import { motion, LayoutGroup } from 'framer-motion';
import { socket, request, getPlayerToken, createRoomCode } from './src/lib/socket';

type ViewState = 'menu' | 'lobby' | 'game';

const ROOM_KEY = 'dotbox-room-code';
const DESKTOP_MIN_WIDTH = 1024; // a partir daqui: jogadores à esquerda, chat fixo à direita
const PLAYERS_PANEL_WIDTH = 256;
const CHAT_PANEL_WIDTH = 320;

const createLines = (): Line[] => {
  const result: Line[] = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE - 1; c++) {
      result.push({ id: `h-${r}-${c}`, p1: [r, c], p2: [r, c + 1], ownerId: null, orientation: 'horizontal' });
    }
  }
  for (let r = 0; r < GRID_SIZE - 1; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      result.push({ id: `v-${r}-${c}`, p1: [r, c], p2: [r + 1, c], ownerId: null, orientation: 'vertical' });
    }
  }
  return result;
};

const createBoxes = (): Box[] => {
  const result: Box[] = [];
  for (let r = 0; r < GRID_SIZE - 1; r++) {
    for (let c = 0; c < GRID_SIZE - 1; c++) {
      result.push({ id: `box-${r}-${c}`, row: r, col: c, ownerId: null });
    }
  }
  return result;
};

const App: React.FC = () => {
  // --- Game State ---
  const [numPlayers, setNumPlayers] = useState(2);
  const [players, setPlayers] = useState<Player[]>(PLAYERS_INIT.slice(0, 2));
  const [currentPlayerIdx, setCurrentPlayerIdx] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [winner, setWinner] = useState<Player | null>(null);
  const [scale, setScale] = useState(1);
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.innerWidth >= DESKTOP_MIN_WIDTH);
  const playersWithScores = useMemo(() => {
    return players.map(p => ({
      ...p,
      score: boxes.filter(b => b.ownerId === p.id).length
    }));
  }, [players, boxes]);

  // --- Multiplayer State ---
  const [view, setView] = useState<ViewState>('menu');
  const [roomCode, setRoomCode] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [myPlayerId, setMyPlayerId] = useState<number | null>(null); // Local ID in the room (0, 1, 2...)
  const [hostId, setHostId] = useState<number | null>(null);
  const [isOnline, setIsOnline] = useState(false);
  const [turnEndsAt, setTurnEndsAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const isHost = isOnline && myPlayerId !== null && myPlayerId === hostId;
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('dotbox-theme') as 'light' | 'dark' || 'light';
    }
    return 'light';
  });

  // --- Player Name State ---
  const [playerName, setPlayerName] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('dotbox-player-name') || 'Jogador';
    }
    return 'Jogador';
  });
  const [isEditingName, setIsEditingName] = useState(false);
  const [showSnackbar, setShowSnackbar] = useState(false);

  // --- Chat State ---
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const isChatOpenRef = useRef(isChatOpen);
  const isChatDocked = isOnline && isDesktop;
  isChatOpenRef.current = isChatOpen || isChatDocked;

  // --- Start Delay Config ---
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [startDelay, setStartDelay] = useState(30);
  const [isUpdatingSettings, setIsUpdatingSettings] = useState(false);

  // --- Chat Notification State ---
  const [latestChatMsg, setLatestChatMsg] = useState<ChatMessage | null>(null);

  // --- Turn Timer State ---
  const [timeLeft, setTimeLeft] = useState(30);
  const [showTimeoutAlert, setShowTimeoutAlert] = useState(false);

  useEffect(() => {
    if (isChatOpen) {
      setUnreadCount(0);
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isChatOpen]);

  // --- Body Lock (Prevent background scroll when chat is open on mobile) ---
  useEffect(() => {
    const isMobile = window.innerWidth < 768;
    if (isChatOpen && isMobile) {
      document.body.style.overflow = 'hidden';
      document.body.style.touchAction = 'none'; // Extra measure for mobile
      // Allow overflow on the chat messages container only
      const chatContainer = document.getElementById('chat-messages-container');
      if (chatContainer) chatContainer.style.touchAction = 'auto';
    } else {
      document.body.style.overflow = '';
      document.body.style.touchAction = '';
    }
    return () => {
      document.body.style.overflow = '';
      document.body.style.touchAction = '';
    };
  }, [isChatOpen]);

  // --- Snackbar Helper ---
  const triggerSnackbar = () => {
    setShowSnackbar(true);
    setTimeout(() => setShowSnackbar(false), 2000);
  };

  const triggerTimeoutAlert = () => {
    setShowTimeoutAlert(true);
    setTimeout(() => setShowTimeoutAlert(false), 2000);
  };

  useEffect(() => {
    localStorage.setItem('dotbox-player-name', playerName);
  }, [playerName]);

  // --- Online: aplica o estado enviado pelo servidor ---
  const applyRoomState = useCallback((state: RoomState) => {
    setIsOnline(true);
    setRoomCode(state.code);
    setPlayers(state.players);
    setNumPlayers(state.players.length);
    setHostId(state.hostId);
    setCurrentPlayerIdx(state.currentTurn);
    setStartDelay(state.startDelay);
    setTurnEndsAt(state.turnEndsAt);
    setWinner(state.winner);
    setLines(createLines().map(l => ({ ...l, ownerId: state.lines[l.id] ?? null })));
    setBoxes(createBoxes().map(b => ({ ...b, ownerId: state.boxes[b.id] ?? null })));
    setView(state.status === 'waiting' ? 'lobby' : 'game');
  }, []);

  const enterRoom = useCallback((res: { playerId: number; state: RoomState; chat: ChatMessage[] }) => {
    setMyPlayerId(res.playerId);
    setChatMessages(res.chat);
    applyRoomState(res.state);
    localStorage.setItem(ROOM_KEY, res.state.code);
  }, [applyRoomState]);

  // --- Online: eventos da sala ---
  const connectToRoom = useCallback(async (code: string, payload: object) => {
    await socket.connect(code);
    const res = await request<any>('join', { code, token: getPlayerToken(), ...payload });
    enterRoom(res);
  }, [enterRoom]);

  useEffect(() => {
    // Voltar à sala depois de uma queda de rede.
    const onReconnect = async () => {
      try {
        enterRoom(await request<any>('join', { token: getPlayerToken(), resumeOnly: true }));
      } catch {
        onLost();
      }
    };
    // Sala encerrada, aberta noutro separador, ou impossível voltar a ligar.
    const onLost = () => {
      localStorage.removeItem(ROOM_KEY);
      window.location.reload();
    };
    const onYou = ({ playerId }: { playerId: number }) => setMyPlayerId(playerId);
    const onTimeout = () => triggerTimeoutAlert();
    const onChat = (msg: ChatMessage) => {
      setChatMessages(prev => [...prev, msg]);
      if (!isChatOpenRef.current) {
        setUnreadCount(prev => prev + 1);
        setLatestChatMsg(msg);
        setTimeout(() => setLatestChatMsg(current => (current?.id === msg.id ? null : current)), 4000);
      }
    };

    socket.on('reconnect', onReconnect);
    socket.on('lost', onLost);
    socket.on('state', applyRoomState);
    socket.on('you', onYou);
    socket.on('turnTimeout', onTimeout);
    socket.on('chat', onChat);

    // Ao abrir a página, tenta voltar à sala guardada.
    const savedCode = localStorage.getItem(ROOM_KEY);
    if (savedCode) {
      setLoading(true);
      connectToRoom(savedCode, { resumeOnly: true })
        .catch(() => {
          localStorage.removeItem(ROOM_KEY);
          socket.close();
        })
        .finally(() => setLoading(false));
    }

    return () => {
      socket.off('reconnect', onReconnect);
      socket.off('lost', onLost);
      socket.off('state', applyRoomState);
      socket.off('you', onYou);
      socket.off('turnTimeout', onTimeout);
      socket.off('chat', onChat);
      socket.close();
    };
  }, [applyRoomState, enterRoom, connectToRoom]);

  // --- Turn Timer Logic ---
  // Online: o servidor controla o tempo; aqui só mostramos a contagem.
  useEffect(() => {
    if (!isOnline || !turnEndsAt) return;
    const tick = () => setTimeLeft(Math.max(0, Math.ceil((turnEndsAt - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [isOnline, turnEndsAt]);

  // Local: contagem decrescente no próprio navegador.
  useEffect(() => {
    if (!isOnline && view === 'game' && !winner) {
      setTimeLeft(startDelay);
    }
  }, [currentPlayerIdx, view, winner, startDelay, isOnline]);

  useEffect(() => {
    if (isOnline || view !== 'game' || winner || timeLeft <= 0) return;

    const timer = setInterval(() => {
      setTimeLeft(prev => prev - 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [isOnline, view, winner, timeLeft > 0]);

  useEffect(() => {
    if (!isOnline && view === 'game' && !winner && timeLeft === 0) {
      triggerTimeoutAlert();
      setCurrentPlayerIdx(prev => (prev + 1) % players.length);
    }
  }, [timeLeft, view, winner, isOnline, players.length]);

  // --- Theme Effect ---
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('dotbox-theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  // Responsividade: no mobile o tabuleiro encolhe para caber na largura;
  // no desktop cresce para ocupar o espaço entre o painel dos jogadores e o chat.
  useEffect(() => {
    const handleResize = () => {
      const viewportWidth = document.documentElement.clientWidth;
      const desktop = viewportWidth >= DESKTOP_MIN_WIDTH;
      setIsDesktop(desktop);
      if (view !== 'game') return;
      const rawWidth = (GRID_SIZE - 1) * BOX_SIZE + DOT_RADIUS * 2 + 80; // grid + padding interno do card

      if (desktop) {
        const sidePanels = PLAYERS_PANEL_WIDTH + (isOnline ? CHAT_PANEL_WIDTH : 0);
        const availableWidth = viewportWidth - sidePanels - 64;
        const availableHeight = window.innerHeight - 160; // espaço para o botão e o contador
        setScale(Math.min(1.5, availableWidth / rawWidth, availableHeight / rawWidth));
      } else {
        const availableWidth = viewportWidth - 32; // margem lateral de 16px de cada lado
        setScale(Math.min(1, availableWidth / rawWidth));
      }
    };

    // ResizeObserver apanha o tamanho final mesmo quando o evento 'resize' chega a meio (ex.: rodar o ecrã).
    const observer = new ResizeObserver(handleResize);
    observer.observe(document.documentElement);
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [view, isOnline]);

  // --- Board Initialization (Reset) ---
  const initBoard = useCallback(() => {
    setLines(createLines());
    setBoxes(createBoxes());
  }, []);

  // --- Local Game ---
  const startLocalGame = (count: number) => {
    setIsOnline(false);
    setPlayers(PLAYERS_INIT.slice(0, count).map(p => ({ ...p, score: 0 })));
    setNumPlayers(count);
    setCurrentPlayerIdx(0);
    initBoard();
    setWinner(null);
    setView('game');
  };

  // --- Multiplayer Logic ---

  const runRequest = async (action: () => Promise<void>) => {
    setLoading(true);
    try {
      await action();
    } catch (err: any) {
      console.error(err);
      alert(err.message || 'Erro de ligação ao servidor.');
    } finally {
      setLoading(false);
    }
  };

  // 1. Create Room
  const createRoom = () => runRequest(async () => {
    const code = await createRoomCode();
    await connectToRoom(code, { name: playerName });
  });

  // 2. Join Room
  const joinRoom = () => {
    if (!joinCode) return;
    return runRequest(async () => {
      try {
        await connectToRoom(joinCode.toUpperCase(), { name: playerName });
      } catch (err) {
        socket.close();
        throw err;
      }
    });
  };

  // 3. Leave Room
  const leaveRoom = async () => {
    localStorage.removeItem(ROOM_KEY);
    try {
      if (isOnline) await request('leave');
      socket.close();
    } catch (e) {
      console.error("Error leaving match", e);
    } finally {
      window.location.reload();
    }
  };

  // 4. Start Online Game
  const startOnlineGame = () => {
    if (!isHost) return;
    return runRequest(() => request('start').then(() => undefined));
  };

  const saveSettings = async () => {
    setIsUpdatingSettings(true);
    try {
      await request('setDelay', { seconds: startDelay });
      setIsSettingsOpen(false);
    } catch (err: any) {
      alert(`Erro ao salvar: ${err.message || 'Erro desconhecido'}`);
    } finally {
      setIsUpdatingSettings(false);
    }
  };

  const sendChatMessage = async () => {
    if (!chatInput.trim() || !isOnline) return;
    const content = chatInput.trim();
    setChatInput(''); // Optimistic clear

    try {
      await request('chat', { content });
    } catch (error) {
      console.error("Chat error", error);
      alert("Erro ao enviar mensagem");
    }
  };


  // --- Game Logic (apenas jogo local; online quem decide é o servidor) ---

  const checkBoxes = useCallback((currentLines: Line[], currentBoxes: Box[], activePlayerId: number) => {
    let boxesCapturedInThisTurn = 0;

    const updatedBoxes = currentBoxes.map(box => {
      if (box.ownerId !== null) return box;

      const top = currentLines.find(l => l.id === `h-${box.row}-${box.col}`);
      const bottom = currentLines.find(l => l.id === `h-${box.row + 1}-${box.col}`);
      const left = currentLines.find(l => l.id === `v-${box.row}-${box.col}`);
      const right = currentLines.find(l => l.id === `v-${box.row}-${box.col + 1}`);

      if (top?.ownerId !== null && bottom?.ownerId !== null && left?.ownerId !== null && right?.ownerId !== null) {
        boxesCapturedInThisTurn++;
        return { ...box, ownerId: activePlayerId };
      }
      return box;
    });

    return { captured: boxesCapturedInThisTurn > 0, updatedBoxes };
  }, []);

  const handleLocalMove = (lineId: string, playerId: number) => {
    const lineIndex = lines.findIndex(l => l.id === lineId);
    if (lineIndex === -1 || lines[lineIndex].ownerId !== null) return;

    const newLines = [...lines];
    newLines[lineIndex] = { ...newLines[lineIndex], ownerId: playerId };
    const { captured, updatedBoxes } = checkBoxes(newLines, boxes, playerId);

    setLines(newLines);
    setBoxes(updatedBoxes);
    if (!captured) {
      setCurrentPlayerIdx(prev => (prev + 1) % players.length);
    } else {
      setTimeLeft(startDelay); // Same player plays again
    }
  };

  // --- UI Handlers ---

  const handleLineClick = async (lineId: string) => {
    if (winner) return;

    const line = lines.find(l => l.id === lineId);
    if (!line || line.ownerId !== null) return;

    if (isOnline) {
      if (currentPlayerIdx !== myPlayerId) {
        triggerSnackbar();
        return; // Not my turn
      }
      try {
        await request('move', { lineId });
      } catch (err) {
        console.error('Error submitting move:', err);
      }
    } else {
      handleLocalMove(lineId, players[currentPlayerIdx].id);
    }
  };


  // --- Winner Check (local) ---
  useEffect(() => {
    if (!isOnline && view === 'game' && boxes.length > 0 && boxes.every(b => b.ownerId !== null)) {
      const sorted = [...playersWithScores].sort((a, b) => b.score - a.score);
      setWinner(sorted[0]);
    }
  }, [boxes, playersWithScores, isOnline, view]);

  // --- Views ---

  if (view === 'menu') {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex flex-col items-center justify-center p-4 transition-colors duration-300">
        <div className="absolute top-6 right-6">
          <button
            onClick={toggleTheme}
            className="p-3 bg-white dark:bg-slate-800 rounded-full shadow-lg text-slate-800 dark:text-yellow-400 transition-all hover:scale-110 active:scale-95 border border-slate-100 dark:border-slate-700"
          >
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
        </div>

        <div className="bg-white dark:bg-slate-800 rounded-[2.5rem] shadow-2xl p-8 max-w-lg w-full text-center border border-slate-100 dark:border-slate-700 flex flex-col gap-4 transition-colors">
          <div className="space-y-4">
            <h1 className="text-6xl font-black text-blue-500 dark:text-blue-400 mb-8 tracking-tighter">DOT • BOX</h1>
            <h2 className="text-xl font-bold text-slate-700 dark:text-slate-200">Multiplayer Online</h2>

            {/* Player Name Display/Edit */}
            <div className="flex justify-center items-center gap-2 mb-2">
              {isEditingName ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={playerName}
                    onChange={(e) => setPlayerName(e.target.value)}
                    onBlur={() => setIsEditingName(false)}
                    onKeyDown={(e) => e.key === 'Enter' && setIsEditingName(false)}
                    className="bg-slate-100 dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-1 text-slate-800 dark:text-white font-bold text-sm text-center w-32 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    autoFocus
                    maxLength={12}
                  />
                  <button
                    onClick={() => setIsEditingName(false)}
                    className="p-1 rounded-full bg-green-100 text-green-600 hover:bg-green-200"
                  >
                    <span className="material-symbols-rounded text-base">check</span>
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 cursor-pointer group" onClick={() => setIsEditingName(true)}>
                  <span className="text-slate-500 dark:text-slate-400 font-medium text-sm">Como:</span>
                  <span className="text-slate-800 dark:text-white font-bold text-lg border-b-2 border-transparent group-hover:border-slate-300 transition-all">
                    {playerName}
                  </span>
                  <span className="material-symbols-rounded text-slate-400 text-sm group-hover:text-blue-500 transition-colors">edit</span>
                </div>
              )}
            </div>

            <button
              onClick={createRoom}
              disabled={loading}
              className="w-full h-14 px-8 py-4 bg-slate-900 text-white rounded-full shadow-xl font-black text-xs uppercase tracking-widest hover:bg-slate-800 active:scale-95 transition-all"
            >
              Criar Sala
            </button>

            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Código da Sala"
                value={joinCode}
                onChange={e => setJoinCode(e.target.value.toUpperCase())}
                className="flex-1 min-w-0 bg-slate-50 dark:bg-slate-700 border-2 border-slate-200 dark:border-slate-600 rounded-full px-4 py-4 font-bold text-center uppercase tracking-widest text-slate-700 dark:text-white focus:outline-none focus:border-blue-400 placeholder-slate-400 dark:placeholder-slate-500 transition-colors"
                maxLength={4}
              />
              <button
                onClick={joinRoom}
                disabled={loading || joinCode.length < 4}
                className="h-14 px-4 md:px-8 bg-white text-slate-600 rounded-full shadow-xl hover:bg-slate-50 active:scale-95 transition-all border border-slate-200 flex items-center justify-center shrink-0"
              >
                <span className="md:hidden material-symbols-rounded text-2xl font-normal text-slate-900">login</span>
                <span className="hidden md:inline font-black text-xs uppercase tracking-widest">Entrar</span>
              </button>
            </div>
          </div>

          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-200 dark:border-slate-700"></div></div>
            <div className="relative flex justify-center text-xs uppercase"><span className="bg-white dark:bg-slate-800 px-2 text-slate-400 font-bold transition-colors">Ou Local</span></div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {[2, 3, 4, 5, 6, 7].map(n => (
              <button
                key={n}
                onClick={() => startLocalGame(n)}
                className="py-3 bg-slate-50 dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-200 rounded-full font-bold border border-slate-200 dark:border-slate-600 transition-all"
              >
                {n} <span className="sm:inline hidden">Players</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (view === 'lobby') {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex flex-col items-center justify-center p-4 transition-colors">
        <div className="bg-white dark:bg-slate-800 rounded-[2.5rem] shadow-2xl p-8 max-w-lg w-full text-center border border-slate-100 dark:border-slate-700 transition-colors">
          <h2 className="text-slate-400 font-bold text-sm uppercase mb-2">Código da Sala</h2>
          <div className="text-5xl font-black text-blue-600 dark:text-blue-400 tracking-widest mb-8 font-mono bg-blue-50 dark:bg-slate-900 py-4 rounded-2xl border-2 border-blue-100 dark:border-slate-600 select-all transition-colors">
            {roomCode}
          </div>

          <div className="mb-8">
            <h3 className="text-left text-slate-800 dark:text-white font-bold mb-4 flex items-center justify-between transition-colors">
              Jogadores <span className="text-sm bg-slate-100 dark:bg-slate-700 px-2 py-1 rounded-lg text-slate-500 dark:text-slate-300 transition-colors">{players.length}/7</span>
            </h3>
            <div className="space-y-2">
              {players.map((p, idx) => (
                <div key={idx} className="flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-700 rounded-full border border-slate-100 dark:border-slate-600 transition-colors">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-xs" style={{ backgroundColor: p.color }}>
                    {idx + 1}
                  </div>
                  <div className="font-bold text-slate-700 dark:text-slate-200 flex-1 text-left">
                    {p.name} {idx === myPlayerId && <span className="text-xs text-blue-500 dark:text-blue-400 ml-2">(Você)</span>}
                    {idx === 0 && <span className="text-xs text-amber-500 ml-2">👑 Líder</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {isHost ? (
            <div className="flex gap-2">
              <button
                onClick={startOnlineGame}
                disabled={players.length < 2}
                className="flex-1 py-4 bg-green-500 text-white rounded-2xl font-black text-lg hover:bg-green-600 transition-all active:scale-95 shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Iniciar Partida
              </button>
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="w-14 h-14 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-2xl flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-600 transition-all active:scale-90 border border-slate-200 dark:border-slate-600"
                title="Configurações da Sala"
              >
                <span className="material-symbols-rounded text-2xl">settings</span>
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <div className="text-slate-400 font-medium animate-pulse flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-400"></span>
                Aguardando o líder iniciar...
              </div>
              <div className="text-xs text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider">
                Tempo de Espera: {startDelay}s
              </div>
            </div>
          )}

          {/* Settings Modal (only for Host in Lobby) */}
          {isSettingsOpen && isHost && (
            <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-[60]">
              <div className="bg-white dark:bg-slate-800 rounded-[2.5rem] p-8 max-w-sm w-full shadow-2xl border border-slate-100 dark:border-slate-700">
                <div className="text-4xl mb-4 text-center">⚙️</div>
                <h2 className="text-2xl font-black text-slate-800 dark:text-white mb-2 tracking-tight text-center">Configurações</h2>
                <p className="text-slate-500 dark:text-slate-400 text-sm mb-8 text-center">Defina o tempo que os jogadores esperam após o início.</p>

                <div className="space-y-6 mb-8">
                  <div className="flex flex-col gap-3">
                    <label className="text-xs uppercase font-black tracking-widest text-slate-400 text-center">Tempo de Espera (Segundos)</label>
                    <div className="flex items-center justify-center gap-6">
                      <button
                        onClick={() => setStartDelay(prev => Math.max(5, prev - 5))}
                        className="w-12 h-12 rounded-2xl bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-300 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-600 active:scale-90 transition-all border border-slate-200 dark:border-slate-600 font-black text-xl"
                      >
                        -
                      </button>
                      <div className="text-4xl font-black text-blue-500 w-24 text-center tabular-nums">
                        {startDelay}s
                      </div>
                      <button
                        onClick={() => setStartDelay(prev => Math.min(300, prev + 5))}
                        className="w-12 h-12 rounded-2xl bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-300 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-600 active:scale-90 transition-all border border-slate-200 dark:border-slate-600 font-black text-xl"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  <button
                    onClick={saveSettings}
                    disabled={isUpdatingSettings}
                    className="w-full py-4 bg-blue-600 text-white rounded-2xl font-black text-lg hover:bg-blue-700 transition-all active:scale-95 shadow-lg disabled:opacity-50"
                  >
                    {isUpdatingSettings ? 'Salvando...' : 'Salvar'}
                  </button>
                  <button
                    onClick={() => setIsSettingsOpen(false)}
                    className="w-full py-4 bg-white dark:bg-slate-800 text-slate-400 rounded-2xl font-bold text-sm hover:text-slate-600 transition-all"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </div>
          )}

          <button
            onClick={leaveRoom}
            className="mt-4 text-slate-400 text-sm font-bold hover:text-red-500"
          >
            Sair da Sala
          </button>
        </div>
      </div>
    );
  }

  // --- Game View (Local & Online) ---
  const playerLabel = (p: Player, idx: number) =>
    p.name && p.name.trim() !== '' && p.name !== 'Jogador' && p.name !== `Jogador ${idx + 1}` ? p.name : idx + 1;

  const currentPlayer = players[currentPlayerIdx];
  const boardWidth = (GRID_SIZE - 1) * BOX_SIZE + DOT_RADIUS * 2;

  return (
    <div
      className="min-h-[100dvh] bg-slate-50 dark:bg-slate-900 flex flex-col items-center justify-center px-4 py-6 md:p-8 overflow-hidden transition-colors relative"
      style={isDesktop ? { paddingLeft: PLAYERS_PANEL_WIDTH, paddingRight: isChatDocked ? CHAT_PANEL_WIDTH : 0 } : undefined}
    >
      {/* Logotipo no canto superior esquerdo (mobile; no desktop fica no painel) */}
      {!isDesktop && (
        <div className="fixed top-4 left-4 md:top-8 md:left-8 z-[100] h-10 flex items-center text-xl">
          <span className="font-black tracking-tighter text-blue-500 dark:text-blue-400">DOT • BOX</span>
        </div>
      )}
      {/* Botão Sair no Canto Superior Direito */}
      {!isDesktop && (
      <div className="fixed top-4 right-4 md:top-8 md:right-8 z-[100]">
        <button
          onClick={leaveRoom}
          className="flex items-center gap-2 px-4 py-2 md:px-6 md:py-3 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-full shadow-lg font-black text-[10px] md:text-xs uppercase tracking-widest hover:bg-slate-50 dark:hover:bg-slate-700 active:scale-95 transition-all border border-slate-200 dark:border-slate-700"
        >
          <span className="material-symbols-rounded text-lg md:text-xl">logout</span>
          <span className="hidden sm:inline">Sair</span>
        </button>
      </div>
      )}
      {/* Header: jogador da vez em destaque; os restantes em etiquetas pequenas por baixo.
          O layoutId partilhado faz cada etiqueta deslizar suavemente entre as duas posições. */}
      <LayoutGroup>
        {isDesktop ? (
          <aside
            className="fixed top-0 left-0 bottom-0 z-30 flex flex-col gap-3 p-6 bg-white/60 dark:bg-slate-800/40 border-r border-slate-100 dark:border-slate-800 overflow-y-auto"
            style={{ width: PLAYERS_PANEL_WIDTH }}
          >
            <div className="text-2xl mb-4"><span className="font-black tracking-tighter text-blue-500 dark:text-blue-400">DOT • BOX</span></div>
            <div className="text-xs uppercase font-black tracking-widest text-slate-400 mb-1">Jogadores</div>
            {playersWithScores.filter((_, idx) => idx === currentPlayerIdx).map(p => (
              <motion.div
                key={p.id}
                layoutId={`player-${p.id}`}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                className="relative flex items-center gap-3 p-2 pr-4 rounded-2xl bg-white dark:bg-slate-800 shadow-md overflow-hidden"
                style={{ boxShadow: `0 0 0 2px ${p.color}` }}
              >
                <motion.div layout="position" className="w-10 h-10 shrink-0 rounded-full flex items-center justify-center text-white font-black" style={{ backgroundColor: p.color }}>
                  {p.id + 1}
                </motion.div>
                <motion.div layout="position" className="flex-1 min-w-0">
                  <div className="font-black text-slate-800 dark:text-white truncate">{p.name}{p.id === myPlayerId && isOnline ? ' (Você)' : ''}</div>
                  <div className="text-[10px] uppercase font-black tracking-widest" style={{ color: p.color }}>A jogar</div>
                </motion.div>
                <motion.div layout="position" className="text-3xl font-black text-slate-800 dark:text-white leading-none">{p.score}</motion.div>
                {!winner && (
                  <div className="absolute bottom-0 left-3 right-3 h-1 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                    <div className="h-full bg-red-500 transition-all duration-1000 linear" style={{ width: `${(timeLeft / startDelay) * 100}%` }} />
                  </div>
                )}
              </motion.div>
            ))}
            {playersWithScores.map((p, idx) => idx === currentPlayerIdx ? null : (
              <motion.div
                key={p.id}
                layoutId={`player-${p.id}`}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                className={`flex items-center gap-3 p-1.5 pr-4 rounded-2xl ${p.left ? 'opacity-30' : 'opacity-70'}`}
              >
                <motion.div layout="position" className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-white font-bold text-xs" style={{ backgroundColor: p.color }}>
                  {p.id + 1}
                </motion.div>
                <motion.div layout="position" className="flex-1 min-w-0 font-bold text-sm text-slate-600 dark:text-slate-300 truncate">
                  {p.name}{p.id === myPlayerId && isOnline ? ' (Você)' : ''}
                </motion.div>
                <motion.div layout="position" className="text-lg font-black text-slate-600 dark:text-slate-300 leading-none">{p.score}</motion.div>
              </motion.div>
            ))}

            <div className="mt-auto flex flex-col gap-3 pt-4">
              {isOnline && (
                <div className="text-xs font-bold text-slate-400 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  Sala {roomCode}
                </div>
              )}
              {!isOnline && (
                <button
                  onClick={() => startLocalGame(numPlayers)}
                  className="py-3 bg-slate-900 text-white rounded-full shadow-xl font-black text-xs uppercase tracking-widest hover:bg-slate-800 active:scale-95 transition-all"
                >
                  Reiniciar
                </button>
              )}
              <button
                onClick={leaveRoom}
                className="flex items-center justify-center gap-2 py-3 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-full shadow font-black text-xs uppercase tracking-widest hover:bg-slate-50 dark:hover:bg-slate-700 active:scale-95 transition-all border border-slate-200 dark:border-slate-700"
              >
                <span className="material-symbols-rounded text-lg">logout</span>
                Sair
              </button>
            </div>
          </aside>
        ) : (
        <div className="w-full max-w-6xl flex flex-col items-center gap-3 mb-6">
          {playersWithScores.filter((_, idx) => idx === currentPlayerIdx).map(p => (
            <motion.div
              key={p.id}
              layoutId={`player-${p.id}`}
              transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              className="relative flex items-center gap-3 pl-1.5 pr-4 py-1.5 rounded-full bg-white dark:bg-slate-800 shadow-md overflow-hidden"
              style={{ boxShadow: `0 0 0 2px ${p.color}` }}
            >
              <motion.div
                layout="position"
                className="h-9 min-w-[36px] px-3 rounded-full flex items-center justify-center text-white font-black text-sm shadow-sm"
                style={{ backgroundColor: p.color }}
              >
                {playerLabel(p, p.id)}
              </motion.div>
              <motion.div layout="position" className="text-2xl font-black text-slate-800 dark:text-white leading-none">{p.score}</motion.div>
              {/* Registro visual do tempo no card do jogador atual */}
              {!winner && (
                <div className="absolute bottom-0 left-3 right-3 h-1 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-red-500 transition-all duration-1000 linear"
                    style={{ width: `${(timeLeft / startDelay) * 100}%` }}
                  />
                </div>
              )}
            </motion.div>
          ))}

          <div className="flex flex-wrap justify-center gap-2">
            {playersWithScores.map((p, idx) => idx === currentPlayerIdx ? null : (
              <motion.div
                key={p.id}
                layoutId={`player-${p.id}`}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                className={`flex items-center gap-1.5 pl-0.5 pr-2.5 py-0.5 rounded-full bg-white/70 dark:bg-slate-800/70 ${p.left ? 'opacity-30' : 'opacity-70'}`}
              >
                <motion.div
                  layout="position"
                  className="h-5 min-w-[20px] px-1.5 rounded-full flex items-center justify-center text-white font-bold text-[10px]"
                  style={{ backgroundColor: p.color }}
                >
                  {playerLabel(p, p.id)}
                </motion.div>
                <motion.div layout="position" className="text-xs font-black text-slate-600 dark:text-slate-300 leading-none">{p.score}</motion.div>
              </motion.div>
            ))}
          </div>
        </div>
        )}
      </LayoutGroup>

      {/* Status Bar for Online */}
      {isOnline && !isDesktop && (
        <div className="mb-4 px-4 py-2 bg-white dark:bg-slate-800 rounded-full shadow-sm text-sm font-bold text-slate-500 dark:text-slate-400 flex items-center gap-2 transition-colors">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
          Sala: {roomCode}
          <span className="w-px h-4 bg-slate-200 dark:bg-slate-600 mx-1"></span>
          Você: {players[myPlayerId!]?.name || 'Você'}
        </div>
      )}

      {/* Snackbar Feedback */}
      <div className={`fixed bottom-24 left-1/2 -translate-x-1/2 bg-slate-800 text-white px-6 py-3 rounded-full shadow-lg font-bold text-sm transition-all duration-300 pointer-events-none z-50 ${showSnackbar ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
        Aguarde sua vez
      </div>

      {/* Chat UI */}
      {isOnline && view === 'game' && (
        <>
          {!isChatDocked && (<>
          {/* Floating Chat Button */}
          <button
            onClick={() => setIsChatOpen(!isChatOpen)}
            className={`fixed bottom-6 right-6 w-14 h-14 bg-blue-600 text-white rounded-full shadow-2xl flex items-center justify-center hover:scale-110 active:scale-95 transition-all z-40 ${isChatOpen ? 'md:scale-100 scale-0 opacity-0 md:opacity-100' : 'scale-100 opacity-100'}`}
          >
            <span className="material-symbols-rounded text-3xl">{isChatOpen ? 'close' : 'chat'}</span>
            {unreadCount > 0 && !isChatOpen && (
              <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white shadow-sm ring-2 ring-white">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          {/* Backdrop para mobile */}
          <div
            onClick={() => setIsChatOpen(false)}
            className={`fixed inset-0 bg-slate-900/40 backdrop-blur-[2px] z-40 transition-opacity duration-300 md:hidden ${isChatOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          />

          {/* Chat Message Notification Snackbar */}
          {latestChatMsg && !isChatOpen && (
            <div 
              onClick={() => {
                setIsChatOpen(true);
                setLatestChatMsg(null);
              }}
              className="fixed bottom-24 right-6 left-6 md:left-auto md:w-80 bg-white dark:bg-slate-800 p-3 rounded-2xl shadow-2xl border border-blue-500/30 flex items-center gap-3 animate-in fade-in slide-in-from-bottom-5 cursor-pointer z-40 hover:scale-105 transition-all group"
            >
              <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white shrink-0 shadow-lg group-hover:rotate-12 transition-transform">
                <span className="material-symbols-rounded">chat</span>
              </div>
              <div className="flex-1 overflow-hidden">
                <div className="text-[10px] font-black text-blue-500 uppercase tracking-widest truncate">{latestChatMsg.player_name}</div>
                <div className="text-sm font-bold text-slate-700 dark:text-slate-200 truncate">{latestChatMsg.content}</div>
              </div>
              <div className="w-1 h-8 bg-blue-500/20 rounded-full" />
            </div>
          )}
          </>)}

          {/* Chat Window */}
          <div
            className={isChatDocked
              ? 'fixed z-30 top-0 right-0 bottom-0 flex flex-col bg-white dark:bg-slate-800 border-l border-slate-100 dark:border-slate-700 overflow-hidden'
              : `fixed z-50 transition-all duration-300 ease-in-out flex flex-col bg-white dark:bg-slate-800 shadow-2xl border-t md:border border-slate-100 dark:border-slate-700 overflow-hidden
              ${isChatOpen
                ? 'translate-y-0 opacity-100'
                : 'translate-y-full opacity-0 pointer-events-none md:translate-y-0 md:scale-95'
              }
              bottom-0 left-0 right-0 w-full h-[70vh] rounded-none
              md:bottom-24 md:right-6 md:left-auto md:w-80 md:h-[400px] md:rounded-none md:origin-bottom-right
            `}
            style={isChatDocked ? { width: CHAT_PANEL_WIDTH } : undefined}
          >
            {/* Mobile Handle - Hit area expanded */}
            <div
              onClick={() => setIsChatOpen(false)}
              className="w-full py-3 md:hidden cursor-pointer group"
            >
              <div className="w-12 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full mx-auto group-active:scale-90 transition-transform" />
            </div>

            <div className="bg-white dark:bg-slate-900 p-4 md:p-3 border-b border-slate-100 dark:border-slate-800 font-bold text-slate-800 dark:text-slate-200 flex justify-between items-center transition-colors">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                <span>Chat em Tempo Real</span>
              </div>
              <button
                onClick={() => setIsChatOpen(false)}
                className="md:hidden w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 hover:bg-slate-200 transition-colors"
              >
                <span className="material-symbols-rounded text-lg">close</span>
              </button>
              <span className="hidden md:block text-[10px] uppercase tracking-widest text-slate-400">Ao Vivo</span>
            </div>

            <div
              id="chat-messages-container"
              className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50 dark:bg-slate-800/50 overscroll-contain"
            >
              {chatMessages.length === 0 && (
                <div className="text-center text-slate-400 text-sm italic mt-10">Nenhuma mensagem ainda.</div>
              )}
              {chatMessages.map((msg, idx) => {
                const isMe = msg.player_id === myPlayerId;
                const showHeader = idx === 0 || chatMessages[idx - 1].player_id !== msg.player_id;

                return (
                  <div key={msg.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'} ${showHeader ? 'mt-2' : 'mt-0.5'}`}>
                    {showHeader && (
                      <div className={`text-[10px] mb-1 font-bold ${isMe ? 'text-blue-500' : 'text-slate-500'}`}>
                        {isMe ? 'Você' : msg.player_name}
                      </div>
                    )}
                    <div className={`px-4 py-2 text-sm max-w-[85%] break-words rounded-2xl ${isMe ? 'bg-blue-600 text-white rounded-tr-none' : 'bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-600 shadow-sm rounded-tl-none'}`}>
                      {msg.content}
                    </div>
                  </div>
                );
              })}
              <div ref={chatEndRef} />
            </div>

            <div className="p-3 bg-white dark:bg-slate-800 border-t border-slate-100 dark:border-slate-700 flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendChatMessage()}
                placeholder="Digite sua mensagem..."
                className="flex-1 bg-slate-100 dark:bg-slate-900 border-none rounded-full px-4 text-sm focus:ring-2 focus:ring-blue-500 outline-none dark:text-white"
              />
              <button
                onClick={sendChatMessage}
                disabled={!chatInput.trim()}
                className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg transition-all active:scale-95"
              >
                <span className="material-symbols-rounded text-sm">send</span>
              </button>
            </div>
          </div>
        </>
      )}

      {/* Board */}
      <div
        className="flex items-center justify-center"
        style={{ width: (boardWidth + 80) * scale, height: (boardWidth + 80) * scale }}
      >
        <div
          className={`relative shrink-0 flex items-center justify-center bg-white dark:bg-slate-800 p-10 rounded-[3rem] shadow-2xl transition-[border-color,box-shadow] duration-500 border-4 ${
            (isOnline ? myPlayerId === currentPlayerIdx : true) && !winner
              ? 'border-red-500/40 dark:border-red-500/30 shadow-[0_0_50px_-12px_rgba(239,68,68,0.3)]'
              : 'border-white dark:border-slate-800 shadow-slate-200/50 dark:shadow-black/20'
          }`}
          style={{
            width: (boardWidth + 80),
            height: (boardWidth + 80),
            transform: `scale(${scale})`,
          }}
        >
          <div className="relative" style={{ width: boardWidth, height: boardWidth }}>
            {/* Boxes */}
            {boxes.map(box => {
              const boxOwner = players.find(p => p.id === box.ownerId);
              return (
                <div
                  key={box.id}
                  className="absolute"
                  style={{
                    left: box.col * BOX_SIZE + DOT_RADIUS,
                    top: box.row * BOX_SIZE + DOT_RADIUS,
                    width: BOX_SIZE,
                    height: BOX_SIZE,
                    backgroundColor: box.ownerId !== null ? boxOwner?.color : 'transparent',
                    opacity: box.ownerId !== null ? 0.35 : 0,
                    borderRadius: '6px',
                    zIndex: 0
                  }}
                />
              );
            })}

            {/* Lines */}
            {lines.map(line => {
              const isHorizontal = line.orientation === 'horizontal';
              const isActive = line.ownerId !== null;
              const lineOwner = players.find(p => p.id === line.ownerId);
              const ownerColor = isActive ? lineOwner?.color : '#f1f5f9';

              return (
                <div
                  key={line.id}
                  onClick={() => handleLineClick(line.id)}
                  className={`absolute group cursor-pointer ${isActive ? 'cursor-default' : 'hover:scale-105'}`}
                  style={{
                    left: line.p1[1] * BOX_SIZE + DOT_RADIUS + (isHorizontal ? 4 : -5),
                    top: line.p1[0] * BOX_SIZE + DOT_RADIUS + (isHorizontal ? -5 : 4),
                    width: isHorizontal ? BOX_SIZE - 8 : 10,
                    height: isHorizontal ? 10 : BOX_SIZE - 8,
                    zIndex: 10
                  }}
                >
                  <div
                    className={`w-full h-full rounded-full ${!isActive ? 'group-hover:bg-slate-200' : ''}`}
                    style={{
                      backgroundColor: isActive ? ownerColor : undefined,
                    }}
                  />
                </div>
              );
            })}

            {/* Dots */}
            {Array.from({ length: GRID_SIZE }).map((_, r) => (
              Array.from({ length: GRID_SIZE }).map((_, c) => (
                <div
                  key={`dot-${r}-${c}`}
                  className="absolute bg-slate-400 rounded-full shadow-sm"
                  style={{
                    left: c * BOX_SIZE,
                    top: r * BOX_SIZE,
                    width: DOT_RADIUS * 2,
                    height: DOT_RADIUS * 2,
                    zIndex: 20
                  }}
                />
              ))
            ))}
          </div>
        </div>
      </div>

      {/* Winner Modal */}
      {winner && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-[2.5rem] p-12 max-w-sm w-full shadow-2xl text-center">
            <div className="text-7xl mb-6">🎉</div>
            <h2 className="text-4xl font-black text-slate-800 mb-2 tracking-tight">Vencedor!</h2>
            <div className="text-xl font-bold mb-8 p-3 rounded-2xl text-white" style={{ backgroundColor: winner.color }}>
              {winner.name}
              <span className="block text-sm opacity-80">{winner.score} pontos</span>
            </div>
            <button
              onClick={leaveRoom}
              className="w-full py-5 bg-slate-900 text-white rounded-3xl font-black text-lg hover:bg-slate-800 transition-all active:scale-95 shadow-lg"
            >
              Menu Principal
            </button>
          </div>
        </div>
      )}

      {/* Floating Controls */}
      <div className="w-full flex justify-center gap-4 mt-4 mb-4">
        {!isOnline && !isDesktop && (
          <button
            onClick={() => startLocalGame(numPlayers)}
            className="px-8 py-4 bg-slate-900 text-white rounded-full shadow-xl font-black text-xs uppercase tracking-widest hover:bg-slate-800 active:scale-95 transition-all"
          >
            Reiniciar
          </button>
        )}
      </div>

      {/* Timeout Alert */}
      {showTimeoutAlert && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-red-600 text-white px-8 py-3 rounded-full shadow-2xl font-black text-lg animate-bounce z-[60]">
          Acabou a vez! ⏰
        </div>
      )}

      {/* Turn Countdown (Only for active player) */}
      {view === 'game' && !winner && (isOnline ? myPlayerId === currentPlayerIdx : true) && (
        <div
          style={isDesktop ? { left: `calc(${PLAYERS_PANEL_WIDTH}px + (100% - ${PLAYERS_PANEL_WIDTH + (isChatDocked ? CHAT_PANEL_WIDTH : 0)}px) / 2)` } : undefined}
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2 rounded-full shadow-xl transition-all duration-500 z-50 border border-white/5 ${timeLeft < 10 ? 'bg-red-600 animate-pulse scale-105' : 'bg-slate-900 shadow-red-500/10'}`}>
          <div className="flex items-center gap-1.5">
            <span className="material-symbols-rounded text-red-500 text-lg">alarm</span>
            <span className="text-white font-black text-lg tabular-nums tracking-tighter">{timeLeft}s</span>
          </div>
          <div className="w-16 h-1 bg-white/10 rounded-full overflow-hidden">
            <div 
              className="h-full bg-red-500 transition-all duration-1000 linear" 
              style={{ width: `${(timeLeft / startDelay) * 100}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
