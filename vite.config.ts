import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { visualizer } from "rollup-plugin-visualizer";
import {
  writeFileSync,
  statSync,
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
          // #region agent log
          const logData = {
            sessionId: "debug-session",
            runId: "bundle-analysis",
            hypothesisId: "A",
            location: "vite.config.ts:generateBundle",
            message: "Bundle generation started",
            data: {
              outputFormat: options.format,
              bundleKeys: Object.keys(bundle),
              bundleCount: Object.keys(bundle).length,
            },
            timestamp: Date.now(),
          };
          fetch(
            "http://127.0.0.1:7242/ingest/0b4f4d77-e759-49ec-b706-781edfa8b8f5",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(logData),
            },
          ).catch(() => {});
          // #endregion

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

              // #region agent log
              const chunkLogData = {
                sessionId: "debug-session",
                runId: "bundle-analysis",
                hypothesisId: "B",
                location: "vite.config.ts:generateBundle",
                message: "Chunk size analysis",
                data: {
                  fileName,
                  size,
                  sizeKB: (size / 1024).toFixed(2),
                  modules: Object.keys(chunk.modules || {}).slice(0, 10), // Top 10 modules
                  moduleCount: Object.keys(chunk.modules || {}).length,
                },
                timestamp: Date.now(),
              };
              fetch(
                "http://127.0.0.1:7242/ingest/0b4f4d77-e759-49ec-b706-781edfa8b8f5",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(chunkLogData),
                },
              ).catch(() => {});
              // #endregion
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

          // #region agent log
          const topModulesLogData = {
            sessionId: "debug-session",
            runId: "bundle-analysis",
            hypothesisId: "C",
            location: "vite.config.ts:generateBundle",
            message: "Top 20 largest dependencies",
            data: {
              topModules,
              totalModules: Object.keys(moduleSizes).length,
            },
            timestamp: Date.now(),
          };
          fetch(
            "http://127.0.0.1:7242/ingest/0b4f4d77-e759-49ec-b706-781edfa8b8f5",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(topModulesLogData),
            },
          ).catch(() => {});
          // #endregion

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
        writeBundle() {
          // #region agent log
          const writeLogData = {
            sessionId: "debug-session",
            runId: "bundle-analysis",
            hypothesisId: "D",
            location: "vite.config.ts:writeBundle",
            message: "Bundle write completed",
            data: {
              analysisFile: "dist/bundle-analysis.json",
              statsFile: "dist/stats.html",
            },
            timestamp: Date.now(),
          };
          fetch(
            "http://127.0.0.1:7242/ingest/0b4f4d77-e759-49ec-b706-781edfa8b8f5",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(writeLogData),
            },
          ).catch(() => {});
          // #endregion
        },
        closeBundle() {
          // Measure final bundle file sizes
          const distPath = join(process.cwd(), "dist");

          try {
            const files = ["index.html"];
            const fileSizes: Record<string, number> = {};

            for (const file of files) {
              const filePath = join(distPath, file);
              try {
                const stats = statSync(filePath);
                fileSizes[file] = stats.size;
              } catch (e) {
                // File might not exist
              }
            }

            // #region agent log
            const finalSizeLogData = {
              sessionId: "debug-session",
              runId: "bundle-analysis",
              hypothesisId: "E",
              location: "vite.config.ts:closeBundle",
              message: "Final bundle file sizes",
              data: {
                fileSizes: Object.entries(fileSizes).map(([name, size]) => ({
                  name,
                  size,
                  sizeKB: (size / 1024).toFixed(2),
                  sizeMB: (size / 1024 / 1024).toFixed(2),
                })),
              },
              timestamp: Date.now(),
            };
            fetch(
              "http://127.0.0.1:7242/ingest/0b4f4d77-e759-49ec-b706-781edfa8b8f5",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(finalSizeLogData),
              },
            ).catch(() => {});
            // #endregion
          } catch (e) {
            // Ignore errors in measurement
          }
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
