/**
 * Headless sanity check for services/soundEffects.ts — the zero-asset procedural
 * SFX layer, driven through a fake Web Audio environment so the graph can be
 * read back as data. The modules are never modified here.
 *
 * Eight checks:
 *   1. shape            - the five public functions exist; isSfxMuted() starts false
 *   2. mute state       - setSfxMuted(true)/false flips isSfxMuted()
 *   3. muted silence    - with mute on, all three calls create zero nodes
 *   4. middled crack    - playBatImpact(0.9, 140): triangle 210 -> 95, bandpass 1100
 *   5. edge snick       - playBatImpact(0.1, 140): highpass 2800, no oscillator
 *   6. stump shatter    - three bandpass bursts at 420/550/680, offsets 0/0.028/0.065
 *   7. crowd swell      - ambient gain ramped to 0.85 over 0.15 s, back to 0.3 over 2.8 s
 *   8. degrade          - a throwing AudioContext warns once and never throws
 *
 * Run: npm run verify:sfx
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'node_modules', '.cache', 'sound-effects');

/**
 * The TypeScript compiler API runs in-process, which is what the other verify
 * scripts use when esbuild's child process is refused by the sandbox. The
 * runtime import specifier has to carry the .mjs extension Node ESM needs.
 */
async function transpileToCache(relPath, outDir) {
  const ts = await import('typescript');
  const source = await fs.readFile(path.join(root, relPath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { target: 'ES2022', module: 'ESNext' },
  }).outputText.replace(/from\s+['"](\.[^'"]*)['"]/g, (_m, spec) => {
    const dep = path.basename(spec).replace(/\.ts$/, '');
    return `from './${dep}.mjs'`;
  });
  await fs.mkdir(outDir, { recursive: true });
  const outfile = path.join(outDir, path.basename(relPath).replace(/\.ts$/, '.mjs'));
  await fs.writeFile(outfile, js);
  return outfile;
}

/* ---- fake Web Audio environment ---- */

const createdNodes = [];
const createdBuffers = [];
/** The ambient gain stage, captured when ambientAudio's ensureContext builds it. */
let ambientGain = null;

const DEFAULT_TYPE = {
  destination: 'destination',
  gain: 'gain',
  bufferSource: 'bufferSource',
  oscillator: 'sine',
  filter: 'lowpass',
};

function makeParam(node, name) {
  let current = 0;
  const calls = [];
  const param = {
    name,
    calls,
    setValueAtTime(value, time) {
      calls.push({ name: 'setValueAtTime', value, time });
      current = value;
      return param;
    },
    linearRampToValueAtTime(value, time) {
      calls.push({ name: 'linearRampToValueAtTime', value, time });
      current = value;
      return param;
    },
    exponentialRampToValueAtTime(value, time) {
      calls.push({ name: 'exponentialRampToValueAtTime', value, time });
      current = value;
      return param;
    },
    cancelScheduledValues(time) {
      calls.push({ name: 'cancelScheduledValues', value: null, time });
      return param;
    },
  };
  Object.defineProperty(param, 'value', {
    get: () => current,
    set: (v) => {
      calls.push({ name: 'value', value: v, time: node.ctx.currentTime });
      current = v;
    },
    enumerable: true,
  });
  return param;
}

function makeNode(ctx, kind, { record = true } = {}) {
  const node = {
    kind,
    type: DEFAULT_TYPE[kind],
    ctx,
    connects: [],
    startCalls: [],
    stopCalls: [],
  };
  if (kind === 'gain') node.gain = makeParam(node, 'gain');
  if (kind === 'oscillator') node.frequency = makeParam(node, 'frequency');
  if (kind === 'filter') {
    node.frequency = makeParam(node, 'frequency');
    node.Q = makeParam(node, 'Q');
  }
  node.connect = (target) => {
    node.connects.push(target);
    return target;
  };
  node.start = (...args) => {
    node.startCalls.push({ args, t: args[0] });
  };
  node.stop = (...args) => {
    node.stopCalls.push({ args, t: args[0] });
  };

  if (record) {
    createdNodes.push(node);
    if (kind === 'gain' && !ambientGain) ambientGain = node;
  }
  return node;
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.sampleRate = 48000;
    this.destination = makeNode(this, 'destination', { record: false });
  }

  async resume() {
    return this;
  }

  createGain() {
    return makeNode(this, 'gain');
  }

  createOscillator() {
    return makeNode(this, 'oscillator');
  }

  createBufferSource() {
    return makeNode(this, 'bufferSource');
  }

  createBiquadFilter() {
    return makeNode(this, 'filter');
  }

  createBuffer(channels, frames, rate) {
    const data = new Float32Array(frames);
    const buffer = {
      numberOfChannels: channels,
      length: frames,
      sampleRate: rate,
      getChannelData: () => data,
    };
    createdBuffers.push(buffer);
    return buffer;
  }
}

const resetLog = () => {
  createdNodes.length = 0;
  createdBuffers.length = 0;
};

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const byKind = (kind) => createdNodes.filter((n) => n.kind === kind);

/* ambientAudio reads window.AudioContext lazily inside ensureContext, so the
 * fake environment must be installed before the modules are imported. */
const realWindow = globalThis.window;
const realSetTimeout = globalThis.setTimeout;
const realWarn = console.warn;
globalThis.window = { AudioContext: FakeAudioContext };

const sfxOut = await transpileToCache('services/soundEffects.ts', cacheDir);
await transpileToCache('services/ambientAudio.ts', cacheDir);
const sfx = await import(pathToFileURL(sfxOut).href);
const { playBatImpact, playStumpShatter, swellCrowd, setSfxMuted, isSfxMuted } = sfx;

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (err) {
    throw new Error(`check "${name}" failed: ${err && err.message ? err.message : String(err)}`);
  }
}

/* 1. shape */
await check('shape', () => {
  for (const [name, fn] of [
    ['playBatImpact', playBatImpact],
    ['playStumpShatter', playStumpShatter],
    ['swellCrowd', swellCrowd],
    ['setSfxMuted', setSfxMuted],
    ['isSfxMuted', isSfxMuted],
  ]) {
    assert.equal(typeof fn, 'function', `${name} is not a function`);
  }
  assert.equal(isSfxMuted(), false, `isSfxMuted() should start false, got ${isSfxMuted()}`);
});

/* 2. mute state */
await check('mute-state', () => {
  setSfxMuted(true);
  assert.equal(isSfxMuted(), true, 'setSfxMuted(true) did not make isSfxMuted() true');
  setSfxMuted(false);
  assert.equal(isSfxMuted(), false, 'setSfxMuted(false) did not make isSfxMuted() false again');
});

/* 3. muted silence */
await check('muted-silence', () => {
  setSfxMuted(true);
  resetLog();
  playBatImpact(0.9, 140);
  playStumpShatter();
  swellCrowd(1);
  assert.equal(createdNodes.length, 0, `muted calls created ${createdNodes.length} nodes`);
  setSfxMuted(false);
});

/* 4. middled crack */
await check('middled-crack', () => {
  resetLog();
  playBatImpact(0.9, 140);

  const oscs = byKind('oscillator');
  assert.equal(oscs.length, 1, `expected 1 oscillator, got ${oscs.length}`);
  assert.equal(oscs[0].type, 'triangle', `oscillator type is ${oscs[0].type}, expected triangle`);

  const freqCalls = oscs[0].frequency.calls;
  assert.ok(
    freqCalls.some((c) => c.name === 'setValueAtTime' && near(c.value, 210)),
    'no frequency set at 210',
  );
  assert.ok(
    freqCalls.some((c) => c.name === 'exponentialRampToValueAtTime' && near(c.value, 95)),
    'no frequency ramp to 95',
  );

  const filters = byKind('filter');
  assert.equal(filters.length, 1, `expected 1 filter, got ${filters.length}`);
  assert.equal(filters[0].type, 'bandpass', `filter type is ${filters[0].type}, expected bandpass`);
  assert.ok(near(filters[0].frequency.value, 1100), `filter at ${filters[0].frequency.value}, expected 1100`);
});

/* 5. edge snick */
await check('edge-snick', () => {
  resetLog();
  playBatImpact(0.1, 140);

  const filters = byKind('filter');
  assert.equal(filters.length, 1, `expected 1 filter, got ${filters.length}`);
  assert.equal(filters[0].type, 'highpass', `filter type is ${filters[0].type}, expected highpass`);
  assert.ok(near(filters[0].frequency.value, 2800), `filter at ${filters[0].frequency.value}, expected 2800`);
  assert.equal(byKind('oscillator').length, 0, 'the edge path created an oscillator');
});

/* 6. stump shatter */
await check('stump-shatter', () => {
  resetLog();
  playStumpShatter();

  const filters = byKind('filter');
  assert.equal(filters.length, 3, `expected 3 filters, got ${filters.length}`);

  const expected = [420, 550, 680];
  const offsets = [0, 0.028, 0.065];
  for (let i = 0; i < expected.length; i += 1) {
    const f = filters[i];
    assert.equal(f.type, 'bandpass', `burst ${i}: filter type is ${f.type}, expected bandpass`);
    assert.ok(near(f.frequency.value, expected[i]), `burst ${i}: filter at ${f.frequency.value}, expected ${expected[i]}`);

    const drivenBy = byKind('bufferSource').filter((src) => src.connects.includes(f));
    assert.equal(drivenBy.length, 1, `burst ${i}: filter is not fed by exactly one buffer source`);
    assert.equal(drivenBy[0].startCalls.length, 1, `burst ${i}: source has ${drivenBy[0].startCalls.length} start calls`);
    assert.ok(
      near(drivenBy[0].startCalls[0].t, offsets[i]),
      `burst ${i}: start offset ${drivenBy[0].startCalls[0].t}, expected ${offsets[i]}`,
    );
  }
});

/* 7. crowd swell */
await check('crowd-swell', () => {
  resetLog();

  const scheduled = [];
  globalThis.setTimeout = (fn, ms) => {
    scheduled.push({ fn, ms });
    fn();
    return 0;
  };

  swellCrowd(1);

  assert.ok(ambientGain, 'the ambient gain node was never created');
  const ramps = ambientGain.gain.calls.filter((c) => c.name === 'linearRampToValueAtTime');
  assert.equal(ramps.length, 2, `expected 2 ramps on the ambient gain, got ${ramps.length}`);
  assert.ok(near(ramps[0].value, 0.85), `swell ramp to ${ramps[0].value}, expected 0.85`);
  assert.ok(near(ramps[0].time, 0.15), `swell ramp over ${ramps[0].time} s, expected 0.15`);
  assert.ok(near(ramps[1].value, 0.3), `decay ramp to ${ramps[1].value}, expected 0.3`);
  assert.ok(near(ramps[1].time, 2.8), `decay ramp over ${ramps[1].time} s, expected 2.8`);
  assert.equal(scheduled.length, 1, 'the decay was not scheduled through setTimeout');

  globalThis.setTimeout = realSetTimeout;
});

/* 8. degrade */
await check('degrade', async () => {
  /* ambientAudio caches its context, so a fresh module instance is needed to
   * exercise the constructor path again. */
  globalThis.window = {
    AudioContext: class ThrowingAudioContext {
      constructor() {
        throw new Error('AudioContext blocked');
      }
    },
  };

  let warnCalls = 0;
  console.warn = () => {
    warnCalls += 1;
  };

  const freshDir = path.join(cacheDir, 'fresh');
  await transpileToCache('services/ambientAudio.ts', freshDir);
  const freshSfx = await import(
    pathToFileURL(await transpileToCache('services/soundEffects.ts', freshDir)).href,
  );

  let threw = null;
  try {
    freshSfx.playBatImpact(0.9, 140);
    freshSfx.playStumpShatter();
  } catch (err) {
    threw = err;
  }
  assert.equal(threw, null, `a call threw: ${threw && threw.message}`);
  assert.ok(warnCalls >= 1, 'console.warn did not run');

  console.warn = realWarn;
});

globalThis.window = realWindow;
globalThis.setTimeout = realSetTimeout;

console.log(`PASS ${passed}/8`);
