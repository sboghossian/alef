import { defineConfig } from "vite";

// ALEF_CLIENT_PORT / ALEF_PORT: run a second copy beside the real one (defaults 5178 / 5179).
const serverPort = Number(process.env.ALEF_PORT) || 5179;

export default defineConfig({
  root: "client",
  server: {
    port: Number(process.env.ALEF_CLIENT_PORT) || 5178,
    strictPort: true,
    proxy: {
      "/api": `http://localhost:${serverPort}`,
      "/ws": { target: `ws://localhost:${serverPort}`, ws: true },
    },
  },
});
