# DotBox Multiplayer

Jogo de pontinhos e caixas (Dots and Boxes) para 2 a 7 jogadores, local ou online.

- **Cliente:** React + Vite (PWA), em `App.tsx`
- **Servidor:** Cloudflare Worker (`worker/index.ts`). Cada sala é um Durable Object, que guarda o estado do jogo, fala com os jogadores por WebSocket e controla o tempo de cada turno com alarms.
- O nome do jogador e um token anónimo ficam no `localStorage`. O token permite voltar à mesma sala depois de recarregar a página.
- As salas são apagadas 5 minutos depois de terminar, ou após 10 minutos sem ninguém ligado.

## Correr localmente

```bash
npm install
npm run preview      # build + Worker local em http://localhost:8787
```

Para desenvolver a interface com hot reload: `npm run dev:worker` num terminal e `npm run dev` noutro (http://localhost:3000).

## Deploy

```bash
npx wrangler login   # só da primeira vez
npm run deploy
```

Ou ligar o repositório em Workers & Pages → Create → Import a repository (build: `npm run build`, deploy: `npx wrangler deploy`).
