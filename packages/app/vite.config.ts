import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { deferredEntries } from "./deferred-entries";

export default defineConfig(() => {
  const apiPort = parseInt(process.env.API_PORT || "3001", 10);

  return {
    base: "./",
    plugins: [tailwindcss(), react(), deferredEntries()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    build: {
      outDir: "dist",
      cssCodeSplit: false,
      chunkSizeWarningLimit: 1000,
    },
    server: {
      proxy: {
        "/api": `http://localhost:${apiPort}`,
      },
    },
  };
});
