// Types shared between the engine, the server and the viewer.

import type { Direction, Hex } from './hex.js';
import type { Rules } from './rules.js';

export type Phase = 'lobby' | 'running' | 'paused' | 'finished';

export type Action =
  | { type: 'move'; direction: Direction; distance: number }
  | { type: 'scan'; radius: number }
  | { type: 'fire'; direction: Direction; power: number }
  | { type: 'wait' };

export type BlockReason = 'forest' | 'proxy' | 'edge' | 'collision';

export type GameEvent =
  | { type: 'move'; proxyId: string; path: Hex[]; direction: Direction; requested: number; blockedBy?: BlockReason; blockedAt?: Hex }
  | { type: 'fire'; proxyId: string; from: Hex; direction: Direction; power: number; path: Hex[]; hit?: string; stoppedBy?: 'forest' | 'edge' | 'proxy' | 'range' }
  | { type: 'damage'; proxyId: string; by: string; amount: number; hp: number; fromDirection: Direction }
  | { type: 'destroyed'; proxyId: string; by: string; at: Hex; dropped: number }
  | { type: 'pickup'; proxyId: string; at: Hex; amount: number }
  | { type: 'scan'; proxyId: string; center: Hex; radius: number; cost: number }
  | { type: 'wait'; proxyId: string; recharged: number }
  | { type: 'timeout'; proxyId: string }
  | { type: 'spawn'; cells: Hex[]; value: number };

export interface ProxyStats {
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

export interface ProxyView {
  id: string;
  name: string;
  color: string;
  alive: boolean;
  /** Present when the viewer is allowed to know it. */
  pos?: Hex;
  hp?: number;
  energy?: number;
  submitted?: boolean;
  /** Player seems to have gone; ticks don't wait for them. */
  idle?: boolean;
  lastAction?: Action | null;
  canFireAtTick?: number;
  stats?: ProxyStats;
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
  tickMs: number; // current minimum tick length (host speed setting)
  proxies: ProxyView[];
  /** Flattened [q, r, value, ...] for energy cells the viewer can see. */
  energy: number[];
  /** Events from tick `eventsTick` (the last resolved one), filtered for the viewer. */
  eventsTick: number;
  events: GameEvent[];
  winnerId: string | null;
  /** Player view: hexes newly explored since the last snapshot, flattened [q, r, ...]. */
  exploredDelta?: number[];
  /** Player view: forest newly discovered since the last snapshot, flattened [q, r, ...]. */
  forestDelta?: number[];
}

export type ViewerRole = 'host' | 'player';

export interface Welcome {
  type: 'welcome';
  role: ViewerRole;
  proxyId: string | null;
  seed: number;
  rules: Rules;
  /** Flattened [q, r, ...]. Host: every forest. Player: forest their proxy knows about. */
  forest: number[];
  /** Player only: every hex their proxy has observed, flattened [q, r, ...]. */
  explored: number[] | null;
  snapshot: Snapshot;
  mcpUrl: string;
  /** Host only: per-proxy links to hand to players. */
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
  | { cmd: 'kick'; proxyId: string }
  | { cmd: 'addBot' }
  | { cmd: 'speed'; tickMs: number };

export type ClientMessage =
  | { type: 'hello'; role: 'host'; key: string }
  | { type: 'hello'; role: 'player'; token: string }
  | ({ type: 'host' } & HostCommand);

export const packHexes = (hexes: Iterable<Hex>): number[] => {
  const out: number[] = [];
  for (const h of hexes) out.push(h.q, h.r);
  return out;
};
