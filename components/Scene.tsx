import React, { useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { Physics, usePlane, useCylinder } from '@react-three/cannon';
import { Environment, PerspectiveCamera, ContactShadows } from '@react-three/drei';
import { Avatar } from './Avatar';
import { Ball } from './Ball';
import { PoseLandmarkFrame, GameState, GameMode, ShotResult, Stance, DeliveryScript, ResolvedTrackingMode } from '../types';
import {
  BatFrameState,
  createBatFrameState,
  STUMP_PLANE_Z,
  STUMP_XS,
  STUMP_RADIUS,
  STUMP_HEIGHT,
} from '../services/shotPhysics';
import { resolveShot } from '../services/shotOutcome';
import type { ShotOutcomeDetail } from '../services/shotOutcome';
import { Vector3, Mesh } from 'three';

interface SceneProps {
  poseLandmarks: React.MutableRefObject<PoseLandmarkFrame | null>;
  gameState: GameState;
  stance: Stance;
  gameMode: GameMode;
  delivery: DeliveryScript;
  onBallOutcome: (
    result: ShotResult,
    speed: number,
    dist: number,
    contactZ?: number,
    detail?: ShotOutcomeDetail,
  ) => void;
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
    // The exit velocity is the true 3D velocity the swept collider produced, so
    // both the speed and the launch elevation are real numbers now (defect 2:
    // the old handler never set the ball's velocity at all).
    const speed = vel.length() * 3.6; // km/h
    const horizontal = Math.hypot(vel.x, vel.z);
    const elevationDeg = horizontal > 1e-6
      ? (Math.atan2(vel.y, horizontal) * 180) / Math.PI
      : 0;

    // Scoring is the fielding model, not a scalar guess: the same exit velocity
    // feeds the drag flight, the catch window, the rope and the fielder closing
    // on the ball. A shot that beats the ring can be a single, a two or a three;
    // a ball that hangs is caught. A touched ball is never a MISS: MISS now
    // means the ball beat the bat (see handleMiss).
    const shot = resolveShot(pos, vel, delivery.id);

    // pos.z is where the ball met the bat on the pitch axis — used as a
    // shot-timing proxy by the coaching overlay (lower = further in front)
    onBallOutcome(shot.result, speed, shot.distanceM, pos.z, {
      runs: shot.runs,
      caughtByLabel: shot.caughtByLabel,
      landingXZ: shot.landingXZ,
    });
  };

  const handleMiss = () => {
    // BEATEN: the ball passed the stumps without touching bat or stumps. This
    // used to hardcode OUT, which made MISS unreachable.
    onBallOutcome(ShotResult.MISS, 0, 0);
  };

  const handleBowled = () => {
    // BOWLED: the ball crossed the stump plane inside the stump zone.
    // BallRecord.speed is the shot speed, so it stays 0 for a dismissal.
    onBallOutcome(ShotResult.OUT, 0, 0);
  };

  // One shared bat-state object for the whole match: Avatar publishes into it
  // and Ball sweeps against it. Created once, never captured at mount.
  const batFrame = useMemo<React.MutableRefObject<BatFrameState>>(
    () => ({ current: createBatFrameState() }),
    [],
  );

  const shouldShowAvatar = gameState === GameState.MENU || gameState === GameState.BATTING || gameState === GameState.FINISHED;

  return (
    // dpr capped at 1.5: dpr 2 quadruples fragment work on retina displays
    // for a barely-perceptible edge difference with antialiasing on. Stencil
    // is unused by this scene; high-performance nudges discrete GPUs on.
    <Canvas
      shadows
      dpr={[1, 1.5]}
      gl={{ alpha: true, antialias: true, stencil: false, powerPreference: 'high-performance' }}
    >
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
             batFrame={batFrame}
             trackingMode={trackingMode}
           />
        )}
        
        <Ball
            gameState={gameState}
            delivery={delivery}
            onHit={handleHit}
            onMiss={handleMiss}
            onBowled={handleBowled}
            resetTrigger={resetTrigger}
            batFrame={batFrame}
        />

        <Stumps />
        <Pitch />
      </Physics>

      {/* Contact shadows re-render the whole scene from below every frame;
          256px is ample under blur=2 (was 512 — 4x the shadow-pass cost). */}
      <ContactShadows opacity={0.3} scale={20} blur={2} far={10} resolution={256} color="#000000" />
    </Canvas>
  );
};

const Stumps = () => {
    // The stumps stand on the same plane the stump-zone test scores against.
    // Before this they sat at world z = 0 while the visual bails floated at
    // z = +0.5 through a group offset, so the drawn stumps, the physics bodies
    // and the dismissal test all disagreed (defect 4).
    const stumpArgs: [number, number, number, number] = [STUMP_RADIUS, STUMP_RADIUS, STUMP_HEIGHT, 8];

    const [stump1] = useCylinder(() => ({ name: 'stump', args: stumpArgs, position: [STUMP_XS[0], STUMP_HEIGHT / 2, STUMP_PLANE_Z], type: 'Static' }));
    const [stump2] = useCylinder(() => ({ name: 'stump', args: stumpArgs, position: [STUMP_XS[1], STUMP_HEIGHT / 2, STUMP_PLANE_Z], type: 'Static' }));
    const [stump3] = useCylinder(() => ({ name: 'stump', args: stumpArgs, position: [STUMP_XS[2], STUMP_HEIGHT / 2, STUMP_PLANE_Z], type: 'Static' }));

    const stumpRefs = [stump1, stump2, stump3];
    const bailLength = STUMP_XS[2] - STUMP_XS[0] + 2 * STUMP_RADIUS;

    return (
        <group>
            {stumpRefs.map((ref, index) => (
                <mesh key={index} ref={ref as any} name="stump" castShadow>
                    <cylinderGeometry args={stumpArgs} />
                    <meshStandardMaterial color="#eeeeee" roughness={0.1} />
                </mesh>
            ))}
            {/* Bails sit on top of the stumps, on the same plane. */}
            <mesh position={[0, STUMP_HEIGHT, STUMP_PLANE_Z]} name="bail">
                <boxGeometry args={[bailLength, 0.02, 0.02]} />
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