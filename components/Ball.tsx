import React, { useEffect, useMemo, useRef } from 'react';
import { useSphere } from '@react-three/cannon';
import { useFrame } from '@react-three/fiber';
import { Vector3 } from 'three';
import { GameState, DeliveryScript } from '../types';
import {
  BatFrameState,
  createImpactResult,
  createStumpContact,
  createVec3,
  computeBounceSpinImpulse,
  stumpSegmentTest,
  PITCH_RESTITUTION,
} from '../services/shotPhysics';

interface BallProps {
  gameState: GameState;
  delivery: DeliveryScript;
  /** The true 3D exit velocity and the world point where the blade met the ball. */
  onHit: (velocity: Vector3, position: Vector3) => void;
  /** The ball went through untouched: BEATEN. */
  onMiss: () => void;
  /** Stump-zone contact: BOWLED. */
  onBowled: (point: Vector3, speed: number) => void;
  resetTrigger: number;
  /** Bat state published by Avatar; the swept collider is run against it here. */
  batFrame: React.MutableRefObject<BatFrameState>;
}

export const Ball: React.FC<BallProps> = ({
  gameState,
  delivery,
  onHit,
  onMiss,
  onBowled,
  resetTrigger,
  batFrame,
}) => {
  // Realistic physics radius (standard cricket ball is ~0.036m radius)
  // We use a consistent radius for ball vs stumps/bat to avoid "teleporting"
  // collisions. This is also the ball-centre height the harness models at the
  // pitch, so the runtime and the checks agree.
  const physicsRadius = 0.05;
  const visualRadius = 0.08;

  // Handlers are read through refs so the frame loop always calls the current
  // ones; the previous code closed over them inside a mount-time options object.
  const onHitRef = useRef(onHit);
  const onMissRef = useRef(onMiss);
  const onBowledRef = useRef(onBowled);
  useEffect(() => { onHitRef.current = onHit; }, [onHit]);
  useEffect(() => { onMissRef.current = onMiss; }, [onMiss]);
  useEffect(() => { onBowledRef.current = onBowled; }, [onBowled]);

  const [ref, api] = useSphere(() => ({
    mass: 0.16,
    // The release point is the delivery's; the reset effect puts the ball there
    // before the first frame, so this is only the mount placeholder.
    position: [0, 2.05, -18.5],
    args: [physicsRadius],
    linearDamping: 0.05,
    angularDamping: 0.1,
    // Matches shotPhysics.PITCH_RESTITUTION so the engine's bounce and the spin
    // impulse computed here describe the same contact.
    material: { friction: 0.2, restitution: PITCH_RESTITUTION },
    // No onCollide: bat contact is decided by the swept test below (the bat body
    // has its collisions switched off), and the pitch contact is detected by the
    // centre crossing the contact height.
  }));

  // Per-frame scratch, created once for the lifetime of the ball.
  const scratch = useMemo(() => ({
    pos: new Vector3(),
    vel: new Vector3(),
    prevPos: new Vector3(),
    prevVel: new Vector3(),
    impact: createImpactResult(),
    stump: createStumpContact(),
    bounce: createVec3(),
    exitVelocity: new Vector3(),
    contactPoint: new Vector3(),
  }), []);

  const hasHitRef = useRef(false);
  const pitchedRef = useRef(false);
  const outcomeFiredRef = useRef(false);
  const liveRef = useRef(false);

  useEffect(() => {
    const unsubscribe = api.position.subscribe((v) => scratch.pos.set(v[0], v[1], v[2]));
    return unsubscribe;
  }, [api.position, scratch]);

  useEffect(() => {
    const unsubscribe = api.velocity.subscribe((v) => scratch.vel.set(v[0], v[1], v[2]));
    return unsubscribe;
  }, [api.velocity, scratch]);

  useEffect(() => {
    // Synchronous: an outcome from the previous ball must not be able to fire
    // against this delivery, and the swept test must not sweep from an old
    // frame into the new ball.
    hasHitRef.current = false;
    pitchedRef.current = false;
    outcomeFiredRef.current = false;
    liveRef.current = false;
    batFrame.current.collider.resetHistory();

    const releaseX = Number.isFinite(delivery.releaseX) ? delivery.releaseX : 0;
    scratch.pos.set(releaseX, 2.05, -18.5);
    scratch.prevPos.copy(scratch.pos);
    scratch.vel.set(0, 0, 0);
    scratch.prevVel.set(0, 0, 0);

    api.position.set(releaseX, 2.05, -18.5);
    api.velocity.set(0, 0, 0);
    api.angularVelocity.set(0, 0, 0);

    if (gameState === GameState.BATTING) {
      const timer = setTimeout(() => {
        bowl();
      }, 1200);
      return () => clearTimeout(timer);
    }
  }, [resetTrigger, gameState, delivery, api, batFrame, scratch]);

  const bowl = () => {
    liveRef.current = true;

    // Fully scripted: line, length, pace and spin come from the delivery script
    api.velocity.set(delivery.line, delivery.dip, delivery.pace);
    api.angularVelocity.set(delivery.spin[0], delivery.spin[1], delivery.spin[2]);
  };

  useFrame((_, delta) => {
    if (!liveRef.current) return;

    const state = batFrame.current;
    const { pos, vel, prevPos, prevVel, impact, stump, bounce, exitVelocity, contactPoint } = scratch;

    // In-flight drift (swing) — applied only before the ball pitches
    if (!pitchedRef.current && delivery.swing !== 0) {
      const step = delivery.swing * Math.min(delta, 0.05);
      api.velocity.set(vel.x + step, vel.y, vel.z);
    }

    // First pitch contact: the ball centre crossing the contact height downward.
    // The velocity that decides the contact is the one the ball had on the way
    // in, so the impulse is computed from the previous frame's velocity.
    if (!pitchedRef.current && prevVel.y < 0 && prevPos.y > physicsRadius && pos.y <= physicsRadius + 0.02) {
      pitchedRef.current = true;
      computeBounceSpinImpulse(prevVel, delivery.spin, bounce);
      api.velocity.set(bounce.x, bounce.y, bounce.z);
    }

    // Bat contact, swept across the whole blade. Avatar publishes the sample
    // before this runs (it is mounted first), and the ball is tested from where
    // it was at the start of the frame to where it is now.
    if (!hasHitRef.current && state.armed && state.halfWidth > 0 && state.halfThickness > 0) {
      const dt = state.dtSeconds > 0 ? state.dtSeconds : Math.min(delta, 0.05);
      if (state.collider.test(dt, pos, vel, physicsRadius, state.halfWidth, state.halfThickness, impact)) {
        hasHitRef.current = true;
        outcomeFiredRef.current = true;

        api.velocity.set(impact.exitVelocity.x, impact.exitVelocity.y, impact.exitVelocity.z);
        api.position.set(impact.contactPoint.x, impact.contactPoint.y, impact.contactPoint.z);

        exitVelocity.set(impact.exitVelocity.x, impact.exitVelocity.y, impact.exitVelocity.z);
        contactPoint.set(impact.contactPoint.x, impact.contactPoint.y, impact.contactPoint.z);
        onHitRef.current(exitVelocity, contactPoint);
      }
    }

    // BOWLED: a stump-zone contact, only if the bat was never touched.
    if (!hasHitRef.current && !outcomeFiredRef.current) {
      if (stumpSegmentTest(prevPos, pos, physicsRadius, stump)) {
        outcomeFiredRef.current = true;
        contactPoint.set(stump.point.x, stump.point.y, stump.point.z);
        onBowledRef.current(contactPoint, Math.hypot(vel.x, vel.y, vel.z));
      }
    }

    // BEATEN: the ball went through past the stumps untouched.
    if (!hasHitRef.current && !outcomeFiredRef.current && pos.z > 2.0) {
      outcomeFiredRef.current = true;
      liveRef.current = false;
      onMissRef.current();
    }

    if (pos.z > 60 || pos.z < -40 || Math.abs(pos.x) > 20 || pos.y < -5) {
      liveRef.current = false;
    }

    // Both contact tests read the segment from the previous frame to this one,
    // so this frame's values become the next frame's history.
    prevPos.copy(pos);
    prevVel.copy(vel);
  });

  return (
    <mesh ref={ref as any} castShadow>
      <sphereGeometry args={[visualRadius, 32, 32]} />
      <meshStandardMaterial color="#b91c1c" roughness={0.3} metalness={0.2} />
    </mesh>
  );
};
