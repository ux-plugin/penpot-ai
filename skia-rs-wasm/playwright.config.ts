import { defineConfig, devices } from '@playwright/test'

/**
 * Self-contained Playwright config for the perf bench harness.
 *
 * Independent from any test infra in `frontend/playwright`. The
 * `webServer` block spins up the skia-rs-wasm dev server long enough
 * for the perf spec to navigate; `reuseExistingServer` is on locally
 * so iterating on the spec doesn't re-launch vite each time.
 *
 * The test corpus is `test/perf/**\/*.spec.ts`. Browser is locked to
 * Chromium with software GL (`swiftshader`) — counts coming back
 * from the perf snapshot are deterministic regardless of GPU; absolute
 * timings vary, which the diff tool handles via ratio thresholds.
 */
export default defineConfig({
  testDir: './test/perf',
  testMatch: '**/*.spec.ts',
  timeout: 5 * 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: 'test/perf/.results/last-run.json' }],
  ],
  webServer: {
    command: 'pnpm dev --host 127.0.0.1 --port 5173',
    url: 'http://127.0.0.1:5173/perf?ready-check=1',
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  use: {
    baseURL: 'http://127.0.0.1:5173',
    headless: true,
    viewport: { width: 1920, height: 1080 },
    launchOptions: {
      // Default to ANGLE so heavy scenes don't time out on SwiftShader.
      // Override with PERF_GL=swiftshader to force the deterministic
      // software path (slower, but identical across machines).
      args: (process.env.PERF_GL === 'swiftshader'
        ? ['--use-gl=swiftshader', '--enable-features=Vulkan']
        : [
            '--use-angle=default',
            '--enable-unsafe-webgpu',
            '--ignore-gpu-blocklist',
            '--enable-webgl',
            '--enable-accelerated-2d-canvas',
          ]),
    },
  },
  projects: [
    {
      name: 'perf-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
