// Types shared between the engine, the server and the viewer.

import type { Direction, Hex } from './hex.js';
import type { Rules } from './rules.js';

export type Phase = 'lobby' | 'running' | 'paused' | 'finished';

export type Action =
  | { type: 'move'; direction: Direction; distance: number }
  | { type: 'scan'; radius: number }
  | { type: 'fire'; direction: Direction; power: number }
  | { type: 'wait' };

export type BlockReason = 'tree' | 'tank' | 'edge' | 'collision';

export type GameEvent =
  | { type: 'move'; tankId: string; path: Hex[]; direction: Direction; requested: number; blockedBy?: BlockReason; blockedAt?: Hex }
  | { type: 'fire'; tankId: string; from: Hex; direction: Direction; power: number; path: Hex[]; hit?: string; stoppedBy?: 'tree' | 'edge' | 'tank' | 'range' }
  | { type: 'damage'; tankId: string; by: string; amount: number; hp: number; fromDirection: Direction }
  | { type: 'destroyed'; tankId: string; by: string; at: Hex; dropped: number }
  | { type: 'pickup'; tankId: string; at: Hex; amount: number }
  | { type: 'scan'; tankId: string; center: Hex; radius: number; cost: number }
  | { type: 'wait'; tankId: string; recharged: number }
  | { type: 'timeout'; tankId: string }
  | { type: 'spawn'; cells: Hex[]; value: number };

export interface TankStats {
  kills: number;
  damageDealt: number;
  damageTaken: number;
  shotsFired: number;
  shotsHit: number;
  hexesMoved: number;
  energyCollected: number;
  scans: number;
  timeouts: number;
}

export interface TankView {
  id: string;
  name: string;
  color: string;
  alive: boolean;
  /** Present when the viewer is allowed to know it. */
  pos?: Hex;
  hp?: number;
  energy?: number;
  submitted?: boolean;
  lastAction?: Action | null;
  canFireAtTick?: number;
  stats?: TankStats;
  /** Player view only: tick this opponent was last seen at `pos`. */
  seenTick?: number;
  deathTick?: number;
  placement?: number;
}

export interface Snapshot {
  tick: number;
  phase: Phase;
  deadline: number | null; // epoch ms (server clock) when the current tick times out
  serverNow: number; // server clock when this snapshot was sent, to correct client clock skew
  tanks: TankView[];
  /** Flattened [q, r, value, ...] for energy cells the viewer can see. */
  energy: number[];
  /** Events from tick `eventsTick` (the last resolved one), filtered for the viewer. */
  eventsTick: number;
  events: GameEvent[];
  winnerId: string | null;
  /** Player view: hexes newly explored since the last snapshot, flattened [q, r, ...]. */
  exploredDelta?: number[];
  /** Player view: trees newly discovered since the last snapshot, flattened [q, r, ...]. */
  treesDelta?: number[];
}

export type ViewerRole = 'host' | 'player';

export interface Welcome {
  type: 'welcome';
  role: ViewerRole;
  tankId: string | null;
  seed: number;
  rules: Rules;
  /** Flattened [q, r, ...]. Host: every tree. Player: trees their tank knows about. */
  trees: number[];
  /** Player only: every hex their tank has observed, flattened [q, r, ...]. */
  explored: number[] | null;
  snapshot: Snapshot;
  mcpUrl: string;
  /** Host only: per-tank links to hand to players. */
  playerLinks?: Record<string, string>;
}

export type ServerMessage =
  | Welcome
  | ({ type: 'state' } & Snapshot)
  | { type: 'error'; message: string }
  | { type: 'links'; playerLinks: Record<string, string> };

export type HostCommand =
  | { cmd: 'start' }
  | { cmd: 'pause' }
  | { cmd: 'resume' }
  | { cmd: 'reset'; seed?: number }
  | { cmd: 'kick'; tankId: string }
  | { cmd: 'addBot'; };

export type ClientMessage =
  | { type: 'hello'; role: 'host'; key: string }
  | { type: 'hello'; role: 'player'; token: string }
  | ({ type: 'host' } & HostCommand);

export const packHexes = (hexes: Iterable<Hex>): number[] => {
  const out: number[] = [];
  for (const h of hexes) out.push(h.q, h.r);
  return out;
};
