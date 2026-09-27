import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Studio is a static app. The browser calls the gateway at VITE_HAMNIVO_API. With an empty value
// it calls its own origin instead, and these servers pass /v1 and /api/auth on to the gateway
// (HAMNIVO_GATEWAY_URL), which keeps every request same-origin. See README.
const gateway = process.env.HAMNIVO_GATEWAY_URL ?? 'http://localhost:4000';
const proxy = {
  '/v1': { target: gateway, changeOrigin: true },
  '/api/auth': { target: gateway, changeOrigin: true },
};

export default defineConfig({
  // Route settings live in tsr.config.json, shared with scripts/generate-routes.mjs.
  plugins: [tanstackRouter(), react(), tailwindcss()],
  build: { target: 'es2022', sourcemap: true },
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 5173, strictPort: true, proxy },
});
