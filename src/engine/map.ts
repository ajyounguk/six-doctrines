// Grid generation. Terrain is built from one symmetry sector and mirrored/rotated,
// so every spawn corner sees an identical battlefield.

import {
  DIRECTIONS, DIRECTION_VECTORS, type Hex,
  canonicalHex, hexKey, hexLength, hexScale, hexToPixel, hexesInRange,
} from '../shared/hex.js';
import type { Rules } from '../shared/rules.js';
import { hash2 } from './rng.js';

export const onGrid = (h: Hex, radius: number): boolean => hexLength(h) <= radius;

/** Grid corner i (0 = N, clockwise), pulled in by `inset` hexes. */
export function spawnCorner(i: number, rules: Rules): Hex {
  return hexScale(DIRECTION_VECTORS[DIRECTIONS[i]], rules.gridRadius - rules.spawnInset);
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 2D value noise in [0, 1). */
function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = smooth(x - x0), ty = smooth(y - y0);
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

function forestNoise(h: Hex, seed: number): number {
  const p = hexToPixel(h, 1);
  const n1 = valueNoise(p.x / 14, p.y / 14, seed);
  const n2 = valueNoise(p.x / 5, p.y / 5, seed + 101);
  return n1 * 0.75 + n2 * 0.25;
}

/** Returns the set of forest hex keys for this seed. */
export function generateForest(rules: Rules, seed: number): Set<string> {
  const all = hexesInRange({ q: 0, r: 0 }, rules.gridRadius);

  // Sample noise on canonical hexes only, then pick the threshold that hits the target density.
  const scores = new Map<string, number>();
  const values: number[] = [];
  for (const h of all) {
    const c = canonicalHex(h);
    const ck = hexKey(c);
    let v = scores.get(ck);
    if (v === undefined) {
      // Scattered lone forest hexes on top of the clustered forest.
      v = forestNoise(c, seed) + (hash2(c.q, c.r, seed + 7) > 0.985 ? 0.35 : 0);
      scores.set(ck, v);
    }
    values.push(v);
  }
  const sorted = [...values].sort((a, b) => b - a);
  const threshold = sorted[Math.floor(sorted.length * rules.forestDensity)] ?? 1;

  const cleared = new Set<string>();
  for (let i = 0; i < 6; i++) {
    for (const h of hexesInRange(spawnCorner(i, rules), rules.spawnClearRadius)) cleared.add(hexKey(h));
  }

  const forest = new Set<string>();
  all.forEach((h, i) => {
    const k = hexKey(h);
    if (values[i] > threshold && !cleared.has(k)) forest.add(k);
  });
  return forest;
}
