/**
 * Looping ambient crowd noise for play.
 *
 * Web Audio (AudioBufferSourceNode.loop) so the loop is gapless — an
 * HTMLAudioElement re-seeks audibly on MP3s. The asset is a fully local
 * file served from /public, so this works with no API key and offline.
 *
 * Autoplay policy: playback is only ever STARTED from the game-start user
 * gesture (PLAY BALL / Play Again). startAmbient() also resumes a
 * suspended AudioContext, which browsers only honor inside a gesture.
 * All failures (missing asset, decode error, blocked context) degrade to
 * silence — the game must never break because of background audio.
 */

const AMBIENT_URL = '/audio/crowd-noise.mp3';
/** Modest background level — sits under commentary and gameplay focus. */
const DEFAULT_VOLUME = 0.3;

let ctx: AudioContext | null = null;
let gainNode: GainNode | null = null;
let source: AudioBufferSourceNode | null = null;
let bufferPromise: Promise<AudioBuffer> | null = null;
let volume = DEFAULT_VOLUME;
/** Bumped on every start/stop so an in-flight decode from a superseded
 *  start() can't begin playback after stop() was called. */
let playToken = 0;

const ensureContext = (): AudioContext => {
  if (!ctx) {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API not supported');
    ctx = new Ctor();
    gainNode = ctx.createGain();
    gainNode.gain.value = volume;
    gainNode.connect(ctx.destination);
  }
  return ctx;
};

const loadBuffer = (context: AudioContext): Promise<AudioBuffer> => {
  if (!bufferPromise) {
    bufferPromise = fetch(AMBIENT_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`Ambient audio fetch failed: ${res.status}`);
        return res.arrayBuffer();
      })
      .then((bytes) => context.decodeAudioData(bytes))
      .catch((err) => {
        // Allow a later retry instead of caching the rejection forever.
        bufferPromise = null;
        throw err;
      });
  }
  return bufferPromise;
};

/**
 * Start (or keep) the loop. Idempotent: repeated calls while playing only
 * update the volume. Safe to call from a click handler; never throws.
 */
export const startAmbient = async (nextVolume: number = DEFAULT_VOLUME): Promise<void> => {
  volume = nextVolume;
  const token = ++playToken;
  try {
    const context = ensureContext();
    if (context.state === 'suspended') {
      await context.resume().catch(() => { /* still blocked — stay silent */ });
    }
    if (gainNode) gainNode.gain.value = volume;
    if (source) return; // already looping

    const buffer = await loadBuffer(context);
    if (token !== playToken || source) return; // stopped (or started) meanwhile

    const node = context.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.connect(gainNode ?? context.destination);
    node.start();
    source = node;
  } catch (err) {
    console.warn('Ambient crowd noise unavailable:', err);
  }
};

/** Stop the loop and release the source node. Safe to call anytime. */
export const stopAmbient = (): void => {
  playToken++;
  if (source) {
    try {
      source.stop();
    } catch {
      // already stopped
    }
    source.disconnect();
    source = null;
  }
};

export const setAmbientVolume = (nextVolume: number): void => {
  volume = Math.min(1, Math.max(0, nextVolume));
  if (gainNode) gainNode.gain.value = volume;
};

export const isAmbientPlaying = (): boolean => source !== null;
