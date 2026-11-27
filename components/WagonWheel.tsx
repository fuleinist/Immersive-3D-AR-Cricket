import React from 'react';
import type { BallRecord } from '../types';
import type { WagonOutcome, WagonWheelShot } from '../services/wagonWheel';
import { SECTOR_COUNT, SECTOR_DEG, wagonWheel } from '../services/wagonWheel';

const SIZE = 120;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = 52;

const COLORS: Record<WagonOutcome, string> = {
  SIX: '#facc15',
  FOUR: '#10b981',
  RUNS: '#38bdf8',
  WICKET: '#ef4444',
  DOT: '#6b7280',
};

/**
 * Chart point. Angle 0 is up the screen toward the bowler (-z) and +x is right,
 * so the chart reads clockwise like the field.
 */
const pointFor = (angleDeg: number, radius: number) => {
  const a = (angleDeg * Math.PI) / 180;
  return {
    x: CX + R * radius * Math.sin(a),
    y: CY - R * radius * Math.cos(a),
  };
};

interface WagonWheelProps {
  history: BallRecord[];
}

export const WagonWheel: React.FC<WagonWheelProps> = ({ history }) => {
  const shots: WagonWheelShot[] = wagonWheel(history);
  const spokes = Array.from({ length: SECTOR_COUNT }, (_, i) => pointFor(i * SECTOR_DEG, 1));

  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Wagon wheel">
      <circle cx={CX} cy={CY} r={R} fill="#0b1220" stroke="#334155" strokeWidth={1} />
      <rect x={CX - 3} y={CY - 11} width={6} height={22} fill="#1e293b" stroke="#475569" strokeWidth={0.5} />
      {spokes.map((p, i) => (
        <line key={`sector-${i}`} x1={CX} y1={CY} x2={p.x} y2={p.y} stroke="#334155" strokeWidth={1} />
      ))}
      {shots.map((shot, i) => {
        const p = pointFor(shot.angleDeg, shot.radius);
        const color = COLORS[shot.outcome];
        return (
          <g key={`shot-${i}`}>
            <line x1={CX} y1={CY} x2={p.x} y2={p.y} stroke={color} strokeWidth={1.2} />
            {shot.outcome === 'WICKET' ? (
              <g stroke={color} strokeWidth={2}>
                <line x1={p.x - 3} y1={p.y - 3} x2={p.x + 3} y2={p.y + 3} />
                <line x1={p.x + 3} y1={p.y - 3} x2={p.x - 3} y2={p.y + 3} />
              </g>
            ) : (
              <circle cx={p.x} cy={p.y} r={2.5} fill={color} />
            )}
          </g>
        );
      })}
    </svg>
  );
};
