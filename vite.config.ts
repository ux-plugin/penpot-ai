import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [tailwindcss(), viteSingleFile(), react()],
  build: {
    sourcemap: true,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Add define for platform constant
  define: {
    PLATFORM: JSON.stringify(process.env.NODE_ENV === 'development' ? 'dev' : 'figma')
  }
});
