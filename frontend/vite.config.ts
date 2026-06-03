import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectManifest: {
        // Never precache API or WebSocket responses
        globIgnores: ['**/node_modules/**', '**/api/**'],
      },
      manifest: {
        name: 'Picker — NYSE Intraday Dashboard',
        short_name: 'Picker',
        description: 'Real-time NYSE intraday signals, indicators and AI predictions',
        start_url: '/',
        display: 'standalone',
        background_color: '#0d0d0d',
        theme_color: '#0d0d0d',
        categories: ['finance'],
        icons: [
          {
            src: '/pwa-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      devOptions: {
        enabled: true,
        type: 'module',
      },
    }),
  ],
})
