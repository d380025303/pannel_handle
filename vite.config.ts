import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  optimizeDeps: { include: ["./electron/shared/screenshot-shortcut.cjs"] },
  build: { commonjsOptions: { include: [/node_modules/, /electron[\\/]shared/] }, rollupOptions: { input: { main: "index.html", mascot: "mascot.html" } } },
  server: {
    host: "127.0.0.1",
    port: 6173
  }
});
