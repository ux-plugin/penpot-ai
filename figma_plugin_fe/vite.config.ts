import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { visualizer } from "rollup-plugin-visualizer";
import {
  writeFileSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "fs";
import { join, dirname } from "path";

function getPluginId(): string {
  const fromEnv = process.env.VITE_PLUGIN_ID;
  if (fromEnv) return fromEnv;
  try {
    const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return manifest?.id ?? "*";
  } catch {
    return "*";
  }
}

export default defineConfig(({ command, mode }) => {
  const isDebugBuild = process.env.VITE_ENABLE_BUILD_DEBUG === "true";
  const pluginUiUrl = process.env.VITE_PLUGIN_UI_URL as string | undefined;
  const pluginId = getPluginId();

  return {
    plugins: [
      nodePolyfills({
        // Enable polyfills for specific Node.js APIs
        include: ["buffer"],
        globals: {
          Buffer: true,
        },
      }),
      react({
        // Only apply production optimizations during build
        babel:
          command === "build" && !isDebugBuild
            ? {
                plugins: [
                  // Remove PropTypes in production builds only
                  [
                    "babel-plugin-transform-react-remove-prop-types",
                    { removeImport: true },
                  ],
                ],
              }
            : undefined,
      }),
      tailwindcss(),
      viteSingleFile(),
      // Copy skia-rs-wasm WASM assets to dist for plugin
      {
        name: "copy-wasm",
        closeBundle() {
          try {
            const __dirname = dirname(fileURLToPath(import.meta.url));
            const src = join(__dirname, "..", "skia-rs-wasm", "public", "wasm");
            const dest = join(__dirname, "dist", "wasm");
            mkdirSync(dest, { recursive: true });
            for (const name of readdirSync(src)) {
              copyFileSync(join(src, name), join(dest, name));
            }
          } catch (e) {
            console.warn(
              "[copy-wasm] Skip copying WASM (e.g. skia-rs-wasm not present):",
              e,
            );
          }
        },
      },
      // When VITE_PLUGIN_UI_URL is set: write redirect.html and dist/manifest.json for remote UI
      {
        name: "remote-ui-artifacts",
        closeBundle() {
          if (!pluginUiUrl) return;
          const distDir = join(process.cwd(), "dist");
          let redirectTarget = pluginUiUrl.replace(/\/+$/, "");
          try {
            const u = new URL(redirectTarget);
            if (u.hostname === "localhost") {
              u.hostname = "127.0.0.1";
              redirectTarget = u.toString();
            }
          } catch {
            // keep redirectTarget as-is
          }
          const redirectHtml = `<!DOCTYPE html><html><head></head><body><script>window.location.href = ${JSON.stringify(redirectTarget)};</script></body></html>`;
          writeFileSync(join(distDir, "redirect.html"), redirectHtml, "utf-8");
          const manifestPath = join(process.cwd(), "manifest.json");
          const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
          const remoteManifest = { ...manifest, ui: "redirect.html" };
          writeFileSync(join(distDir, "manifest.json"), JSON.stringify(remoteManifest, null, 2), "utf-8");
        },
      },
      // Bundle analyzer - generates stats.html and logs bundle info
      visualizer({
        filename: "./dist/stats.html",
        open: false,
        gzipSize: true,
        brotliSize: true,
      }),
      // Custom plugin to log bundle size information
      {
        name: "bundle-size-logger",
        generateBundle(options, bundle) {
          const bundleInfo: Array<{
            name: string;
            size: number;
            gzipSize?: number;
          }> = [];

          for (const [fileName, chunk] of Object.entries(bundle)) {
            if (chunk.type === "chunk") {
              const size = Buffer.byteLength(chunk.code, "utf8");
              bundleInfo.push({
                name: fileName,
                size,
              });
            } else if (chunk.type === "asset") {
              const size = chunk.source
                ? Buffer.byteLength(chunk.source.toString(), "utf8")
                : 0;
              bundleInfo.push({
                name: fileName,
                size,
              });
            }
          }

          // Log largest dependencies from modules
          const moduleSizes: Record<string, number> = {};
          for (const chunk of Object.values(bundle)) {
            if (chunk.type === "chunk") {
              // Calculate size contribution per module
              const chunkSize = Buffer.byteLength(chunk.code, "utf8");
              const moduleIds = Object.keys(chunk.modules || {});
              const sizePerModule =
                moduleIds.length > 0 ? chunkSize / moduleIds.length : 0;

              for (const moduleId of moduleIds) {
                // Extract package name from node_modules path
                const nodeModulesMatch = moduleId.match(
                  /node_modules\/(@[^/]+\/[^/]+|[^/]+)/,
                );
                if (nodeModulesMatch) {
                  const pkgName = nodeModulesMatch[1];
                  moduleSizes[pkgName] =
                    (moduleSizes[pkgName] || 0) + sizePerModule;
                } else {
                  // For source files, use a more precise match
                  const sourceMatch = moduleId.match(/src\/([^?]+)/);
                  if (sourceMatch) {
                    moduleSizes[`src:${sourceMatch[1]}`] =
                      (moduleSizes[`src:${sourceMatch[1]}`] || 0) +
                      sizePerModule;
                  } else {
                    moduleSizes[moduleId] =
                      (moduleSizes[moduleId] || 0) + sizePerModule;
                  }
                }
              }
            }
          }

          // Sort by size and log top 20
          const topModules = Object.entries(moduleSizes)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 20)
            .map(([name, size]) => ({ name, size: size / 1024 }));

          // Write bundle info to file for analysis
          const totalSize = bundleInfo.reduce(
            (sum, item) => sum + item.size,
            0,
          );
          const bundleReport = {
            totalSize,
            totalSizeKB: (totalSize / 1024).toFixed(2),
            totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
            bundles: bundleInfo.map((item) => ({
              ...item,
              sizeKB: (item.size / 1024).toFixed(2),
            })),
            topModules,
          };

          writeFileSync(
            join(process.cwd(), "dist", "bundle-analysis.json"),
            JSON.stringify(bundleReport, null, 2),
          );
        },
      },
    ],
    build: {
      sourcemap: isDebugBuild ? "inline" : false,
      minify: !isDebugBuild ? "terser" : false,
      terserOptions: !isDebugBuild
        ? {
            compress: {
              drop_console: false, // Keep console.logs
              drop_debugger: true, // Remove debugger statements
              pure_funcs: ["console.info", "console.debug"], // Remove specific console methods (but keep console.log)
              passes: 2, // Run minification twice for better results
            },
            mangle: {
              safari10: true, // Fix Safari 10+ bugs
            },
          }
        : undefined,
      cssMinify: "lightningcss", // Faster CSS minification
      rollupOptions: {
        output: {
          manualChunks: undefined, // Required for viteSingleFile
          // Minimize output size
          inlineDynamicImports: true,
          generatedCode: {
            constBindings: true,
          },
        },
        // Optimize tree shaking
        treeshake: {
          moduleSideEffects: false,
          propertyReadSideEffects: false,
          annotations: true,
        },
      },
      // Optimize chunk size
      chunkSizeWarningLimit: 1000,
      // Better asset handling
      assetsInlineLimit: 4096, // Inline assets smaller than 4kb
      reportCompressedSize: true, // Show gzip size in build output
      // Exclude dev dependencies from bundle
      commonjsOptions: {
        exclude: ["ts-json-schema-generator"],
      },
    },
    resolve: {
      alias: {
        // Penpot-exporter (workspace) aliases – so Vite can resolve when transforming that package’s source
        "@common": fileURLToPath(
          new URL(
            "../skia-rs-wasm/packages/penpot-exporter-figma-plugin/common",
            import.meta.url,
          ),
        ),
        "@plugin": fileURLToPath(
          new URL(
            "../skia-rs-wasm/packages/penpot-exporter-figma-plugin/plugin-src",
            import.meta.url,
          ),
        ),
        // Root alias
        "@": fileURLToPath(new URL("./src", import.meta.url)),

        // Widget environment
        "@widget": fileURLToPath(new URL("./src/widget", import.meta.url)),
        "@widget/stores": fileURLToPath(
          new URL("./src/widget/stores", import.meta.url),
        ),
        "@widget/messaging": fileURLToPath(
          new URL("./src/widget/messaging", import.meta.url),
        ),
        "@widget/utils": fileURLToPath(
          new URL("./src/widget/utils", import.meta.url),
        ),
        "@widget/types": fileURLToPath(
          new URL("./src/widget/types", import.meta.url),
        ),

        // Plugin UI app layer
        "@app": fileURLToPath(new URL("./src/plugin-ui/app", import.meta.url)),
        "@app/providers": fileURLToPath(
          new URL("./src/plugin-ui/app/providers", import.meta.url),
        ),

        // New Plugin UI structure
        "@ui": fileURLToPath(
          new URL("./src/plugin-ui/components/ui", import.meta.url),
        ),
        "@components": fileURLToPath(
          new URL("./src/plugin-ui/components", import.meta.url),
        ),
        "@stores": fileURLToPath(
          new URL("./src/plugin-ui/stores", import.meta.url),
        ),
        "@api": fileURLToPath(new URL("./src/plugin-ui/api", import.meta.url)),
        "@utils": fileURLToPath(
          new URL("./src/plugin-ui/utils", import.meta.url),
        ),

        // Cross-environment shared code
        "@shared-core": fileURLToPath(new URL("./src/shared", import.meta.url)),
        "@shared-types": fileURLToPath(
          new URL("./src/shared/types", import.meta.url),
        ),
        "@shared-constants": fileURLToPath(
          new URL("./src/shared/constants", import.meta.url),
        ),

        // Plugin UI messaging and views
        "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
        "@views": fileURLToPath(
          new URL("./src/plugin-ui/views", import.meta.url),
        ),
        "@assets": fileURLToPath(
          new URL("./src/plugin-ui/assets", import.meta.url),
        ),
      },
    },
    define: {
      PLATFORM: JSON.stringify(mode === "development" ? "dev" : "figma"),
      "import.meta.env.VITE_PLUGIN_ID": JSON.stringify(pluginId),
      // Make Buffer available globally for rsocket libraries
      global: "globalThis",
      // Only set NODE_ENV to production during non-debug builds
      ...(command === "build" &&
        !isDebugBuild && {
          "process.env.NODE_ENV": JSON.stringify("production"),
        }),
    },
    // Optimize dependency pre-bundling
    optimizeDeps: {
      include: ["react", "react-dom", "buffer"],
      esbuildOptions: {
        // Node.js global polyfills for browser
        define: {
          global: "globalThis",
        },
      },
    },
    // Handle WASM files
    assetsInclude: ["**/*.wasm"],
  };
});
