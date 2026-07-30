import React, { useRef, useState } from 'react';
import { toBlob } from 'html-to-image';
import { BallRecord, ShotResult } from '../types';

interface ResultCardProps {
  history: BallRecord[];
  onPlayAgain: () => void;
}

const resultBadge = (result: ShotResult): { label: string; className: string } => {
  switch (result) {
    case ShotResult.SIX:
      return { label: '6', className: 'bg-green-500 text-black' };
    case ShotResult.FOUR:
      return { label: '4', className: 'bg-emerald-700 text-white' };
    case ShotResult.OUT:
      return { label: 'W', className: 'bg-red-600 text-white' };
    case ShotResult.DEFENSE:
      return { label: '•', className: 'bg-gray-600 text-white' };
    default:
      return { label: '0', className: 'bg-gray-700 text-gray-300' };
  }
};

const resultLabel = (result: ShotResult): string => {
  switch (result) {
    case ShotResult.SIX: return 'SIX!';
    case ShotResult.FOUR: return 'FOUR';
    case ShotResult.OUT: return 'BOWLED';
    case ShotResult.DEFENSE: return 'Defended';
    default: return 'Beaten';
  }
};

export const ResultCard: React.FC<ResultCardProps> = ({ history, onPlayAgain }) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [sharing, setSharing] = useState(false);
  const [shareMessage, setShareMessage] = useState<string | null>(null);

  const totalRuns = history.reduce((sum, ball) => sum + ball.runs, 0);
  const wickets = history.filter((ball) => ball.result === ShotResult.OUT).length;

  const downloadPng = (dataUrl: string) => {
    const link = document.createElement('a');
    link.download = 'ar-cricket-famous-deliveries.png';
    link.href = dataUrl;
    link.click();
  };

  const handleShare = async () => {
    if (!cardRef.current || sharing) return;
    setSharing(true);
    setShareMessage(null);

    try {
      const blob = await toBlob(cardRef.current, {
        pixelRatio: 2,
        backgroundColor: '#030712',
        cacheBust: true,
      });
      if (!blob) throw new Error('PNG rasterization returned no data');

      const file = new File([blob], 'ar-cricket-famous-deliveries.png', { type: 'image/png' });
      const nav = navigator as any;

      if (nav.canShare && nav.canShare({ files: [file] })) {
        try {
          await nav.share({ files: [file], title: 'My AR Cricket innings' });
          setShareMessage('Shared!');
          return;
        } catch (err: any) {
          if (err?.name === 'AbortError') return; // user cancelled the share sheet
          // fall through to download on real share errors
        }
      }

      downloadPng(URL.createObjectURL(blob));
      setShareMessage('PNG downloaded');
    } catch (err) {
      console.error('Failed to render result card PNG:', err);
      setShareMessage('Could not create PNG — try again');
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="pointer-events-auto flex flex-col items-center w-full max-w-2xl animate-in fade-in slide-in-from-top-4 duration-500">
      {/* The card itself is what gets rasterized to PNG */}
      <div
        ref={cardRef}
        className="w-full bg-gray-950 rounded-3xl border-2 border-yellow-500/60 p-8 shadow-[0_0_60px_rgba(234,179,8,0.25)]"
      >
        <div className="text-center mb-6">
          <div className="text-[10px] uppercase tracking-[0.3em] text-yellow-500 font-bold">AR Cricket · Famous Deliveries</div>
          <h2 className="text-4xl font-black text-white italic tracking-tighter uppercase mt-1">Innings Card</h2>
        </div>

        <div className="divide-y divide-white/10 border-y border-white/10">
          {history.map((ball, i) => {
            const badge = resultBadge(ball.result);
            return (
              <div key={ball.delivery.id} className="flex items-center gap-3 py-3">
                <div className="w-6 text-center font-mono text-gray-500">{i + 1}</div>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center font-black text-sm shrink-0 ${badge.className}`}>
                  {badge.label}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-white font-bold truncate">
                    {ball.delivery.name}
                    <span className="text-gray-400 font-normal text-sm"> · {ball.delivery.bowler}</span>
                  </div>
                  <div className="text-[11px] text-gray-500 uppercase tracking-wider">
                    {resultLabel(ball.result)}
                    {ball.speed > 0 && ` · ${ball.speed.toFixed(0)} km/h · ${ball.distance.toFixed(0)}m`}
                  </div>
                </div>
                <div className="font-mono text-xl text-white w-10 text-right">{ball.runs}</div>
              </div>
            );
          })}
        </div>

        <div className="flex items-end justify-between mt-6">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-gray-500">Total</div>
            <div className="text-5xl font-black font-mono text-yellow-400">
              {totalRuns}
              <span className="text-xl text-gray-400 font-normal"> / {wickets}w</span>
            </div>
          </div>
          <div className="text-right text-[10px] text-gray-600 uppercase tracking-widest">
            5 balls · {history.length - wickets} scoring shots
          </div>
        </div>
      </div>

      {/* Actions (not part of the PNG) */}
      <div className="flex items-center gap-4 mt-6">
        <button
          onClick={handleShare}
          disabled={sharing}
          className="px-8 py-3 bg-gradient-to-r from-yellow-600 to-yellow-400 hover:from-yellow-500 hover:to-yellow-300 text-black font-black rounded-2xl text-lg transition-all transform hover:scale-105 active:scale-95 shadow-2xl disabled:opacity-50 disabled:cursor-wait"
        >
          {sharing ? 'Rendering PNG…' : 'Share / Download PNG'}
        </button>
        <button
          onClick={onPlayAgain}
          className="px-8 py-3 bg-white/10 hover:bg-white/20 text-white font-bold rounded-2xl text-lg transition-all border border-white/20"
        >
          Play Again
        </button>
      </div>
      {shareMessage && <div className="mt-3 text-xs text-yellow-300 uppercase tracking-widest">{shareMessage}</div>}
    </div>
  );
};
