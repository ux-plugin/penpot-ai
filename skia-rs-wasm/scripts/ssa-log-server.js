#!/usr/bin/env node
/**
 * SSA debug log receiver.
 *
 * Listens on http://localhost:9876/log and appends every POST body
 * (one per request) as a line to a log file. The wasm-side
 * `render::ssa::debug` module posts here from inside Paint steps when
 * the runtime-toggleable debug flag is on (set via
 * `set_render_options(debug=1, dpr)`).
 *
 * The wasm uses `mode: 'no-cors'`, so CORS preflight is skipped; we
 * accept anything from anywhere and ignore the response body.
 *
 * Usage:
 *   node scripts/ssa-log-server.js [--out=/path/to/log] [--port=9876]
 *
 * Defaults:
 *   --out  = .ssa-debug.log (in skia-rs-wasm/)
 *   --port = 9876
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }),
);

const PORT = Number(args.port || process.env.SSA_LOG_PORT || 9876);
const OUT = path.resolve(REPO_ROOT, args.out || '.ssa-debug.log');

// Truncate the log on server start so each session is self-contained.
// (Pass --append to keep prior contents.)
if (!args.append) {
  fs.writeFileSync(OUT, '');
}
const out = fs.createWriteStream(OUT, { flags: 'a' });

let count = 0;
const server = http.createServer((req, res) => {
  // No-cors preflight bypass — accept any method on /log.
  if (req.url !== '/log') {
    res.writeHead(404);
    res.end();
    return;
  }
  // Health endpoint hidden behind /log?ping
  if (req.method === 'GET') {
    res.writeHead(200, { 'access-control-allow-origin': '*' });
    res.end(`ok ${count}\n`);
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if (body) {
      const ts = new Date().toISOString();
      out.write(`${ts} ${body}\n`);
      count++;
      if (count % 50 === 0) {
        process.stderr.write(`[ssa-log] ${count} lines\n`);
      }
    }
    res.writeHead(200, { 'access-control-allow-origin': '*' });
    res.end();
  });
  req.on('error', () => {
    res.writeHead(400);
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[ssa-log] listening on http://127.0.0.1:${PORT}/log\n`);
  process.stderr.write(`[ssa-log] writing to ${OUT}\n`);
});

// Flush on exit so trailing lines aren't lost.
process.on('SIGINT', () => {
  out.end(() => process.exit(0));
});
process.on('SIGTERM', () => {
  out.end(() => process.exit(0));
});
