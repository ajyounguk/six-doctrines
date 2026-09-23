// A deliberately simple house bot: shoot what's lined up, chase energy, scan when blind,
// otherwise head for the centre. Useful as a sparring partner and as a reference agent.
// It only uses what its own tank knows, the same information an AI agent gets.

import {
  DIRECTIONS, type Direction, type Hex,
  alignedDirection, hexDistance, hexKey, hexLength, neighbor,
} from '../shared/hex.js';
import type { Action } from '../shared/protocol.js';

export interface BotInput {
  tick: number;
  pos: Hex;
  hp: number;
  energy: number;
  laserReady: boolean;
  maxMove: number;
  maxPower: number;
  maxScanRadius: number;
  boardRadius: number;
  knownTrees: Set<string>;
  energyCells: { at: Hex; value: number }[];
  enemies: { at: Hex; seenTick: number }[];
  lastScanTick: number;
  /** Per-tank number so bots pick different exploration waypoints. */
  seed: number;
}

/** Tiny binary min-heap for A*. */
class Heap<T> {
  private items: { k: number; v: T }[] = [];
  get size() { return this.items.length; }
  push(k: number, v: T) {
    const a = this.items;
    a.push({ k, v });
    for (let i = a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (a[p].k <= a[i].k) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0].v;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].k < a[m].k) m = l;
        if (r < a.length && a[r].k < a[m].k) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * A* over hexes the bot believes are passable (unknown hexes count as open). Turning is
 * penalised, because every change of direction costs a whole extra turn. Returns the
 * first straight leg of the best route as a move action.
 */
function routeToward(b: BotInput, target: Hex, budget: number, goalRadius = 0): Action | null {
  if (budget < 1) return null;
  const TURN = 4;
  const MAX_EXPANSIONS = 6000;
  const blocked = (h: Hex) => hexLength(h) > b.boardRadius || b.knownTrees.has(hexKey(h));
  interface Node { h: Hex; dir: number; g: number; first: number; leg: number; turned: boolean }
  const best = new Map<number, number>();
  const heap = new Heap<Node>();
  heap.push(hexDistance(b.pos, target), { h: b.pos, dir: -1, g: 0, first: -1, leg: 0, turned: false });
  let closest: Node | null = null;
  let closestD = hexDistance(b.pos, target);
  const toAction = (n: Node): Action => ({ type: 'move', direction: DIRECTIONS[n.first], distance: Math.min(n.leg, budget) });

  for (let expanded = 0; heap.size && expanded < MAX_EXPANSIONS; expanded++) {
    const cur = heap.pop()!;
    const d = hexDistance(cur.h, target);
    if (cur.first >= 0 && d <= goalRadius) return toAction(cur);
    if (cur.first >= 0 && d < closestD) { closest = cur; closestD = d; }
    for (let di = 0; di < 6; di++) {
      const n = neighbor(cur.h, DIRECTIONS[di]);
      if (blocked(n)) continue;
      const turning = cur.dir >= 0 && cur.dir !== di;
      const g = cur.g + 1 + (turning ? TURN : 0);
      const key = ((n.q + 1024) * 2048 + (n.r + 1024)) * 6 + di;
      if (g >= (best.get(key) ?? Infinity)) continue;
      best.set(key, g);
      const turned = cur.turned || turning;
      heap.push(g + hexDistance(n, target), {
        h: n, dir: di, g, first: cur.first >= 0 ? cur.first : di, leg: turned ? cur.leg : cur.leg + 1, turned,
      });
    }
  }
  // Unreachable or too far to search fully: take the leg that got us closest.
  return closest ? toAction(closest) : null;
}

function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2d);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

export function decideBotAction(b: BotInput): Action {
  const budget = Math.min(b.maxMove, b.energy - 3);

  // 1. Fire at a fresh sighting that's lined up and in range.
  if (b.laserReady) {
    for (const e of b.enemies) {
      if (b.tick - e.seenTick > 1) continue;
      const dir = alignedDirection(b.pos, e.at);
      const dist = hexDistance(b.pos, e.at);
      if (dir && dist <= b.maxPower && dist + 5 <= b.energy) return { type: 'fire', direction: dir, power: dist };
    }
  }

  // 2. Low on juice: recharge.
  if (b.energy < 8) return { type: 'wait' };

  // 3. Go and get the nearest known energy.
  const cells = [...b.energyCells].sort((x, y) => hexDistance(b.pos, x.at) - hexDistance(b.pos, y.at));
  for (const c of cells.slice(0, 3)) {
    if (budget < 1) break;
    const mv = routeToward(b, c.at, budget);
    if (mv) return mv;
  }

  // 4. Line up on a recently seen enemy.
  const enemy = b.enemies.filter((e) => b.tick - e.seenTick < 10).sort((x, y) => y.seenTick - x.seenTick)[0];
  if (enemy && budget >= 1) {
    const mv = routeToward(b, enemy.at, Math.min(budget, 4), 3);
    if (mv) return mv;
  }

  // 5. Blind for a while: look around (bigger scans when rich).
  const radius = Math.min(b.maxScanRadius, b.energy > 80 ? 12 : 8);
  if (b.tick - b.lastScanTick >= 4 && b.energy >= radius + 20) return { type: 'scan', radius };

  // 6. Explore: head for a waypoint that changes every 12 ticks, biased toward the middle ring.
  if (budget >= 3) {
    const epoch = Math.floor(b.tick / 12);
    const ang = hash01(epoch, b.seed) * Math.PI * 2;
    const dist = b.boardRadius * (0.2 + 0.5 * hash01(b.seed, epoch));
    const wp = { q: Math.round(Math.cos(ang) * dist / 1.5), r: 0 };
    wp.r = Math.round(Math.sin(ang) * dist / Math.sqrt(3) - wp.q / 2);
    const mv = routeToward(b, wp, budget, 4);
    if (mv) return mv;
  }
  return { type: 'wait' };
}
