#!/usr/bin/env node
/**
 * Zero-dependency perf harness for the AR Cricket dev server.
 *
 * Launches headless Chrome (fake webcam, auto-granted permissions) against
 * a running dev/preview server, then measures TWO phases over the page's
 * requestAnimationFrame stream:
 *
 *   1. menu    — idle calibration screen (Canvas + pose pipeline running)
 *   2. batting — clicks PLAY BALL; scripted deliveries, physics worker and
 *                HUD updates all live (fake camera yields no landmarks, so
 *                the avatar runs on the default pose — rendering/physics
 *                cost is representative, tracking math is not)
 *
 * Metrics per phase: frame-time p50/p90/p95/p99, FPS, long-task count,
 * long-task total ms, JS heap delta (allocation-churn proxy), plus the
 * WebGL renderer string and devicePixelRatio for context.
 *
 * Usage:
 *   node scripts/perf-probe.mjs [--url http://localhost:3100] [--seconds 10]
 *                               [--settle 6] [--dpr 2] [--screenshot menu.png] [--json out.json]
 *
 * --dpr emulates a retina-class display via CDP device-metrics override so
 * dpr-dependent renderer costs (Canvas dpr=[1,2]) are measurable headless.
 *
 * Chrome binary: $CHROME_PATH or the standard macOS install location.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const URL_TO_PROBE = opt('url', 'http://localhost:3100');
const SECONDS = Number(opt('seconds', '10'));
const SETTLE = Number(opt('settle', '6'));
const DPR = Number(opt('dpr', '1'));
const SCREENSHOT = opt('screenshot', null);
const JSON_OUT = opt('json', null);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((p) => {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
});

if (!chromePath) {
  console.error('No Chrome binary found. Set CHROME_PATH.');
  process.exit(1);
}

const profileDir = mkdtempSync(path.join(tmpdir(), 'ar-cricket-probe-'));

const chrome = spawn(chromePath, [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--window-size=1440,900',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('Timed out waiting for DevTools endpoint')), 15000);
  chrome.stderr.on('data', (chunk) => {
    buf += chunk.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
  chrome.on('exit', () => reject(new Error(`Chrome exited early:\n${buf}`)));
});

// --- Minimal CDP client over the browser-level WebSocket (flatten mode) ---
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let nextId = 1;
const pending = new Map();
const events = [];
ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    data.error ? reject(new Error(data.error.message)) : resolve(data.result);
  } else if (data.method) {
    events.push(data);
  }
};

const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
if (DPR !== 1) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: DPR, mobile: false,
  }, sessionId);
}
const navStart = Date.now();
await send('Page.navigate', { url: URL_TO_PROBE }, sessionId);

const evaluate = async (expression, awaitPromise = false) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  }, sessionId);
  if (exceptionDetails) {
    throw new Error(`Page eval failed: ${JSON.stringify(exceptionDetails.exception?.description ?? exceptionDetails.text)}`);
  }
  return result.value;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for full readiness: canvas mounted, menu present, and the pose/camera
// warmup overlay gone (MediaPipe CDN scripts + WASM + camera all live).
const bootDeadline = Date.now() + 45000;
let booted = false;
while (Date.now() < bootDeadline) {
  booted = await evaluate(`(() => {
    const canvas = !!document.querySelector('canvas');
    const playBtn = [...document.querySelectorAll('button')].some((b) => /PLAY BALL/i.test(b.textContent ?? ''));
    const warmingUp = /WARMING UP/i.test(document.body?.innerText ?? '');
    return canvas && playBtn && !warmingUp;
  })()`).catch(() => false);
  if (booted) break;
  await sleep(500);
}
if (!booted) {
  console.error('App did not boot within 45s (canvas + PLAY BALL not found).');
  chrome.kill();
  process.exit(1);
}
const bootMs = Date.now() - navStart; // fresh profile = cold-cache CDN cost included

await sleep(SETTLE * 1000); // let MediaPipe warmup + first pose frames settle

const SAMPLER = `(async (seconds) => {
  const dts = [];
  let longTasks = 0;
  let longTaskMs = 0;
  let observer = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { longTasks += 1; longTaskMs += e.duration; }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch { /* longtask unsupported */ }

  let glRenderer = 'unknown';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (gl && ext) glRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  } catch { /* no webgl */ }

  const heapStart = performance.memory ? performance.memory.usedJSHeapSize : 0;
  let heapPrev = heapStart;
  let heapChurn = 0; // sum of positive deltas between samples ≈ allocation rate
  const heapTimer = performance.memory
    ? setInterval(() => {
        const h = performance.memory.usedJSHeapSize;
        if (h > heapPrev) heapChurn += h - heapPrev;
        heapPrev = h;
      }, 250)
    : null;
  const t0 = performance.now();
  let last = t0;
  await new Promise((done) => {
    const tick = (now) => {
      dts.push(now - last);
      last = now;
      if (now - t0 < seconds * 1000) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
  if (observer) observer.disconnect();
  if (heapTimer) clearInterval(heapTimer);
  const heapEnd = performance.memory ? performance.memory.usedJSHeapSize : 0;
  const elapsed = (performance.now() - t0) / 1000;

  const canvas = document.querySelector('canvas');
  const sorted = [...dts].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    frames: dts.length,
    seconds: elapsed,
    fps: dts.length / elapsed,
    p50: pct(0.5), p90: pct(0.9), p95: pct(0.95), p99: pct(0.99),
    longTasks, longTaskMs: Math.round(longTaskMs),
    heapDeltaMB: (heapEnd - heapStart) / 1048576,
    heapChurnMBps: heapChurn / 1048576 / elapsed,
    glRenderer,
    devicePixelRatio: window.devicePixelRatio,
    canvasPixels: canvas ? canvas.width * canvas.height : 0,
  };
})`;

if (SCREENSHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(SCREENSHOT, Buffer.from(shot.data, 'base64'));
}

const menu = await evaluate(`${SAMPLER}(${SECONDS})`, true);

const clicked = await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /PLAY BALL/i.test(x.textContent ?? ''));
  if (b) { b.click(); return true; }
  return false;
})()`);
if (!clicked) console.error('WARN: PLAY BALL button not found — batting phase skipped');
await sleep(2500); // menu exit + scripted run-up (ball bowls at ~1.2s)

const batting = clicked ? await evaluate(`${SAMPLER}(${SECONDS})`, true) : null;

const report = { url: URL_TO_PROBE, seconds: SECONDS, dpr: DPR, bootMs, menu, batting };
console.log(JSON.stringify(report, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v), 2));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));

ws.close();
chrome.kill();
try {
  rmSync(profileDir, { recursive: true, force: true });
} catch { /* OS cleans tmp */ }
process.exit(0);
