import React, { useState, useRef, useCallback, useEffect } from 'react';
import { WebcamPose } from './components/WebcamPose';
import { Scene } from './components/Scene';
import { ResultCard } from './components/ResultCard';
import { CommentaryOverlay } from './components/CommentaryOverlay';
import { GameState, GameMode, PoseLandmarkFrame, PoseResults, ShotResult, GameStats, Stance, BallRecord, AiCoachingNote, TrackingMode, ResolvedTrackingMode } from './types';
import { FAMOUS_DELIVERIES } from './data/famousDeliveries';
import { getCoachingTips } from './data/coaching';
import { generateCommentary, generateCoachingInsight } from './services/geminiService';
import { startAmbient, stopAmbient } from './services/ambientAudio';
import { sampleFrame, detectTrackingMode, adaptSeatedLandmarks, MODE_WINDOW_FRAMES, FrameSample } from './services/trackingMode';
import {
  LandmarkSmoother,
  IMAGE_SPACE_SMOOTHING,
  IMAGE_SPACE_ARM_SMOOTHING,
  WORLD_SPACE_SMOOTHING,
  WORLD_SPACE_ARM_SMOOTHING,
  UPPER_BODY_LANDMARKS,
  buildLandmarkOverrides,
} from './services/poseSmoothing';

// Per-landmark filter profiles: the bat-driving arm chain (shoulders,
// elbows, wrists) gets the stronger variant; everything else uses the base
// profile. Built once — LandmarkSmoother reads the table at construction.
const IMAGE_OVERRIDES = buildLandmarkOverrides(33, UPPER_BODY_LANDMARKS, IMAGE_SPACE_ARM_SMOOTHING, IMAGE_SPACE_SMOOTHING);
const WORLD_OVERRIDES = buildLandmarkOverrides(33, UPPER_BODY_LANDMARKS, WORLD_SPACE_ARM_SMOOTHING, WORLD_SPACE_SMOOTHING);

// Scripted local commentary — the default experience (Gemini is optional)
const LOCAL_COMMENTARY: Record<ShotResult, string[]> = {
  [ShotResult.SIX]: [
    "MASSIVE! That's sailed all the way!",
    "Into the second tier! What a strike!",
    "Clean as a whistle — SIX RUNS!",
  ],
  [ShotResult.FOUR]: [
    "Crunched away for FOUR! Beautiful timing.",
    "Finds the gap and races to the rope!",
    "Pure class — four more.",
  ],
  [ShotResult.DEFENSE]: [
    "Solid defence, right behind the line.",
    "Dead bat. No run, no alarm.",
    "Watchful. Very watchful.",
  ],
  [ShotResult.MISS]: [
    "Beaten! No contact at all.",
    "Swing and a miss — the crowd gasps.",
  ],
  [ShotResult.OUT]: [
    "BOWLED HIM! The stumps are everywhere!",
    "TIMBER! That's a famous dismissal!",
    "Gone! The ball does all the talking!",
  ],
};

const App: React.FC = () => {
  const [gameState, setGameState] = useState<GameState>(GameState.MENU);
  const [stance, setStance] = useState<Stance>(Stance.RIGHT);
  const [gameMode, setGameMode] = useState<GameMode>(GameMode.EASY);
  const [deliveryIndex, setDeliveryIndex] = useState(0);
  const [history, setHistory] = useState<BallRecord[]>([]);
  const [aiCoaching, setAiCoaching] = useState<AiCoachingNote | null>(null);

  // Sit Mode: user preference (AUTO detects seated vs standing) and the
  // concretely resolved mode that the pose pipeline is currently applying.
  const [trackingMode, setTrackingMode] = useState<TrackingMode>(TrackingMode.AUTO);
  const [activeMode, setActiveMode] = useState<ResolvedTrackingMode>(TrackingMode.STANDING);

  // Calibration State
  const [avatarSize, setAvatarSize] = useState<number>(0.8);
  const [avatarOffsetX, setAvatarOffsetX] = useState<number>(0);
  const [avatarOffsetY, setAvatarOffsetY] = useState<number>(0);

  const [stats, setStats] = useState<GameStats>({
    score: 0,
    ballsFaced: 0,
    lastShotSpeed: 0,
    lastShotDistance: 0,
    commentary: "Face 5 of the most famous deliveries in cricket history!",
  });

  const [resetTrigger, setResetTrigger] = useState(0);

  const poseLandmarksRef = useRef<PoseLandmarkFrame | null>(null);

  // Reusable frame payloads — the renderer's ref is swapped per pose frame,
  // so the wrapper objects are preallocated to avoid per-frame churn.
  const framesRef = useRef<{ world: PoseLandmarkFrame; image: PoseLandmarkFrame }>({
    world: { landmarks: [], space: 'world' },
    image: { landmarks: [], space: 'image' },
  });

  // One Euro smoothers, one per landmark space. Both streams are filtered
  // unconditionally so switching tracking modes never hits stale filter
  // state. Lazily created on the first pose frame (~zero steady-state cost:
  // 33x3 channels preallocated once, filtering mutates landmarks in place).
  const smoothersRef = useRef<{ image: LandmarkSmoother; world: LandmarkSmoother } | null>(null);

  // Ref mirrors so handlePoseUpdate can stay identity-stable — WebcamPose
  // re-initializes the camera whenever the callback identity changes.
  const modeSamplesRef = useRef<FrameSample[]>([]);
  const activeModeRef = useRef<ResolvedTrackingMode>(TrackingMode.STANDING);
  const trackingModeRef = useRef<TrackingMode>(trackingMode);
  const gameStateRef = useRef<GameState>(gameState);

  useEffect(() => { trackingModeRef.current = trackingMode; }, [trackingMode]);
  useEffect(() => { gameStateRef.current = gameState; }, [gameState]);

  // Ambient crowd noise loops only while an innings is live; it starts from
  // the PLAY BALL gesture (startGame) and stops on innings end / unmount.
  useEffect(() => {
    if (gameState !== GameState.BATTING) stopAmbient();
  }, [gameState]);
  useEffect(() => () => stopAmbient(), []);

  const handlePoseUpdate = useCallback((results: PoseResults) => {
    if (!smoothersRef.current) {
      smoothersRef.current = {
        image: new LandmarkSmoother(IMAGE_SPACE_SMOOTHING, 33, IMAGE_OVERRIDES),
        world: new LandmarkSmoother(WORLD_SPACE_SMOOTHING, 33, WORLD_OVERRIDES),
      };
    }
    const smoothers = smoothersRef.current;

    // Single ingestion point: de-jitter the RAW landmarks (1€ filter, in
    // place) BEFORE anything consumes them — tracking-mode sampling, seated
    // adaptation, avatar bones, bat orientation, shot detection. Smoothing
    // must happen before adaptSeatedLandmarks: the adaptation anchors a
    // synthetic lower body to the live shoulders, and filtering after the
    // fact would fight that anchoring.
    smoothers.image.filter(results.poseLandmarks);
    smoothers.world.filter(results.poseWorldLandmarks);

    // Rolling calibration window for seated/standing detection.
    const sample = sampleFrame(results.poseLandmarks);
    if (sample) {
      modeSamplesRef.current.push(sample);
      if (modeSamplesRef.current.length > MODE_WINDOW_FRAMES) {
        modeSamplesRef.current.shift();
      }
    }

    // Resolve continuously outside of play so the menu avatar + calibration
    // sliders already reflect the mode that will be used; frozen mid-innings
    // so a wild swing can't flip the pipeline between deliveries.
    if (gameStateRef.current !== GameState.BATTING) {
      const resolved: ResolvedTrackingMode = trackingModeRef.current === TrackingMode.AUTO
        ? detectTrackingMode(modeSamplesRef.current).mode
        : trackingModeRef.current;
      if (resolved !== activeModeRef.current) {
        activeModeRef.current = resolved;
        setActiveMode(resolved);
      }
    }

    if (activeModeRef.current === TrackingMode.SITTING) {
      // Normalized image landmarks: their x/y don't depend on hip estimation,
      // unlike hip-anchored world landmarks which jitter when the player is
      // seated and the lower body is occluded. The adaptation re-anchors the
      // pose to synthetic hips, scales it to anatomical meters and swaps in
      // a synthetic standing lower body — emitting the same hip-anchored
      // metric space the renderer consumes in standing mode, so the avatar
      // keeps the same ground plane and framing either way.
      const frame = framesRef.current.world;
      frame.landmarks = adaptSeatedLandmarks(results.poseLandmarks ?? results.poseWorldLandmarks);
      poseLandmarksRef.current = frame;
    } else if (results.poseWorldLandmarks) {
      const frame = framesRef.current.world;
      frame.landmarks = results.poseWorldLandmarks;
      poseLandmarksRef.current = frame;
    } else {
      const frame = framesRef.current.image;
      frame.landmarks = results.poseLandmarks;
      poseLandmarksRef.current = frame;
    }
  }, []);

  const startGame = useCallback(() => {
    // Final resolve from the latest calibration window, then frozen for the
    // innings (gameState -> BATTING stops the continuous re-resolve above).
    const resolved: ResolvedTrackingMode = trackingModeRef.current === TrackingMode.AUTO
      ? detectTrackingMode(modeSamplesRef.current).mode
      : trackingModeRef.current;
    activeModeRef.current = resolved;
    setActiveMode(resolved);

    // User gesture: start the looping crowd ambience (autoplay-safe).
    startAmbient();

    setGameState(GameState.BATTING);
    setDeliveryIndex(0);
    setHistory([]);
    setAiCoaching(null);
    setStats({
        score: 0,
        ballsFaced: 0,
        lastShotSpeed: 0,
        lastShotDistance: 0,
        commentary: `${FAMOUS_DELIVERIES[0].bowler} is running in… "${FAMOUS_DELIVERIES[0].name}".`,
    });
    setResetTrigger(prev => prev + 1);
  }, []);

  const handleBallOutcome = async (result: ShotResult, speed: number, distance: number, contactZ?: number) => {
    const delivery = FAMOUS_DELIVERIES[deliveryIndex];
    const runs = result === ShotResult.SIX ? 6 : result === ShotResult.FOUR ? 4 : 0;
    const isLastDelivery = deliveryIndex >= FAMOUS_DELIVERIES.length - 1;

    setHistory(prev => [...prev, { delivery, result, runs, speed, distance, contactZ }]);

    const scripted = LOCAL_COMMENTARY[result][deliveryIndex % LOCAL_COMMENTARY[result].length];
    setStats(prev => ({
        ...prev,
        score: prev.score + runs,
        ballsFaced: prev.ballsFaced + 1,
        lastShotSpeed: speed,
        lastShotDistance: distance,
        commentary: result === ShotResult.OUT
          ? `${delivery.bowler} strikes — ${scripted}`
          : scripted
    }));

    // Optional AI commentary upgrade (no-op unless a Gemini key is configured)
    generateCommentary(result, speed, distance, delivery.name)
      .then(aiComment => {
        if (aiComment) setStats(prev => ({ ...prev, commentary: aiComment }));
      })
      .catch(() => { /* AI commentary is best-effort only */ });

    // Optional AI enrichment of the scripted coaching tips (same no-key no-op)
    generateCoachingInsight(delivery.name, result, getCoachingTips({ delivery, result, speed, distance, contactZ }))
      .then(note => {
        if (note) setAiCoaching({ deliveryId: delivery.id, text: note });
      })
      .catch(() => { /* AI coaching is best-effort only */ });

    if (isLastDelivery) {
        setTimeout(() => setGameState(GameState.FINISHED), 1500);
    } else {
        setTimeout(() => {
            setDeliveryIndex(prev => prev + 1);
            setResetTrigger(prev => prev + 1);
        }, 4000);
    }
  };

  const currentDelivery = FAMOUS_DELIVERIES[deliveryIndex] ?? FAMOUS_DELIVERIES[0];

  return (
    <div className="relative w-full h-screen bg-gray-950 overflow-hidden text-white font-sans">
      <WebcamPose onPoseUpdate={handlePoseUpdate} showVideo={gameState !== GameState.MENU} />

      <div className="absolute top-0 left-0 w-full h-full z-10">
        <Scene 
            poseLandmarks={poseLandmarksRef} 
            gameState={gameState} 
            stance={stance}
            gameMode={gameMode}
            delivery={currentDelivery}
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
                  <div className="mt-2 text-xl font-mono">
                    Score: <span className="text-3xl text-white">{stats.score}</span>
                    <span className="text-sm text-gray-400 ml-2">
                      {history.filter(b => b.result === ShotResult.OUT).length}w · Ball {Math.min(stats.ballsFaced + 1, FAMOUS_DELIVERIES.length)}/{FAMOUS_DELIVERIES.length}
                    </span>
                  </div>
                  {gameState === GameState.BATTING && (
                      <div className="mt-2 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-gray-400">
                          <span className={`w-1.5 h-1.5 rounded-full ${activeMode === TrackingMode.SITTING ? 'bg-blue-400' : 'bg-green-400'}`} />
                          {activeMode === TrackingMode.SITTING ? 'Sit Mode' : 'Standing'}
                          {trackingMode === TrackingMode.AUTO && <span className="text-gray-600">· auto</span>}
                      </div>
                  )}
              </div>
              
              {stats.lastShotSpeed > 0 && gameState === GameState.BATTING && (
                  <div className="bg-black/60 backdrop-blur-md p-4 rounded-lg border border-white/20 text-right animate-pulse">
                      <div className="text-xs text-gray-400 uppercase tracking-widest">Last Shot</div>
                      <div className="text-2xl font-mono text-green-400">{stats.lastShotSpeed.toFixed(1)} <span className="text-xs">km/h</span></div>
                      <div className="text-lg text-white">{stats.lastShotDistance.toFixed(0)}m</div>
                  </div>
              )}
          </div>

          {/* Scripted delivery banner */}
          {gameState === GameState.BATTING && (
              <div className="pointer-events-none bg-black/70 backdrop-blur-md px-8 py-4 rounded-2xl border border-yellow-500/50 text-center shadow-[0_0_40px_rgba(234,179,8,0.2)] max-w-xl">
                  <div className="text-[10px] uppercase tracking-[0.3em] text-yellow-500 font-bold">
                    Delivery {deliveryIndex + 1} of {FAMOUS_DELIVERIES.length} · {currentDelivery.styleTag} · {currentDelivery.speedKmh} km/h
                  </div>
                  <h2 className="text-3xl font-black italic text-white tracking-tight uppercase mt-1">
                    {currentDelivery.name}
                  </h2>
                  <div className="text-sm text-yellow-200 font-bold mt-0.5">
                    {currentDelivery.bowler}, {currentDelivery.year}
                  </div>
                  <p className="text-xs text-gray-400 mt-2 italic">{currentDelivery.description}</p>
              </div>
          )}

          {/* Innings result card */}
          {gameState === GameState.FINISHED && (
              <ResultCard history={history} onPlayAgain={startGame} />
          )}

          {/* Play-by-play commentary — top of window, below the delivery
              banner, so it no longer covers the pitch at the bottom. */}
          <div className="bg-black/60 p-6 rounded-2xl border border-blue-500/30 w-full max-w-2xl backdrop-blur-md shadow-2xl min-h-[90px] flex items-center justify-center">
              <p className="text-xl italic text-center text-blue-100 font-light leading-snug">
                  "{stats.commentary}"
              </p>
          </div>
        </div>

        {/* Center Content: Menu with Calibration */}
        <div className="pointer-events-auto flex flex-1 flex-col items-center justify-center py-10">
            {gameState === GameState.MENU && (
                <div className="bg-black/90 p-8 rounded-3xl border border-yellow-500/50 text-center max-w-lg shadow-2xl backdrop-blur-xl">
                    <h2 className="text-4xl font-extrabold mb-2 text-yellow-500 italic tracking-tighter uppercase">Calibration</h2>
                    <p className="text-xs text-gray-400 mb-6 uppercase tracking-widest">Then face 5 famous deliveries</p>
                    
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

                    <div className="mb-6">
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

                    <div className="mb-8">
                      <div className="text-xs text-gray-500 uppercase font-bold mb-2 tracking-widest">Body Tracking</div>
                      <div className="flex gap-2 justify-center">
                        <button
                          onClick={() => setTrackingMode(TrackingMode.STANDING)}
                          className={`flex-1 px-3 py-2 rounded-lg font-bold transition-all text-sm ${trackingMode === TrackingMode.STANDING ? 'bg-green-600 text-white shadow-[0_0_15px_rgba(34,197,94,0.3)]' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                        >
                          Standing
                        </button>
                        <button
                          onClick={() => setTrackingMode(TrackingMode.SITTING)}
                          className={`flex-1 px-3 py-2 rounded-lg font-bold transition-all text-sm ${trackingMode === TrackingMode.SITTING ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(59,130,246,0.3)]' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                        >
                          Sitting
                        </button>
                        <button
                          onClick={() => setTrackingMode(TrackingMode.AUTO)}
                          className={`flex-1 px-3 py-2 rounded-lg font-bold transition-all text-sm ${trackingMode === TrackingMode.AUTO ? 'bg-yellow-500 text-black shadow-[0_0_15px_rgba(234,179,8,0.4)]' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                        >
                          Auto
                        </button>
                      </div>
                      <div className="text-[10px] text-gray-500 mt-2 uppercase tracking-widest">
                        {trackingMode === TrackingMode.AUTO
                          ? `Detected: ${activeMode === TrackingMode.SITTING ? 'Sitting — upper-body tracking' : 'Standing — full-body tracking'}`
                          : trackingMode === TrackingMode.SITTING
                            ? 'Upper-body tracking · legs follow shoulders'
                            : 'Full-body tracking'}
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

        {/* Commentary overlay (educational / coaching / off) — self-hides when not batting */}
        <CommentaryOverlay
            gameState={gameState}
            delivery={currentDelivery}
            lastBall={history.length > 0 ? history[history.length - 1] : null}
            aiCoaching={aiCoaching}
        />
      </div>
    </div>
  );
};

export default App;