import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'fs';

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8'));
const fechaCompilacion = new Date().toISOString().slice(0, 10);

export default defineConfig({
  // Versión y fecha viajan hasta la interfaz y hasta el DICOM derivado: un mapa
  // exportado tiene que poder rastrearse a la versión que lo calculó.
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_DATE__: JSON.stringify(fechaCompilacion),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png'],
      manifest: {
        name: 'Procesador de difusión — ADC · eADC · cDWI',
        short_name: 'Difusión RM',
        description:
          'Cálculo de mapas ADC, eADC y cDWI a partir de series DICOM de difusión. ' +
          'Las imágenes se procesan en el navegador y no salen del equipo.',
        lang: 'es',
        dir: 'ltr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#12100e',
        theme_color: '#12100e',
        categories: ['medical', 'productivity', 'utilities'],
        icons: [
          { src: 'icono-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icono-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icono-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // El Web Worker de cálculo ronda el megabyte y tiene que estar en caché
        // para que la aplicación siga funcionando sin conexión.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,png,woff2}'],
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    target: 'es2022',
    // Los mapas de origen publicarían el código fuente completo y triplican el
    // peso del despliegue. Para depurar en local: npm run build -- --sourcemap
    sourcemap: false,
  },
});
