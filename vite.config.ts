import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  // Build id: the arena makes everyone reload when a newer build joins, so all clients run the same simulation.
  define: { __BUILD__: JSON.stringify(Date.now().toString(36).padStart(10, '0')) },
  server: { host: true },
});
