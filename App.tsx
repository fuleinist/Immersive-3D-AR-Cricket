import React, { useState, useRef, useEffect, useCallback } from 'react';
import { WebcamPose } from './components/WebcamPose';
import { Scene } from './components/Scene';
import { GameState, GameMode, Landmark, PoseResults, ShotResult, GameStats, Stance } from './types';
import { generateCommentary } from './services/geminiService';

const App: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(GameState.MENU);
  const [stance, setStance] = useState<Stance>(Stance.RIGHT);
  const [gameMode, setGameMode] = useState<GameMode>(GameMode.EASY);
  
  // Calibration State
  const [avatarSize, setAvatarSize] = useState<number>(0.8);
  const [avatarOffsetX, setAvatarOffsetX] = useState<number>(0);
  const [avatarOffsetY, setAvatarOffsetY] = useState<number>(0);

  const [stats, setStats] = useState<GameStats>({
    score: 0,
    ballsFaced: 0,
    lastShotSpeed: 0,
    lastShotDistance: 0,
    commentary: "Welcome to AR Cricket! Select your stance and difficulty.",
  });
  
  const [resetTrigger, setResetTrigger] = useState(0);
  const [autoRestartCountdown, setAutoRestartCountdown] = useState<number | null>(null);
  
  const poseLandmarksRef = useRef< Landmark[] | null>(null);

  const handlePoseUpdate = useCallback((results: PoseResults) => {
    poseLandmarksRef.current = results.poseWorldLandmarks || results.poseLandmarks;
  }, []);

  const startGame = useCallback(() => {
    setGameState(GameState.BATTING);
    setStats({
        score: 0,
        ballsFaced: 0,
        lastShotSpeed: 0,
        lastShotDistance: 0,
        commentary: gameMode === GameMode.EASY ? "Warm up time! Slow deliveries incoming." : "Get ready! Fast bowlers are approaching.",
    });
    setAutoRestartCountdown(null);
    setResetTrigger(prev => prev + 1);
  }, [gameMode]);

  useEffect(() => {
    let interval: number;
    if (gameState === GameState.GAME_OVER) {
      setAutoRestartCountdown(5);
      interval = (window as any).setInterval(() => {
        setAutoRestartCountdown(prev => {
          if (prev !== null && prev > 1) return prev - 1;
          if (prev === 1) {
            startGame();
          }
          return null;
        });
      }, 1000);
    } else {
      setAutoRestartCountdown(null);
    }
    return () => clearInterval(interval);
  }, [gameState, startGame]);

  const handleBallOutcome = async (result: ShotResult, speed: number, distance: number) => {
    let runs = 0;
    
    if (result === ShotResult.SIX) runs = 6;
    else if (result === ShotResult.FOUR) runs = 4;
    else if (result === ShotResult.DEFENSE) runs = 0;
    else if (result === ShotResult.OUT) {
        setGameState(GameState.GAME_OVER);
    }

    if (result !== ShotResult.OUT) {
        setTimeout(() => {
            setResetTrigger(prev => prev + 1);
        }, 4000);
    }

    setStats(prev => ({
        ...prev,
        score: prev.score + (result === ShotResult.OUT ? 0 : runs),
        ballsFaced: prev.ballsFaced + 1,
        lastShotSpeed: speed,
        lastShotDistance: distance,
        commentary: result === ShotResult.OUT ? "OUT! Clean bowled!" : "Shot!"
    }));

    if (result !== ShotResult.OUT) {
      const aiComment = await generateCommentary(result, speed, distance);
      setStats(prev => ({ ...prev, commentary: aiComment }));
    }
  };

  return (
    <div className="relative w-full h-screen bg-gray-950 overflow-hidden text-white font-sans">
      <WebcamPose onPoseUpdate={handlePoseUpdate} showVideo={gameState !== GameState.MENU} />

      <div className="absolute top-0 left-0 w-full h-full z-10">
        <Scene 
            poseLandmarks={poseLandmarksRef} 
            gameState={gameState} 
            stance={stance}
            gameMode={gameMode}
            onBallOutcome={handleBallOutcome}
            resetTrigger={resetTrigger}
            avatarSize={avatarSize}
            avatarOffset={{ x: avatarOffsetX, y: avatarOffsetY }}
        />
      </div>

      <div className="absolute top-0 left-0 w-full h-full z-20 pointer-events-none flex flex-col justify-between p-6 overflow-y-auto">
        
        {/* Header Region */}
        <div className="flex flex-col items-center space-y-4">
          <div className="flex justify-between items-start w-full">
              <div className="bg-black/60 backdrop-blur-md p-4 rounded-lg border border-white/20 shadow-xl">
                  <h1 className="text-2xl font-bold text-yellow-400">AR CRICKET <span className="text-xs font-normal text-gray-400 ml-2 uppercase">[{gameMode}]</span></h1>
                  <div className="mt-2 text-xl font-mono">Score: <span className="text-3xl text-white">{stats.score}</span> / {stats.ballsFaced}</div>
              </div>
              
              {stats.lastShotSpeed > 0 && gameState !== GameState.GAME_OVER && (
                  <div className="bg-black/60 backdrop-blur-md p-4 rounded-lg border border-white/20 text-right animate-pulse">
                      <div className="text-xs text-gray-400 uppercase tracking-widest">Last Shot</div>
                      <div className="text-2xl font-mono text-green-400">{stats.lastShotSpeed.toFixed(1)} <span className="text-xs">km/h</span></div>
                      <div className="text-lg text-white">{stats.lastShotDistance.toFixed(0)}m</div>
                  </div>
              )}
          </div>

          {/* Game Over Modal */}
          {gameState === GameState.GAME_OVER && (
              <div className="pointer-events-auto bg-red-950/90 px-8 py-4 rounded-3xl border-2 border-red-500 text-center w-full max-w-xl animate-in fade-in slide-in-from-top-4 duration-500 shadow-[0_0_50px_rgba(239,68,68,0.3)] backdrop-blur-xl">
                  <div className="flex items-center justify-between">
                    <div className="text-left">
                      <h2 className="text-4xl font-black text-white italic leading-none">WICKET!</h2>
                      <p className="text-sm text-red-200 uppercase tracking-widest font-light mt-1">Clean Bowled</p>
                    </div>

                    <div className="flex flex-col items-center px-6 border-x border-red-500/30">
                      <div className="text-red-300 text-[10px] uppercase font-bold">Final Score</div>
                      <div className="text-4xl font-mono font-bold text-white">{stats.score}</div>
                    </div>

                    <div className="flex flex-col items-end gap-2">
                      <button 
                          onClick={startGame}
                          className="px-6 py-2 bg-white text-red-900 font-bold rounded-xl text-lg hover:bg-red-50 transition-all transform hover:scale-105 shadow-lg"
                      >
                          Play Again
                      </button>
                      {autoRestartCountdown !== null && (
                        <p className="text-[10px] text-red-200 font-medium">
                          Restarting in {autoRestartCountdown}s
                        </p>
                      )}
                    </div>
                  </div>
              </div>
          )}
        </div>

        {/* Center Content: Menu with Calibration */}
        <div className="pointer-events-auto flex flex-col items-center justify-center py-10">
            {gameState === GameState.MENU && (
                <div className="bg-black/90 p-8 rounded-3xl border border-yellow-500/50 text-center max-w-lg shadow-2xl backdrop-blur-xl">
                    <h2 className="text-4xl font-extrabold mb-4 text-yellow-500 italic tracking-tighter uppercase">Calibration</h2>
                    
                    {/* Calibration Section */}
                    <div className="mb-6 bg-white/5 p-4 rounded-xl border border-white/10 text-left">
                      <div className="text-xs text-yellow-500 uppercase font-bold mb-3 tracking-widest flex items-center">
                        <span className="mr-2">🔧</span> Avatar Tuning
                      </div>
                      
                      <div className="space-y-4">
                        <div>
                          <label className="flex justify-between text-[10px] mb-1 text-gray-400 uppercase">Size Scale: {avatarSize.toFixed(2)}</label>
                          <input type="range" min="0.3" max="1.5" step="0.01" value={avatarSize} 
                                 onChange={(e) => setAvatarSize(parseFloat((e.target as any).value))} 
                                 className="w-full accent-yellow-500" />
                        </div>
                        <div className="flex gap-4">
                          <div className="flex-1">
                            <label className="flex justify-between text-[10px] mb-1 text-gray-400 uppercase">Shift X: {avatarOffsetX.toFixed(1)}</label>
                            <input type="range" min="-1.5" max="1.5" step="0.1" value={avatarOffsetX} 
                                   onChange={(e) => setAvatarOffsetX(parseFloat((e.target as any).value))} 
                                   className="w-full accent-yellow-500" />
                          </div>
                          <div className="flex-1">
                            <label className="flex justify-between text-[10px] mb-1 text-gray-400 uppercase">Shift Y: {avatarOffsetY.toFixed(1)}</label>
                            <input type="range" min="-1.5" max="1.5" step="0.1" value={avatarOffsetY} 
                                   onChange={(e) => setAvatarOffsetY(parseFloat((e.target as any).value))} 
                                   className="w-full accent-yellow-500" />
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mb-6">
                      <div className="text-xs text-gray-500 uppercase font-bold mb-2 tracking-widest">Select Stance</div>
                      <div className="flex gap-2 justify-center">
                        <button 
                          onClick={() => setStance(Stance.RIGHT)}
                          className={`px-4 py-2 rounded-lg font-bold transition-all text-sm ${stance === Stance.RIGHT ? 'bg-yellow-500 text-black shadow-[0_0_15px_rgba(234,179,8,0.4)]' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                        >
                          Right Handed
                        </button>
                        <button 
                          onClick={() => setStance(Stance.LEFT)}
                          className={`px-4 py-2 rounded-lg font-bold transition-all text-sm ${stance === Stance.LEFT ? 'bg-yellow-500 text-black shadow-[0_0_15px_rgba(234,179,8,0.4)]' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                        >
                          Left Handed
                        </button>
                      </div>
                    </div>

                    <div className="mb-8">
                      <div className="text-xs text-gray-500 uppercase font-bold mb-2 tracking-widest">Select Difficulty</div>
                      <div className="flex gap-2 justify-center">
                        <button 
                          onClick={() => setGameMode(GameMode.EASY)}
                          className={`flex-1 px-4 py-3 rounded-xl font-bold transition-all border ${gameMode === GameMode.EASY ? 'bg-green-600 text-white border-green-400 shadow-[0_0_20px_rgba(34,197,94,0.3)]' : 'bg-gray-800 text-gray-400 border-transparent'}`}
                        >
                          EASY
                          <div className="text-[10px] font-normal opacity-80">Large Hitbox</div>
                        </button>
                        <button 
                          onClick={() => setGameMode(GameMode.PRO)}
                          className={`flex-1 px-4 py-3 rounded-xl font-bold transition-all border ${gameMode === GameMode.PRO ? 'bg-red-600 text-white border-red-400 shadow-[0_0_20px_rgba(220,38,38,0.3)]' : 'bg-gray-800 text-gray-400 border-transparent'}`}
                        >
                          PRO
                          <div className="text-[10px] font-normal opacity-80">Real Physics</div>
                        </button>
                      </div>
                    </div>

                    <button 
                        onClick={startGame}
                        className="w-full py-5 bg-gradient-to-r from-yellow-600 to-yellow-400 hover:from-yellow-500 hover:to-yellow-300 text-black font-black rounded-2xl text-2xl transition-all transform hover:scale-[1.02] active:scale-95 shadow-2xl"
                    >
                        PLAY BALL
                    </button>
                </div>
            )}
        </div>

        {/* Footer: Commentary */}
        <div className="w-full flex justify-center pb-8">
            <div className="bg-black/60 p-6 rounded-2xl border border-blue-500/30 w-full max-w-2xl backdrop-blur-md shadow-2xl min-h-[90px] flex items-center justify-center">
                <p className="text-xl italic text-center text-blue-100 font-light leading-snug">
                    "{stats.commentary}"
                </p>
            </div>
        </div>
      </div>
    </div>
  );
};

export default App;