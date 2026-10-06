# DotBox Multiplayer

Jogo de pontinhos e caixas (Dots and Boxes) para 2 a 7 jogadores, local ou online.

- **Cliente:** React + Vite (PWA)
- **Servidor:** Node + Express + Socket.IO (`server/index.js`). As salas vivem só em memória.
- O nome do jogador e um token anónimo ficam no `localStorage`. O token permite voltar à mesma sala depois de recarregar a página.

## Correr localmente

```bash
npm install
npm run server   # servidor de jogo na porta 3001
npm run dev      # noutro terminal: cliente em http://localhost:3000
```

Para testar como em produção: `npm run build && npm start` e abrir http://localhost:3001.

## Deploy (Render)

Um único **Web Service** serve o site e o WebSocket. A configuração está em `render.yaml`:
- Build: `npm ci --include=dev && npm run build`
- Start: `npm start`
- Health check: `/health`
