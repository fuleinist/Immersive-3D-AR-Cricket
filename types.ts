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
  GAME_OVER = 'GAME_OVER'
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