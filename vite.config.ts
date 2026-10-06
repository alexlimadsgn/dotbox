import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
      // Em dev, o Worker corre à parte (npm run dev:worker) na porta 8787
      proxy: {
        '/api': 'http://localhost:8787',
        '/ws': { target: 'ws://localhost:8787', ws: true },
      },
    },
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.png', 'apple-touch-icon.png', 'masked-icon.svg'],
        workbox: {
          // As rotas do Worker nunca devem ser servidas pelo service worker
          navigateFallbackDenylist: [/^\/api\//, /^\/ws\//],
        },
        manifest: {
          name: 'Dotbox Multiplayer',
          short_name: 'Dotbox',
          description: 'Jogo de Pontinhos e Caixas Multiplayer',
          theme_color: '#ffffff',
          background_color: '#F8FAFC',
          display: 'standalone',
          icons: [
            {
              src: '/favicon.png',
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: '/favicon.png',
              sizes: '512x512',
              type: 'image/png'
            }
          ]
        }
      })
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
