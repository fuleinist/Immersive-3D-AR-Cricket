// MediaPipe Global Types (loaded via script tags)
export interface Window {
  Pose: any;
  Camera: any;
}

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface PoseResults {
  poseLandmarks: Landmark[];
  poseWorldLandmarks: Landmark[];
}

export enum GameState {
  MENU = 'MENU',
  BATTING = 'BATTING',
  BOWLING = 'BOWLING',
  FINISHED = 'FINISHED'
}

export enum GameMode {
  EASY = 'EASY',
  PRO = 'PRO'
}

export enum ShotResult {
  MISS = 'MISS',
  DEFENSE = 'DEFENSE',
  FOUR = 'FOUR',
  SIX = 'SIX',
  OUT = 'OUT'
}

export enum Stance {
  RIGHT = 'RIGHT',
  LEFT = 'LEFT'
}

export interface GameStats {
  score: number;
  ballsFaced: number;
  lastShotSpeed: number; // km/h
  lastShotDistance: number; // meters
  commentary: string;
}

/**
 * A scripted "famous delivery". All physics params map directly onto the
 * vectors the bowling logic feeds to the cannon body:
 *  - pace  -> forward velocity (z, toward the batsman)
 *  - line  -> release velocity across the pitch (x; + = leg side, - = off side for a RHB)
 *  - dip   -> downward release velocity (y; closer to 0 = fuller length)
 *  - swing -> constant lateral drift applied while the ball is in flight (x accel, m/s^2)
 *  - spin  -> angular velocity [x, y, z]; z-axis spin is what rips sideways off the pitch
 */
export interface DeliveryScript {
  id: string;
  name: string;
  bowler: string;
  year: number;
  styleTag: string;
  description: string;
  /** Scripted historical explainer: the real story plus the technique/physics. */
  educational: string;
  speedKmh: number; // headline pace, for display
  pace: number;
  line: number;
  dip: number;
  swing: number;
  spin: [number, number, number];
}

/** Recorded outcome of one bowled delivery, for the innings result card. */
export interface BallRecord {
  delivery: DeliveryScript;
  result: ShotResult;
  runs: number;
  speed: number; // shot speed km/h (0 when beaten/bowled)
  distance: number; // meters
  /** Pitch-axis position of bat contact; lower = met further in front. Absent when beaten/bowled. */
  contactZ?: number;
}

/** User-selectable commentary overlay mode. */
export enum CommentaryMode {
  EDUCATIONAL = 'EDUCATIONAL',
  COACHING = 'COACHING',
  OFF = 'OFF',
}

/** Optional AI-enriched coaching note, keyed to the delivery it belongs to. */
export interface AiCoachingNote {
  deliveryId: string;
  text: string;
}