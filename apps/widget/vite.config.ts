import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The widget is a static app. The gateway origin comes from VITE_HAMNIVO_API at build time or
// from the `api` query parameter the loader adds.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { target: 'es2022', sourcemap: true },
  server: { port: 5174 },
});
