import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `vite build web` -> web/dist, served by the API server. `vite web` proxies API calls to a locally running server.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000', '/s': 'http://127.0.0.1:3000' } },
});
