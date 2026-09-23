// Hex math on axial coordinates (q, r), with cube coordinate s = -q - r implied.
// Layout is "flat-top": N/S point straight up/down the screen.
// Reference: https://www.redblobgames.com/grids/hexagons/

export interface Hex {
  q: number;
  r: number;
}

export const DIRECTIONS = ['N', 'NE', 'SE', 'S', 'SW', 'NW'] as const;
export type Direction = (typeof DIRECTIONS)[number];

// Clockwise from N.
export const DIRECTION_VECTORS: Record<Direction, Hex> = {
  N: { q: 0, r: -1 },
  NE: { q: 1, r: -1 },
  SE: { q: 1, r: 0 },
  S: { q: 0, r: 1 },
  SW: { q: -1, r: 1 },
  NW: { q: -1, r: 0 },
};

export const hex = (q: number, r: number): Hex => ({ q, r });
export const hexKey = (h: Hex): string => `${h.q},${h.r}`;
export const parseKey = (k: string): Hex => {
  const [q, r] = k.split(',').map(Number);
  return { q, r };
};
export const hexEquals = (a: Hex, b: Hex): boolean => a.q === b.q && a.r === b.r;
export const hexAdd = (a: Hex, b: Hex): Hex => ({ q: a.q + b.q, r: a.r + b.r });
export const hexSub = (a: Hex, b: Hex): Hex => ({ q: a.q - b.q, r: a.r - b.r });
export const hexScale = (a: Hex, k: number): Hex => ({ q: a.q * k, r: a.r * k });
export const hexS = (h: Hex): number => -h.q - h.r;

export const neighbor = (h: Hex, d: Direction): Hex => hexAdd(h, DIRECTION_VECTORS[d]);

export function hexLength(h: Hex): number {
  return Math.max(Math.abs(h.q), Math.abs(h.r), Math.abs(hexS(h)));
}

export function hexDistance(a: Hex, b: Hex): number {
  return hexLength(hexSub(a, b));
}

/** The direction from `from` to `to` if they lie on one of the six laser axes, else null. */
export function alignedDirection(from: Hex, to: Hex): Direction | null {
  const d = hexSub(to, from);
  const len = hexLength(d);
  if (len === 0) return null;
  for (const dir of DIRECTIONS) {
    const v = DIRECTION_VECTORS[dir];
    if (v.q * len === d.q && v.r * len === d.r) return dir;
  }
  return null;
}

/** Every hex within `radius` of `center` (inclusive). */
export function hexesInRange(center: Hex, radius: number): Hex[] {
  const out: Hex[] = [];
  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) out.push({ q: center.q + q, r: center.r + r });
  }
  return out;
}

/** Hexes on the ring exactly `radius` from center. */
export function hexRing(center: Hex, radius: number): Hex[] {
  if (radius === 0) return [center];
  const out: Hex[] = [];
  let h = hexAdd(center, hexScale(DIRECTION_VECTORS.SW, radius));
  for (const dir of DIRECTIONS) {
    for (let i = 0; i < radius; i++) {
      out.push(h);
      h = neighbor(h, dir);
    }
  }
  return out;
}

/**
 * The 12 symmetries of a hexagon (6 rotations x mirror) applied to a hex.
 * In cube space these are the permutations of (q, r, s), optionally all negated.
 */
export function symmetricImages(h: Hex): Hex[] {
  const q = h.q, r = h.r, s = hexS(h);
  const perms: [number, number][] = [
    [q, r], [r, s], [s, q], // rotations by 0, 120, 240 (even permutations)
    [q, s], [s, r], [r, q], // mirrors (odd permutations)
  ];
  const out: Hex[] = [];
  const seen = new Set<string>();
  for (const [a, b] of perms) {
    for (const sign of [1, -1]) {
      const img = { q: a * sign || 0, r: b * sign || 0 };
      const k = hexKey(img);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(img);
      }
    }
  }
  return out;
}

/** A single representative of a hex's symmetry orbit, so symmetric maps can be generated from one sector. */
export function canonicalHex(h: Hex): Hex {
  let best = h;
  for (const img of symmetricImages(h)) {
    if (img.q < best.q || (img.q === best.q && img.r < best.r)) best = img;
  }
  return best;
}

// --- Pixel conversion (flat-top), size = centre-to-corner distance ---

export const SQRT3 = Math.sqrt(3);

export function hexToPixel(h: Hex, size: number): { x: number; y: number } {
  return {
    x: size * 1.5 * h.q,
    y: size * SQRT3 * (h.r + h.q / 2),
  };
}

export function pixelToHex(x: number, y: number, size: number): Hex {
  const q = ((2 / 3) * x) / size;
  const r = ((-1 / 3) * x + (SQRT3 / 3) * y) / size;
  return hexRound(q, r);
}

export function hexRound(fq: number, fr: number): Hex {
  const fs = -fq - fr;
  let q = Math.round(fq), r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q: q || 0, r: r || 0 };
}
