import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@pannel/screenshot-shortcut": fileURLToPath(new URL("./electron/shared/screenshot-shortcut.cjs", import.meta.url))
    }
  },
  optimizeDeps: { include: ["@pannel/screenshot-shortcut"] },
  build: { commonjsOptions: { include: [/node_modules/, /electron[\\/]shared/] }, rollupOptions: { input: { main: "index.html", mascot: "mascot.html" } } },
  server: {
    host: "127.0.0.1",
    port: 6173
  }
});
