import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist", chunkSizeWarningLimit: 4000, target: "es2022" },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8787" } },
});
