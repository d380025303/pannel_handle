import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const PROTOCOL_VERSION = 1;

export default defineConfig({
  plugins: [
    react(),
    {
      name: "pannel-handle-build-manifest",
      closeBundle() {
        fs.writeFileSync(
          path.resolve("dist", "build-manifest.json"),
          JSON.stringify({
            application: "pannel-handle-mobile",
            protocolVersion: PROTOCOL_VERSION,
            builtAt: new Date().toISOString()
          }, null, 2)
        );
      }
    }
  ],
  build: {
    sourcemap: true
  },
  test: {
    environment: "jsdom"
  }
});
