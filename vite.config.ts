import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { viteSingleFile } from "vite-plugin-singlefile";
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), viteSingleFile(), react()],
  build: {
    sourcemap: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
