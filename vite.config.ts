import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from "node:url";
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig(({ command, mode }) => ({
  plugins: [
    nodePolyfills({
      // Enable polyfills for specific Node.js APIs
      include: ['buffer'],
      globals: {
        Buffer: true,
      },
    }),
    react({
      // Only apply production optimizations during build
      babel: command === 'build' ? {
        plugins: [
          // Remove PropTypes in production builds only
          ['babel-plugin-transform-react-remove-prop-types', { removeImport: true }]
        ]
      } : undefined
    }),
    tailwindcss(),
    viteSingleFile()
  ],
  build: {
    sourcemap: false,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: false, // Keep console.logs
        drop_debugger: true, // Remove debugger statements
        pure_funcs: ['console.info', 'console.debug'], // Remove specific console methods (but keep console.log)
        passes: 2 // Run minification twice for better results
      },
      mangle: {
        safari10: true // Fix Safari 10+ bugs
      }
    },
    cssMinify: 'lightningcss', // Faster CSS minification
    rollupOptions: {
      output: {
        manualChunks: undefined, // Required for viteSingleFile
        // Minimize output size
        inlineDynamicImports: true,
        generatedCode: {
          constBindings: true
        }
      },
      // Optimize tree shaking
      treeshake: {
        moduleSideEffects: false,
        propertyReadSideEffects: false,
        annotations: true
      }
    },
    // Optimize chunk size
    chunkSizeWarningLimit: 1000,
    // Better asset handling
    assetsInlineLimit: 4096, // Inline assets smaller than 4kb
    reportCompressedSize: true // Show gzip size in build output
  },
  resolve: {
    alias: {
      // Root alias
      "@": fileURLToPath(new URL("./src", import.meta.url)),

      // Widget environment
      "@widget": fileURLToPath(new URL("./src/widget", import.meta.url)),
      "@widget/stores": fileURLToPath(new URL("./src/widget/stores", import.meta.url)),
      "@widget/messaging": fileURLToPath(new URL("./src/widget/messaging", import.meta.url)),
      "@widget/utils": fileURLToPath(new URL("./src/widget/utils", import.meta.url)),
      "@widget/types": fileURLToPath(new URL("./src/widget/types", import.meta.url)),

      // Plugin UI app layer
      "@app": fileURLToPath(new URL("./src/plugin-ui/app", import.meta.url)),
      "@app/providers": fileURLToPath(new URL("./src/plugin-ui/app/providers", import.meta.url)),

      // New Plugin UI structure
      "@ui": fileURLToPath(new URL("./src/plugin-ui/components/ui", import.meta.url)),
      "@components": fileURLToPath(new URL("./src/plugin-ui/components", import.meta.url)),
      "@stores": fileURLToPath(new URL("./src/plugin-ui/stores", import.meta.url)),
      "@api": fileURLToPath(new URL("./src/plugin-ui/api", import.meta.url)),
      "@utils": fileURLToPath(new URL("./src/plugin-ui/utils", import.meta.url)),

      // Cross-environment shared code
      "@shared-core": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@shared-types": fileURLToPath(new URL("./src/shared/types", import.meta.url)),
      "@shared-constants": fileURLToPath(new URL("./src/shared/constants", import.meta.url)),

      // Plugin UI messaging and views
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@views": fileURLToPath(new URL("./src/plugin-ui/views", import.meta.url)),
      "@assets": fileURLToPath(new URL("./src/plugin-ui/assets", import.meta.url))
    }
  },
  define: {
    PLATFORM: JSON.stringify(mode === 'development' ? 'dev' : 'figma'),
    // Make Buffer available globally for rsocket libraries
    global: 'globalThis',
    // Only set NODE_ENV to production during builds
    ...(command === 'build' && {
      'process.env.NODE_ENV': JSON.stringify('production')
    })
  },
  // Optimize dependency pre-bundling
  optimizeDeps: {
    include: ['react', 'react-dom', 'buffer'],
    exclude: [],
    esbuildOptions: {
      // Node.js global polyfills for browser
      define: {
        global: 'globalThis'
      }
    }
  }
}));
