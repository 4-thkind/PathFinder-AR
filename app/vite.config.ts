import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vite";

export default defineConfig({
  // getUserMedia only works on a secure origin, so `npm run dev` serves HTTPS
  // to let a phone on the same wifi open the app by LAN IP.
  plugins: [basicSsl()],
  server: {
    host: true,
    https: {},
    // so `npm run dev` talks to the local backend without CORS or a base URL
    proxy: { "/api": { target: "http://127.0.0.1:8000", changeOrigin: true } },
  },
  build: { target: "es2022" },
  // ort resolves its own wasm at runtime; prebundling breaks that resolution
  optimizeDeps: { exclude: ["onnxruntime-web"] },
});
