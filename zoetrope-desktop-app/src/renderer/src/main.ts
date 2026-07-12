import './index.css'

const root = document.querySelector<HTMLDivElement>('#app')!

/**
 * Probe WebGL2 the same way skia-rs-wasm will (high-performance GPU preference).
 * This is the boot smoke test for landmine #4 — if Electron fell back to SwiftShader,
 * the unmasked renderer string says so and we flag it loudly.
 */
function gpuRenderer(): { name: string; software: boolean; webgl2: boolean } {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2', {
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null
    if (!gl) return { name: 'WebGL2 unavailable', software: true, webgl2: false }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const name = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : 'GPU (vendor hidden)'
    const software = /swiftshader|software|llvmpipe|basic render/i.test(name)
    return { name, software, webgl2: true }
  } catch {
    return { name: 'WebGL2 error', software: true, webgl2: false }
  }
}

const gpu = gpuRenderer()
const d = window.desktop

root.innerHTML = `
  <main class="boot">
    <div class="logo">◎</div>
    <h1>Zoetrope <span>Desktop</span></h1>
    <p class="tag">Electron shell · skia-rs-wasm renderer host</p>
    <dl class="diag">
      <div><dt>WebGL2</dt><dd class="${gpu.webgl2 ? 'ok' : 'bad'}">${gpu.webgl2 ? 'available' : 'unavailable'}</dd></div>
      <div><dt>GPU</dt><dd class="${gpu.software ? 'warn' : 'ok'}">${gpu.name}${gpu.software ? ' — software fallback' : ''}</dd></div>
      <div><dt>Device pixel ratio</dt><dd>${window.devicePixelRatio}&times;</dd></div>
      <div><dt>Electron</dt><dd>${d?.versions.electron ?? '—'}</dd></div>
      <div><dt>Chromium</dt><dd>${d?.versions.chrome ?? '—'}</dd></div>
      <div><dt>Platform</dt><dd>${d?.platform ?? '—'}</dd></div>
    </dl>
    <p class="next">Next slice: mount the skia-rs-wasm canvas here.</p>
  </main>
`
