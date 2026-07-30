import React, { useEffect, useState } from 'react';
import { AiCoachingNote, BallRecord, CommentaryMode, DeliveryScript, GameState, ShotResult } from '../types';
import { getCoachingTips, getWatchOutHint } from '../data/coaching';

interface CommentaryOverlayProps {
  gameState: GameState;
  delivery: DeliveryScript;
  lastBall: BallRecord | null;
  aiCoaching: AiCoachingNote | null;
}

const MODES: { mode: CommentaryMode; label: string }[] = [
  { mode: CommentaryMode.EDUCATIONAL, label: 'Learn' },
  { mode: CommentaryMode.COACHING, label: 'Coach' },
  { mode: CommentaryMode.OFF, label: 'Off' },
];

const ModeSwitch: React.FC<{ mode: CommentaryMode; onChange: (mode: CommentaryMode) => void }> = ({ mode, onChange }) => (
  <div className="flex gap-1 bg-gray-900/90 rounded-lg p-1 border border-white/10" role="tablist" aria-label="Commentary mode">
    {MODES.map(({ mode: m, label }) => (
      <button
        key={m}
        role="tab"
        aria-selected={mode === m}
        onClick={() => onChange(m)}
        className={`px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all focus:outline-none focus:ring-2 focus:ring-yellow-400 ${
          mode === m ? 'bg-yellow-500 text-black' : 'text-gray-400 hover:bg-gray-700 hover:text-gray-200'
        }`}
      >
        {label}
      </button>
    ))}
  </div>
);

const outcomeLabel = (record: BallRecord): string => {
  switch (record.result) {
    case ShotResult.SIX: return `SIX · ${record.speed.toFixed(0)} km/h · ${record.distance.toFixed(0)}m`;
    case ShotResult.FOUR: return `FOUR · ${record.speed.toFixed(0)} km/h · ${record.distance.toFixed(0)}m`;
    case ShotResult.OUT: return 'BOWLED';
    case ShotResult.DEFENSE: return `Defended · ${record.speed.toFixed(0)} km/h`;
    default: return 'Beaten — no contact';
  }
};

/**
 * Dismissible commentary panel anchored to the left edge (clear of the
 * scoreboard, delivery banner, webcam preview and footer commentary).
 * EDUCATIONAL: scripted story/physics of the famous delivery.
 * COACHING: deterministic per-shot tips from pitch + bat data.
 * Hidden outside BATTING so it never competes with the ResultCard.
 */
export const CommentaryOverlay: React.FC<CommentaryOverlayProps> = ({ gameState, delivery, lastBall, aiCoaching }) => {
  const [mode, setMode] = useState<CommentaryMode>(CommentaryMode.EDUCATIONAL);

  useEffect(() => {
    if (gameState !== GameState.BATTING || mode === CommentaryMode.OFF) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMode(CommentaryMode.OFF);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, gameState]);

  if (gameState !== GameState.BATTING) return null;

  // Tips only make sense for the ball actually being faced — ignore the
  // previous delivery's record once the next one is running in.
  const record = lastBall && lastBall.delivery.id === delivery.id ? lastBall : null;
  const tips = record
    ? getCoachingTips({
        delivery,
        result: record.result,
        speed: record.speed,
        distance: record.distance,
        contactZ: record.contactZ,
      })
    : null;
  const aiNote = aiCoaching && aiCoaching.deliveryId === delivery.id ? aiCoaching.text : null;

  if (mode === CommentaryMode.OFF) {
    return (
      <div className="absolute left-6 top-1/2 -translate-y-1/2 pointer-events-auto">
        <ModeSwitch mode={mode} onChange={setMode} />
      </div>
    );
  }

  const accent = mode === CommentaryMode.COACHING ? 'border-green-500/40' : 'border-yellow-500/40';

  return (
    <div
      className={`absolute left-6 top-1/2 -translate-y-1/2 w-80 max-w-[calc(100vw-3rem)] max-h-[60vh] overflow-y-auto pointer-events-auto bg-black/70 backdrop-blur-md rounded-2xl border ${accent} shadow-2xl p-4`}
      role="complementary"
      aria-label="Commentary"
    >
      <div className="flex items-center justify-between gap-2">
        <ModeSwitch mode={mode} onChange={setMode} />
        <button
          onClick={() => setMode(CommentaryMode.OFF)}
          aria-label="Hide commentary"
          className="w-6 h-6 shrink-0 rounded-md text-gray-500 hover:text-white hover:bg-gray-700 transition-colors text-sm leading-none focus:outline-none focus:ring-2 focus:ring-yellow-400"
        >
          ×
        </button>
      </div>

      {mode === CommentaryMode.EDUCATIONAL && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-[0.25em] text-yellow-500 font-bold">
            The Story · {delivery.bowler}, {delivery.year}
          </div>
          <p className="mt-2 text-sm leading-relaxed text-gray-200">{delivery.educational}</p>
        </div>
      )}

      {mode === CommentaryMode.COACHING && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-[0.25em] text-green-400 font-bold">Virtual Coach</div>
          {record && <div className="mt-1 text-[11px] font-mono text-gray-400">{outcomeLabel(record)}</div>}
          {tips ? (
            <ul className="mt-2 space-y-2">
              {tips.map((tip, i) => (
                <li key={i} className="flex gap-2 text-sm leading-snug text-gray-200">
                  <span className="text-green-400 shrink-0">▸</span>
                  <span>{tip}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-2">
              <p className="text-sm text-gray-300 italic">Play your shot — coaching tips appear here right after contact.</p>
              <p className="mt-2 text-xs leading-snug text-gray-400">
                <span className="text-green-400 font-bold uppercase text-[10px] tracking-wider">Watch out: </span>
                {getWatchOutHint(delivery)}
              </p>
            </div>
          )}
          {aiNote && (
            <div className="mt-3 bg-blue-500/10 border border-blue-400/30 rounded-lg p-2.5">
              <div className="text-[9px] uppercase tracking-widest text-blue-300 font-bold mb-1">AI Coach</div>
              <p className="text-xs leading-snug text-blue-100">{aiNote}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
