import React from 'react';
import { Canvas } from '@react-three/fiber';
import { Physics, usePlane, useCylinder } from '@react-three/cannon';
import { Environment, PerspectiveCamera, ContactShadows } from '@react-three/drei';
import { Avatar } from './Avatar';
import { Ball } from './Ball';
import { PoseLandmarkFrame, GameState, GameMode, ShotResult, Stance, DeliveryScript, ResolvedTrackingMode } from '../types';
import { Vector3, Mesh } from 'three';

interface SceneProps {
  poseLandmarks: React.MutableRefObject<PoseLandmarkFrame | null>;
  gameState: GameState;
  stance: Stance;
  gameMode: GameMode;
  delivery: DeliveryScript;
  onBallOutcome: (result: ShotResult, speed: number, dist: number, contactZ?: number) => void;
  resetTrigger: number;
  avatarSize?: number;
  avatarOffset?: { x: number; y: number };
  /** Smoothed lateral root offset (world meters), updated per pose frame. */
  lateralOffset: React.MutableRefObject<number>;
  trackingMode: ResolvedTrackingMode;
}

export const Scene: React.FC<SceneProps> = ({
  poseLandmarks,
  gameState,
  stance,
  gameMode,
  delivery,
  onBallOutcome,
  resetTrigger,
  avatarSize = 0.8,
  avatarOffset = { x: 0, y: 0 },
  lateralOffset,
  trackingMode
}) => {

  const handleHit = (vel: Vector3, pos: Vector3) => {
    // Relative speed in km/h
    const speed = vel.length() * 3.6;
    let result = ShotResult.DEFENSE;
    
    // More physics-based scoring
    // If speed is high and it's hit significantly forward (Z direction)
    if (speed > 85 && vel.z < -5) {
        result = ShotResult.SIX;
    } else if (speed > 45 && vel.z < -2) {
        result = ShotResult.FOUR;
    } else if (speed > 15) {
        result = ShotResult.DEFENSE;
    } else {
        result = ShotResult.MISS; // Too weak to count
    }

    const distance = (speed * speed) / 20; // Rough physics approximation for flight dist
    // pos.z is where the ball met the bat on the pitch axis — used as a
    // shot-timing proxy by the coaching overlay (lower = further in front)
    onBallOutcome(result, speed, distance, pos.z);
  };

  const handleMiss = () => {
    onBallOutcome(ShotResult.OUT, 0, 0);
  };

  const shouldShowAvatar = gameState === GameState.MENU || gameState === GameState.BATTING || gameState === GameState.FINISHED;

  return (
    <Canvas shadows dpr={[1, 2]} gl={{ alpha: true }}>
      <PerspectiveCamera makeDefault position={[0, 1.8, 6]} fov={45} />
      
      <ambientLight intensity={0.7} />
      <directionalLight position={[10, 15, 10]} intensity={2} castShadow shadow-mapSize={[1024, 1024]} />
      <Environment preset="park" />

      <Physics gravity={[0, -9.8, 0]}>
        {shouldShowAvatar && (
           <Avatar
             landmarks={poseLandmarks}
             stance={stance}
             gameMode={gameMode}
             size={avatarSize}
             positionOffset={avatarOffset}
             lateralOffset={lateralOffset}
             trackingMode={trackingMode}
           />
        )}
        
        <Ball
            gameState={gameState}
            delivery={delivery}
            onHit={handleHit}
            onMiss={handleMiss}
            resetTrigger={resetTrigger}
        />

        <Stumps />
        <Pitch />
      </Physics>

      <ContactShadows opacity={0.3} scale={20} blur={2} far={10} resolution={512} color="#000000" />
    </Canvas>
  );
};

const Stumps = () => {
    // Physical stumps
    // Stumps are roughly 71cm high, each 3.8cm diameter
    const stumpRadius = 0.02;
    const stumpHeight = 0.71;
    const stumpArgs: [number, number, number, number] = [stumpRadius, stumpRadius, stumpHeight, 8];
    
    const [stump1] = useCylinder(() => ({ name: 'stump', args: stumpArgs, position: [-0.1, stumpHeight/2, 0], type: 'Static' }));
    const [stump2] = useCylinder(() => ({ name: 'stump', args: stumpArgs, position: [0, stumpHeight/2, 0], type: 'Static' }));
    const [stump3] = useCylinder(() => ({ name: 'stump', args: stumpArgs, position: [0.1, stumpHeight/2, 0], type: 'Static' }));

    return (
        <group position={[0, 0, 0.5]}>
            <mesh ref={stump1 as any} castShadow>
                <cylinderGeometry args={stumpArgs} />
                <meshStandardMaterial color="#eeeeee" roughness={0.1} />
            </mesh>
            <mesh ref={stump2 as any} castShadow>
                <cylinderGeometry args={stumpArgs} />
                <meshStandardMaterial color="#eeeeee" roughness={0.1} />
            </mesh>
             <mesh ref={stump3 as any} castShadow>
                <cylinderGeometry args={stumpArgs} />
                <meshStandardMaterial color="#eeeeee" roughness={0.1} />
            </mesh>
            {/* Bails */}
            <mesh position={[0, 0.71, 0]}>
                <boxGeometry args={[0.22, 0.02, 0.02]} />
                <meshStandardMaterial color="#cc0000" />
            </mesh>
        </group>
    )
}

const Pitch = () => {
    const [ref] = usePlane(() => ({ 
        rotation: [-Math.PI / 2, 0, 0],
        position: [0, 0, 0],
        material: { friction: 0.15, restitution: 0.65 }
    }));

    return (
        <mesh ref={ref as React.RefObject<Mesh>} receiveShadow>
            <planeGeometry args={[30, 60]} />
            <meshStandardMaterial color="#3d4a1d" roughness={0.8} />
        </mesh>
    )
}