import React, { useEffect, useRef, useState } from 'react';
import { PoseResults } from '../types';

interface WebcamPoseProps {
  onPoseUpdate: (results: PoseResults) => void;
  showVideo?: boolean;
}

declare global {
  interface Window {
    Pose: any;
  }
}

const CricketerAnimation = () => (
    <svg viewBox="0 0 100 100" className="w-48 h-48 mx-auto mb-6 drop-shadow-[0_0_15px_rgba(234,179,8,0.5)]">
      <defs>
        <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style={{ stopColor: '#fbbf24', stopOpacity: 1 }} />
          <stop offset="100%" style={{ stopColor: '#f59e0b', stopOpacity: 1 }} />
        </linearGradient>
      </defs>
      
      <g className="animate-pulse">
          {/* Head */}
          <circle cx="50" cy="25" r="7" fill="url(#grad1)" />
          
          {/* Body */}
          <line x1="50" y1="32" x2="50" y2="60" stroke="url(#grad1)" strokeWidth="4" strokeLinecap="round" />
          
          {/* Legs */}
          <path d="M50 60 L40 85 M50 60 L60 85" stroke="url(#grad1)" strokeWidth="4" fill="none" strokeLinecap="round" />
          
          {/* Arms */}
          <path d="M50 40 L35 55 M50 40 L65 55" stroke="url(#grad1)" strokeWidth="4" fill="none" strokeLinecap="round" />
          
          {/* Bat - Animated Swing */}
          <rect x="30" y="50" width="6" height="35" fill="#f97316" rx="2" transform="rotate(-45 33 50)">
              <animateTransform 
                  attributeName="transform"
                  type="rotate"
                  values="-45 33 50; -20 33 50; -45 33 50"
                  dur="2s"
                  repeatCount="indefinite"
                  calcMode="spline"
                  keySplines="0.4 0 0.2 1; 0.4 0 0.2 1"
              />
          </rect>
          
          {/* Ball */}
           <circle cx="70" cy="70" r="3" fill="#ef4444">
             <animate 
                attributeName="cy"
                values="70; 60; 70"
                dur="2s"
                repeatCount="indefinite"
             />
           </circle>
      </g>
    </svg>
);

export const WebcamPose = React.memo(({ onPoseUpdate, showVideo = true }: WebcamPoseProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const requestRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryTrigger, setRetryTrigger] = useState(0);
  const [isInitializing, setIsInitializing] = useState(true);

  useEffect(() => {
    let pose: any;
    let stream: any = null;
    let stopFake: (() => void) | null = null;
    let isCancelled = false;

    setIsInitializing(true);
    setError(null);

    const init = async () => {
      if (!videoRef.current) return;

      // Headless/dev harness hook (scripts/perf-probe.mjs): synthesize the
      // pose stream and skip camera + MediaPipe entirely. Inert unless the
      // flag is set on window before page load; the module is a lazy chunk.
      const fakeMode = (window as any).__AR_CRICKET_FAKE_POSE__;
      if (fakeMode) {
        try {
          const { startFakePoseLoop } = await import('../services/fakePose');
          if (isCancelled) return;
          stopFake = startFakePoseLoop(onPoseUpdate, fakeMode === 'sitting');
          setIsInitializing(false);
        } catch (e) {
          console.error('Fake pose loop failed to start:', e);
        }
        return;
      }

      if (!(window as any).Pose) {
        if (!isCancelled) setTimeout(init, 500);
        return;
      }

      try {
        pose = new (window as any).Pose({
          locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
        });

        pose.setOptions({
          modelComplexity: 1,
          smoothLandmarks: true,
          enableSegmentation: false,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });

        pose.onResults((results: any) => {
          if (!isCancelled && results.poseLandmarks) {
            onPoseUpdate({
              poseLandmarks: results.poseLandmarks,
              poseWorldLandmarks: results.poseWorldLandmarks
            });
          }
        });

        try {
          stream = await (window as any).navigator.mediaDevices.getUserMedia({
              video: { 
                  width: { ideal: 640 }, 
                  height: { ideal: 480 },
                  facingMode: 'user'
              }
          });
        } catch (e) {
           console.warn("Preferred camera constraints failed, trying fallback...", e);
           stream = await (window as any).navigator.mediaDevices.getUserMedia({ video: true });
        }

        if (videoRef.current && !isCancelled && stream) {
            const video = videoRef.current as any;
            video.srcObject = stream;
            video.onloadedmetadata = () => {
                if (videoRef.current) {
                    (videoRef.current as any).play().catch((e: any) => console.error("Play error:", e));
                    startPredictionLoop();
                    setIsInitializing(false);
                }
            };
        } else {
             throw new Error("Could not acquire video stream");
        }
      } catch (err: any) {
        console.error("Camera/Pose initialization failed:", err);
        if (!isCancelled) {
            setIsInitializing(false);
            if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                setError("No camera found. Please connect a webcam.");
            } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                setError("Camera permission denied. Please allow access.");
            } else {
                setError(`Camera error: ${err.message || "Unknown error"}`);
            }
        }
      }
    };

    const startPredictionLoop = () => {
        const predict = async () => {
            if (isCancelled) return;
            const video = videoRef.current as any;
            if (video && video.readyState >= 2 && pose) {
                try {
                    await pose.send({ image: video });
                } catch (e) {
                }
            }
            requestRef.current = requestAnimationFrame(predict);
        };
        predict();
    };

    init();

    return () => {
      isCancelled = true;
      if (stopFake) stopFake();
      if (requestRef.current !== null) cancelAnimationFrame(requestRef.current);
      if (pose) pose.close();
      if (stream) {
          (stream as any).getTracks().forEach((track: any) => track.stop());
      }
    };
  }, [onPoseUpdate, retryTrigger]);

  const handleRetry = () => {
      setError(null);
      setIsInitializing(true);
      setRetryTrigger(prev => prev + 1);
  };

  return (
    <>
      <div 
        className={`fixed bottom-6 right-6 w-64 aspect-video rounded-2xl border-2 border-white/20 shadow-[0_20px_50px_rgba(0,0,0,0.5)] overflow-hidden z-40 transition-all duration-500 ease-in-out transform bg-black ${
          showVideo ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-10 scale-95 pointer-events-none'
        }`}
      >
        <video
          ref={videoRef}
          className="w-full h-full object-cover transform scale-x-[-1]"
          playsInline
          muted
        />
        {/* Active tracking indicator */}
        <div className="absolute top-3 left-3 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-[10px] font-bold text-white/80 uppercase tracking-tighter">Live Track</span>
        </div>
      </div>
      
      {(error || isInitializing) && (
        <div className="absolute top-0 left-0 w-full h-full flex flex-col items-center justify-center bg-gray-950 z-50 text-white">
          <div className="bg-gray-900/80 p-12 rounded-3xl border border-yellow-500/30 backdrop-blur-md max-w-lg w-full text-center shadow-2xl">
              
              <CricketerAnimation />

              <h3 className="text-3xl font-bold text-yellow-400 mb-3 font-serif tracking-wider">
                  {isInitializing ? "WARMING UP..." : "NO CAMERA FEED"}
              </h3>
              
              <p className="text-gray-300 mb-8 text-lg font-light">
                  {isInitializing 
                    ? "Setting up the pitch and checking your stance." 
                    : error}
              </p>

              {!isInitializing && (
                  <button 
                      onClick={handleRetry}
                      className="px-8 py-3 bg-gradient-to-r from-yellow-600 to-yellow-500 hover:from-yellow-500 hover:to-yellow-400 text-black font-bold rounded-full text-lg transition-all transform hover:scale-105 shadow-lg"
                  >
                      Check Connection & Retry
                  </button>
              )}
          </div>
        </div>
      )}
    </>
  );
});