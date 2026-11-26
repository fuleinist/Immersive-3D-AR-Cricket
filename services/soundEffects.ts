/**
 * Zero-asset procedural SFX for play: bat impact, stump shatter, crowd swell.
 *
 * No audio files — Web Audio oscillators and white noise only, so the game
 * ships nothing to download and works offline. The AudioContext is shared with
 * the ambient loop through ambientAudio's ensureContext, so the crowd swell
 * rides the same gain stage as the background bed.
 *
 * Every public function is fire-and-forget, returns void, and never throws: a
 * missing or blocked AudioContext degrades to silence.
 */
import { ensureContext, rampAmbientVolume } from './ambientAudio';

/** Peak level of the ambient loop; must match ambientAudio's DEFAULT_VOLUME. */
const AMBIENT_BASE = 0.3;

let muted = false;
let warned = false;

export const setSfxMuted = (next: boolean): void => { muted = next; };
export const isSfxMuted = (): boolean => muted;

const noiseBuffer = (ctx: AudioContext, seconds: number): AudioBuffer => {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
};

/** Bat impact. quality is the contact quality in [0, 1]; middled rings, edge snicks. */
export const playBatImpact = (quality: number, speedKmh: number): void => {
  if (muted) return;
  try {
    const ctx = ensureContext();
    const now = ctx.currentTime;
    const q = Math.min(1, Math.max(0, quality));

    const master = ctx.createGain();
    master.gain.value = speedKmh < 20 ? 0.3 : 1;
    master.connect(ctx.destination);

    if (q >= 0.65) {
      // Middled: a low triangle body plus a short bandpassed crack.
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(210, now);
      osc.frequency.exponentialRampToValueAtTime(95, now + 0.065);
      const oscGain = ctx.createGain();
      oscGain.gain.setValueAtTime(0.6, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
      osc.connect(oscGain);
      oscGain.connect(master);
      osc.start(now);
      osc.stop(now + 0.07);

      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, 0.018);
      const bandpass = ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 1100;
      bandpass.Q.value = 0.9;
      const crackGain = ctx.createGain();
      crackGain.gain.value = 0.25;
      src.connect(bandpass);
      bandpass.connect(crackGain);
      crackGain.connect(master);
      src.start(now);
      src.stop(now + 0.018);
    } else if (q < 0.35) {
      // Edge: a thin highpassed snick, no tone.
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, 0.012);
      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 2800;
      const snickGain = ctx.createGain();
      snickGain.gain.value = 0.35;
      src.connect(highpass);
      highpass.connect(snickGain);
      snickGain.connect(master);
      src.start(now);
      src.stop(now + 0.012);
    } else {
      // Thin contact: a quieter, shorter triangle.
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(150, now);
      osc.frequency.exponentialRampToValueAtTime(80, now + 0.045);
      const oscGain = ctx.createGain();
      oscGain.gain.setValueAtTime(0.4, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
      osc.connect(oscGain);
      oscGain.connect(master);
      osc.start(now);
      osc.stop(now + 0.05);
    }
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('Sound effects unavailable:', err);
    }
  }
};

/** Stumps shattering: three woody bursts, staggered and rising in pitch. */
export const playStumpShatter = (): void => {
  if (muted) return;
  try {
    const ctx = ensureContext();
    const now = ctx.currentTime;
    const offsets = [0, 0.028, 0.065];
    const frequencies = [420, 550, 680];

    for (let i = 0; i < offsets.length; i += 1) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, 0.04);
      const bandpass = ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = frequencies[i];
      bandpass.Q.value = 1.2;
      const burstGain = ctx.createGain();
      burstGain.gain.value = 0.5;
      src.connect(bandpass);
      bandpass.connect(burstGain);
      burstGain.connect(ctx.destination);
      src.start(now + offsets[i]);
      src.stop(now + offsets[i] + 0.04);
    }
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('Sound effects unavailable:', err);
    }
  }
};

/** Crowd swell: push the ambient bed up, then let it fall back. */
export const swellCrowd = (excitement: number): void => {
  if (muted) return;
  try {
    const e = Math.min(1, Math.max(0, excitement));
    rampAmbientVolume(AMBIENT_BASE + 0.55 * e, 0.15);
    setTimeout(() => {
      rampAmbientVolume(AMBIENT_BASE, 2.8);
    }, 150);
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('Sound effects unavailable:', err);
    }
  }
};
