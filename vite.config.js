import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyFile } from "wpsjs/vite_plugins";

export default defineConfig({
  base: "./",
  plugins: [
    copyFile({
      src: "manifest.xml",
      dest: "manifest.xml"
    }),
    react()
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        taskpane: fileURLToPath(new URL("./taskpane.html", import.meta.url)),
        renderSmoke: fileURLToPath(new URL("./render-smoke.html", import.meta.url))
      }
    }
  },
  server: {
    host: "0.0.0.0",
    port: 5173
  }
});
