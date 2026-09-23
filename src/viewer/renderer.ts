// Canvas renderer for the battlefield. Static terrain is painted once into an offscreen
// cache; tanks, energy and effects are drawn on top every frame.

import {
  DIRECTIONS, DIRECTION_VECTORS, SQRT3, type Direction, type Hex,
  alignedDirection, hexDistance, hexKey, hexLength, hexToPixel, pixelToHex,
} from '../shared/hex.js';
import { hash2 } from '../engine/rng.js';
import type { GameEvent, Snapshot, TankView } from '../shared/protocol.js';

const S = 10; // world units per hex, centre to corner
const CACHE_SCALE = 0.6; // cache pixels per world unit

const C = {
  stage: '#07090d',
  ground: ['#121a24', '#131c26', '#141e28', '#111923'],
  fog: '#0d131b',
  tree: '#1c4631',
  treeEdge: '#173b29',
  canopy: ['#2a6a46', '#23593b', '#317a50'],
  grid: 'rgba(160, 190, 220, 0.07)',
  edge: '#39d0ff',
  energy: '#39d0ff',
  energyCore: '#e6fbff',
  danger: '#ff4d5e',
  text: '#dbe4ee',
};

const CORNERS = Array.from({ length: 6 }, (_, i) => ({ x: Math.cos((Math.PI / 3) * i), y: Math.sin((Math.PI / 3) * i) }));

interface Effect {
  start: number;
  dur: number;
  draw: (ctx: CanvasRenderingContext2D, t: number) => void;
}

interface TankAnim { path: { x: number; y: number }[]; start: number; dur: number }

export interface HoverInfo { hex: Hex; x: number; y: number }

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private mini: CanvasRenderingContext2D;
  private cache: HTMLCanvasElement;
  private cctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;

  private radius = 0;
  private halfW = 0;
  private halfH = 0;
  private trees = new Set<string>();
  private explored: Set<string> | null = null; // null = everything visible (host)

  // camera: world point at screen centre, and screen px per world unit
  private cx = 0;
  private cy = 0;
  private zoom = 0.3;
  private targetZoom: number | null = null;
  follow = false;

  private snap: Snapshot | null = null;
  private myTankId: string | null = null;
  private tankColors = new Map<string, string>();
  private facing = new Map<string, number>(); // radians
  private anims = new Map<string, TankAnim>();
  private effects: Effect[] = [];
  private hover: Hex | null = null;
  private focusRing: { id: string; start: number } | null = null;

  private dirty = true;
  private lastDraw = 0;
  private lastMini = -Infinity;

  onHover: (h: HoverInfo | null) => void = () => {};
  onFollowChange: (on: boolean) => void = () => {};

  constructor(private canvas: HTMLCanvasElement, private miniCanvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.mini = miniCanvas.getContext('2d')!;
    this.cache = document.createElement('canvas');
    this.cctx = this.cache.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.bindInput();
    const loop = (now: number) => { this.frame(now); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------ board + data

  setBoard(radius: number, trees: number[], explored: number[] | null) {
    this.radius = radius;
    this.halfW = 1.5 * S * radius + S;
    this.halfH = SQRT3 * S * (radius + 0.5);
    this.trees = new Set();
    for (let i = 0; i < trees.length; i += 2) this.trees.add(`${trees[i]},${trees[i + 1]}`);
    if (explored) {
      this.explored = new Set();
      for (let i = 0; i < explored.length; i += 2) this.explored.add(`${explored[i]},${explored[i + 1]}`);
    } else {
      this.explored = null;
    }
    this.anims.clear();
    this.effects = [];
    this.facing.clear();
    this.paintCache();
    this.dirty = true;
  }

  /** Player view: newly explored hexes and newly discovered trees. */
  reveal(explored: number[] = [], trees: number[] = []) {
    for (let i = 0; i < trees.length; i += 2) this.trees.add(`${trees[i]},${trees[i + 1]}`);
    for (let i = 0; i < explored.length; i += 2) {
      const h = { q: explored[i], r: explored[i + 1] };
      this.explored?.add(hexKey(h));
      this.paintCacheHex(h);
    }
    for (let i = 0; i < trees.length; i += 2) this.paintCacheHex({ q: trees[i], r: trees[i + 1] });
    if (explored.length || trees.length) this.dirty = true;
  }

  setSnapshot(snap: Snapshot, myTankId: string | null) {
    this.snap = snap;
    this.myTankId = myTankId;
    for (const t of snap.tanks) this.tankColors.set(t.id, t.color);
    for (const t of snap.tanks) {
      if (!this.facing.has(t.id) && t.pos) this.facing.set(t.id, Math.atan2(-hexToPixel(t.pos, S).y, -hexToPixel(t.pos, S).x));
    }
    this.dirty = true;
  }

  // ------------------------------------------------------------ cache

  private cacheXY(h: Hex) {
    const p = hexToPixel(h, S);
    return { x: (p.x + this.halfW) * CACHE_SCALE, y: (p.y + this.halfH) * CACHE_SCALE };
  }

  private hexColor(h: Hex, k: string): string {
    if (this.trees.has(k)) return C.tree;
    if (this.explored && !this.explored.has(k)) return C.fog;
    return C.ground[Math.floor(hash2(h.q, h.r, 99) * C.ground.length)];
  }

  private paintCache() {
    this.cache.width = Math.ceil(this.halfW * 2 * CACHE_SCALE);
    this.cache.height = Math.ceil(this.halfH * 2 * CACHE_SCALE);
    const ctx = this.cctx;
    ctx.clearRect(0, 0, this.cache.width, this.cache.height);
    // Batch by colour: one path per colour is far faster than 50k fills.
    const byColor = new Map<string, Path2D>();
    const rad = S * CACHE_SCALE * 1.04; // slight overlap hides seams
    const R = this.radius;
    for (let q = -R; q <= R; q++) {
      for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) {
        const h = { q, r };
        const color = this.hexColor(h, `${q},${r}`);
        let p = byColor.get(color);
        if (!p) byColor.set(color, (p = new Path2D()));
        const c = this.cacheXY(h);
        p.moveTo(c.x + CORNERS[0].x * rad, c.y + CORNERS[0].y * rad);
        for (let i = 1; i < 6; i++) p.lineTo(c.x + CORNERS[i].x * rad, c.y + CORNERS[i].y * rad);
        p.closePath();
      }
    }
    for (const [color, p] of byColor) { ctx.fillStyle = color; ctx.fill(p); }
  }

  private paintCacheHex(h: Hex) {
    if (hexLength(h) > this.radius) return;
    const ctx = this.cctx;
    const c = this.cacheXY(h);
    const rad = S * CACHE_SCALE * 1.04;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) ctx.lineTo(c.x + CORNERS[i].x * rad, c.y + CORNERS[i].y * rad);
    ctx.closePath();
    ctx.fillStyle = this.hexColor(h, hexKey(h));
    ctx.fill();
  }

  // ------------------------------------------------------------ camera

  private resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    const m = this.miniCanvas.getBoundingClientRect();
    this.miniCanvas.width = Math.round(m.width * this.dpr);
    this.miniCanvas.height = Math.round(m.height * this.dpr);
    this.dirty = true;
  }

  private fitZoom() {
    if (!this.halfW || !this.w) return 0.3;
    return Math.min(this.w / (this.halfW * 2), this.h / (this.halfH * 2)) * 0.92;
  }

  private clampZoom(z: number) {
    return Math.max(this.fitZoom() * 0.5, Math.min(6, z));
  }

  fit() {
    this.setFollow(false);
    this.cx = 0;
    this.cy = 0;
    this.targetZoom = this.fitZoom();
    this.dirty = true;
  }

  focusHex(h: Hex, hexPx = 22) {
    const p = hexToPixel(h, S);
    this.cx = p.x;
    this.cy = p.y;
    this.targetZoom = this.clampZoom(Math.max(this.zoom, hexPx / S));
    this.dirty = true;
  }

  focusTank(id: string) {
    const t = this.snap?.tanks.find((x) => x.id === id);
    if (t?.pos) {
      this.focusHex(t.pos);
      this.focusRing = { id, start: performance.now() };
    }
  }

  zoomBy(f: number, sx = this.w / 2, sy = this.h / 2) {
    const before = this.toWorld(sx, sy);
    this.zoom = this.clampZoom(this.zoom * f);
    this.targetZoom = null;
    const after = this.toWorld(sx, sy);
    if (!this.follow) {
      this.cx += before.x - after.x;
      this.cy += before.y - after.y;
    }
    this.dirty = true;
  }

  setFollow(on: boolean) {
    if (this.follow === on) return;
    this.follow = on;
    if (on && this.zoom * S < 12) this.targetZoom = this.clampZoom(18 / S);
    this.onFollowChange(on);
    this.dirty = true;
  }

  private toWorld(sx: number, sy: number) {
    return { x: (sx - this.w / 2) / this.zoom + this.cx, y: (sy - this.h / 2) / this.zoom + this.cy };
  }

  private toScreen(x: number, y: number) {
    return { x: (x - this.cx) * this.zoom + this.w / 2, y: (y - this.cy) * this.zoom + this.h / 2 };
  }

  private hexScreen(h: Hex) {
    const p = hexToPixel(h, S);
    return this.toScreen(p.x, p.y);
  }

  private bindInput() {
    const cv = this.canvas;
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
    let pinch: { d: number; zoom: number } | null = null;

    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pointers.size === 1) drag = { x: e.offsetX, y: e.offsetY, cx: this.cx, cy: this.cy, moved: false };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom };
        drag = null;
      }
    });
    cv.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoom = this.clampZoom((pinch.zoom * d) / pinch.d);
        this.targetZoom = null;
        this.dirty = true;
        return;
      }
      if (drag) {
        const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) {
          drag.moved = true;
          cv.classList.add('dragging');
          this.setFollow(false);
        }
        if (drag.moved) {
          this.cx = drag.cx - dx / this.zoom;
          this.cy = drag.cy - dy / this.zoom;
          this.dirty = true;
        }
      }
      this.updateHover(e.offsetX, e.offsetY);
    });
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) { drag = null; cv.classList.remove('dragging'); }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { this.hover = null; this.onHover(null); this.dirty = true; });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), this.follow ? this.w / 2 : e.offsetX, this.follow ? this.h / 2 : e.offsetY);
      this.updateHover(e.offsetX, e.offsetY);
    }, { passive: false });

    const jump = (e: PointerEvent) => {
      const r = this.miniCanvas.getBoundingClientRect();
      const s = Math.min(r.width / (this.halfW * 2), r.height / (this.halfH * 2));
      const ox = (r.width - this.halfW * 2 * s) / 2, oy = (r.height - this.halfH * 2 * s) / 2;
      this.setFollow(false);
      this.cx = (e.clientX - r.left - ox) / s - this.halfW;
      this.cy = (e.clientY - r.top - oy) / s - this.halfH;
      this.dirty = true;
    };
    this.miniCanvas.addEventListener('pointerdown', (e) => {
      this.miniCanvas.setPointerCapture(e.pointerId);
      jump(e);
    });
    this.miniCanvas.addEventListener('pointermove', (e) => { if (e.buttons) jump(e); });
  }

  private updateHover(sx: number, sy: number) {
    const w = this.toWorld(sx, sy);
    const h = pixelToHex(w.x, w.y, S);
    if (hexLength(h) > this.radius) {
      if (this.hover) { this.hover = null; this.onHover(null); this.dirty = true; }
      return;
    }
    if (!this.hover || this.hover.q !== h.q || this.hover.r !== h.r) this.dirty = true;
    this.hover = h;
    this.onHover({ hex: h, x: sx, y: sy });
  }

  isTree(h: Hex) { return this.trees.has(hexKey(h)); }
  isExplored(h: Hex) { return !this.explored || this.explored.has(hexKey(h)); }

  // ------------------------------------------------------------ events → effects

  playEvents(events: GameEvent[], tanks: TankView[]) {
    const now = performance.now();
    const color = (id: string) => this.tankColors.get(id) ?? '#fff';
    let moveEnd = 0;

    for (const e of events) {
      if (e.type === 'move' && e.path.length > 1) {
        const dur = Math.min(700, 120 + 70 * (e.path.length - 1));
        moveEnd = Math.max(moveEnd, dur);
        this.anims.set(e.tankId, { path: e.path.map((h) => hexToPixel(h, S)), start: now, dur });
        this.facing.set(e.tankId, dirAngle(e.direction));
      } else if (e.type === 'move') {
        this.facing.set(e.tankId, dirAngle(e.direction));
      }
      if (e.type === 'move' && e.blockedBy && e.blockedAt) {
        const at = hexToPixel(e.blockedAt, S);
        this.addEffect(now + Math.min(700, 120 + 70 * (e.path.length - 1)), 500, (ctx, t) => {
          const p = this.toScreen(at.x, at.y);
          ctx.globalAlpha = 1 - t;
          ctx.strokeStyle = C.danger;
          ctx.lineWidth = 2;
          this.hexPath(ctx, p.x, p.y, S * this.zoom * (0.9 + t * 0.3));
          ctx.stroke();
        });
      }
    }

    for (const e of events) {
      const at0 = now + moveEnd;
      switch (e.type) {
        case 'fire': {
          this.facing.set(e.tankId, dirAngle(e.direction));
          const from = hexToPixel(e.from, S);
          const end = e.path.length ? hexToPixel(e.path[e.path.length - 1], S) : from;
          const col = color(e.tankId);
          this.addEffect(at0, 900, (ctx, t) => {
            const a = this.toScreen(from.x, from.y), b = this.toScreen(end.x, end.y);
            const grow = Math.min(1, t * 5);
            const bx = a.x + (b.x - a.x) * grow, by = a.y + (b.y - a.y) * grow;
            const fade = t < 0.3 ? 1 : 1 - (t - 0.3) / 0.7;
            const wid = Math.max(2, S * this.zoom * 0.28);
            ctx.lineCap = 'round';
            ctx.globalAlpha = 0.35 * fade;
            ctx.strokeStyle = col;
            ctx.lineWidth = wid * 3.2;
            line(ctx, a.x, a.y, bx, by);
            ctx.globalAlpha = fade;
            ctx.lineWidth = wid;
            line(ctx, a.x, a.y, bx, by);
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = Math.max(1, wid * 0.35);
            line(ctx, a.x, a.y, bx, by);
            if (grow >= 1) {
              ctx.globalAlpha = fade * 0.8;
              ctx.fillStyle = e.hit ? '#fff' : col;
              ctx.beginPath();
              ctx.arc(b.x, b.y, wid * (1.2 + t * 2), 0, Math.PI * 2);
              ctx.fill();
            }
          });
          break;
        }
        case 'damage': {
          const t = tanks.find((x) => x.id === e.tankId);
          if (!t?.pos) break;
          const p = hexToPixel(t.pos, S);
          this.addEffect(at0 + 180, 700, (ctx, k) => {
            const s = this.toScreen(p.x, p.y);
            ctx.globalAlpha = 1 - k;
            ctx.strokeStyle = C.danger;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(s.x, s.y, this.tankRadius() * (1 + k * 1.6), 0, Math.PI * 2);
            ctx.stroke();
          });
          this.floatText(p, `-${e.amount}`, C.danger, at0 + 180);
          if (!e.by) this.floatArrow(p, e.fromDirection, at0 + 180);
          break;
        }
        case 'destroyed':
          this.explosion(hexToPixel(e.at, S), color(e.tankId), at0 + 250);
          break;
        case 'pickup':
          this.floatText(hexToPixel(e.at, S), `+${e.amount}`, C.energy, now + moveEnd * 0.6);
          break;
        case 'wait': {
          const t = tanks.find((x) => x.id === e.tankId);
          const close = S * this.zoom >= 8 || e.tankId === this.myTankId;
          if (t?.pos && e.recharged > 0 && close) this.floatText(hexToPixel(t.pos, S), `+${e.recharged}`, '#7c8a9b', now);
          break;
        }
        case 'timeout': {
          const t = tanks.find((x) => x.id === e.tankId);
          if (t?.pos) this.floatText(hexToPixel(t.pos, S), 'timeout', '#ffb020', now);
          break;
        }
        case 'scan': {
          const c = hexToPixel(e.center, S);
          const col = color(e.tankId);
          const corners = DIRECTIONS.map((d) => {
            const v = hexToPixel(DIRECTION_VECTORS[d], S);
            return { x: v.x * (e.radius + 0.5), y: v.y * (e.radius + 0.5) };
          });
          this.addEffect(at0, 1200, (ctx, t) => {
            const grow = Math.min(1, t * 2.2);
            const fade = t < 0.45 ? 1 : 1 - (t - 0.45) / 0.55;
            const s = this.toScreen(c.x, c.y);
            ctx.beginPath();
            corners.forEach((k, i) => {
              const x = s.x + k.x * this.zoom * grow, y = s.y + k.y * this.zoom * grow;
              if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
            });
            ctx.closePath();
            ctx.globalAlpha = 0.08 * fade;
            ctx.fillStyle = col;
            ctx.fill();
            ctx.globalAlpha = 0.9 * fade;
            ctx.strokeStyle = col;
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 5]);
            ctx.stroke();
            ctx.setLineDash([]);
          });
          break;
        }
        case 'spawn':
          for (const h of e.cells) {
            const p = hexToPixel(h, S);
            this.addEffect(now, 900, (ctx, t) => {
              const s = this.toScreen(p.x, p.y);
              ctx.globalAlpha = 1 - t;
              ctx.strokeStyle = C.energy;
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.arc(s.x, s.y, 3 + t * Math.max(14, S * this.zoom * 1.4), 0, Math.PI * 2);
              ctx.stroke();
            });
          }
          break;
      }
    }
    this.dirty = true;
  }

  private addEffect(start: number, dur: number, draw: Effect['draw']) {
    this.effects.push({ start, dur, draw });
  }

  private floatText(p: { x: number; y: number }, text: string, color: string, start: number) {
    this.addEffect(start, 1100, (ctx, t) => {
      const s = this.toScreen(p.x, p.y);
      ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      ctx.font = '700 13px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(7,10,15,.9)';
      const y = s.y - this.tankRadius() - 36 - t * 22;
      ctx.strokeText(text, s.x, y);
      ctx.fillStyle = color;
      ctx.fillText(text, s.x, y);
    });
  }

  private floatArrow(p: { x: number; y: number }, from: Direction, start: number) {
    const ang = dirAngle(from);
    this.addEffect(start, 1600, (ctx, t) => {
      const s = this.toScreen(p.x, p.y);
      const r = this.tankRadius() + 10 + Math.sin(t * Math.PI * 4) * 2;
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = C.danger;
      ctx.save();
      ctx.translate(s.x + Math.cos(ang) * r, s.y + Math.sin(ang) * r);
      ctx.rotate(ang + Math.PI);
      ctx.beginPath();
      ctx.moveTo(8, 0); ctx.lineTo(-5, -6); ctx.lineTo(-5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
  }

  private explosion(p: { x: number; y: number }, color: string, start: number) {
    const parts = Array.from({ length: 26 }, (_, i) => ({
      a: (i / 26) * Math.PI * 2 + Math.random() * 0.3, v: 0.5 + Math.random(), c: i % 3 === 0 ? '#fff' : i % 3 === 1 ? color : '#ffb020',
    }));
    this.addEffect(start, 1300, (ctx, t) => {
      const s = this.toScreen(p.x, p.y);
      const base = Math.max(30, S * this.zoom * 4);
      ctx.globalAlpha = (1 - t) * 0.5;
      ctx.fillStyle = '#ffb020';
      ctx.beginPath();
      ctx.arc(s.x, s.y, base * 0.6 * Math.min(1, t * 4), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1 - t;
      for (const q of parts) {
        const d = base * q.v * easeOut(t);
        ctx.fillStyle = q.c;
        ctx.fillRect(s.x + Math.cos(q.a) * d - 2, s.y + Math.sin(q.a) * d - 2, 4, 4);
      }
    });
  }

  // ------------------------------------------------------------ drawing

  private tankRadius() {
    return Math.max(7, S * this.zoom * 0.62);
  }

  private tankWorldPos(t: TankView, now: number): { x: number; y: number } | null {
    const a = this.anims.get(t.id);
    if (a) {
      const k = Math.min(1, (now - a.start) / a.dur);
      if (k >= 1) this.anims.delete(t.id);
      else {
        const f = easeInOut(k) * (a.path.length - 1);
        const i = Math.floor(f), u = f - i;
        const p0 = a.path[i], p1 = a.path[Math.min(i + 1, a.path.length - 1)];
        return { x: p0.x + (p1.x - p0.x) * u, y: p0.y + (p1.y - p0.y) * u };
      }
    }
    return t.pos ? hexToPixel(t.pos, S) : null;
  }

  private hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, rad: number) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) ctx.lineTo(x + CORNERS[i].x * rad, y + CORNERS[i].y * rad);
    ctx.closePath();
  }

  /** Calls fn for every on-board hex overlapping the screen. */
  private forVisibleHexes(fn: (h: Hex, sx: number, sy: number) => void) {
    const tl = this.toWorld(0, 0), br = this.toWorld(this.w, this.h);
    const R = this.radius;
    const q0 = Math.max(-R, Math.floor(tl.x / (1.5 * S)) - 1), q1 = Math.min(R, Math.ceil(br.x / (1.5 * S)) + 1);
    for (let q = q0; q <= q1; q++) {
      const r0 = Math.max(-R, -q - R, Math.floor(tl.y / (SQRT3 * S) - q / 2) - 1);
      const r1 = Math.min(R, -q + R, Math.ceil(br.y / (SQRT3 * S) - q / 2) + 1);
      for (let r = r0; r <= r1; r++) {
        const s = this.toScreen(1.5 * S * q, SQRT3 * S * (r + q / 2));
        fn({ q, r }, s.x, s.y);
      }
    }
  }

  private frame(now: number) {
    // Ease camera zoom, follow own tank.
    if (this.targetZoom !== null) {
      this.zoom += (this.targetZoom - this.zoom) * 0.18;
      if (Math.abs(this.targetZoom - this.zoom) < 0.0005) { this.zoom = this.targetZoom; this.targetZoom = null; }
      this.dirty = true;
    }
    if (this.follow && this.myTankId && this.snap) {
      const me = this.snap.tanks.find((t) => t.id === this.myTankId);
      const p = me && this.tankWorldPos(me, now);
      if (p) {
        const dx = p.x - this.cx, dy = p.y - this.cy;
        if (Math.abs(dx) + Math.abs(dy) > 0.05) { this.cx += dx * 0.15; this.cy += dy * 0.15; this.dirty = true; }
      }
    }

    this.effects = this.effects.filter((e) => now < e.start + e.dur);
    const animating = this.anims.size > 0 || this.effects.length > 0;
    // Idle frames only redraw ~15 fps for the gentle energy pulse.
    if (!this.dirty && !animating && now - this.lastDraw < 66) return;
    this.dirty = false;
    this.lastDraw = now;
    this.draw(now);
    if (now - this.lastMini > 200) { this.lastMini = now; this.drawMinimap(); }
  }

  private draw(now: number) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.stage;
    ctx.fillRect(0, 0, this.w, this.h);
    if (!this.radius) return;

    const hexPx = S * this.zoom;

    // Terrain from cache.
    const tl = this.toScreen(-this.halfW, -this.halfH);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.cache, tl.x, tl.y, this.halfW * 2 * this.zoom, this.halfH * 2 * this.zoom);

    // Grid lines once hexes are big enough to read (3 edges per hex, one stroke).
    if (hexPx >= 8) {
      ctx.beginPath();
      this.forVisibleHexes((_, x, y) => {
        ctx.moveTo(x + CORNERS[3].x * hexPx, y + CORNERS[3].y * hexPx);
        for (let i = 4; i <= 6; i++) ctx.lineTo(x + CORNERS[i % 6].x * hexPx, y + CORNERS[i % 6].y * hexPx);
      });
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.globalAlpha = Math.min(1, (hexPx - 8) / 6);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Crisp trees with canopy detail when zoomed in.
    if (hexPx >= 13) {
      this.forVisibleHexes((h, x, y) => {
        const k = `${h.q},${h.r}`;
        if (!this.trees.has(k)) return;
        this.hexPath(ctx, x, y, hexPx * 1.01);
        ctx.fillStyle = C.tree;
        ctx.fill();
        const n = hash2(h.q, h.r, 5);
        for (let i = 0; i < 3; i++) {
          const a = n * 6.28 + i * 2.1, d = hexPx * 0.32;
          ctx.fillStyle = C.canopy[(i + Math.floor(n * 3)) % 3];
          ctx.beginPath();
          ctx.arc(x + Math.cos(a) * d * 0.8, y + Math.sin(a) * d * 0.7, hexPx * (0.32 + ((n * 10 + i) % 1) * 0.1), 0, Math.PI * 2);
          ctx.fill();
        }
      });
    }

    this.drawBoardEdge(ctx);

    // Hover highlight, plus a firing line from my tank when the hovered hex is in line.
    const snap = this.snap;
    const me = snap?.tanks.find((t) => t.id === this.myTankId);
    if (this.hover) {
      const s = this.hexScreen(this.hover);
      if (me?.pos && me.alive) {
        const dir = alignedDirection(me.pos, this.hover);
        if (dir) {
          const a = this.hexScreen(me.pos);
          ctx.setLineDash([4, 6]);
          ctx.strokeStyle = me.color;
          ctx.globalAlpha = 0.7;
          ctx.lineWidth = 1.5;
          line(ctx, a.x, a.y, s.x, s.y);
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
      }
      this.hexPath(ctx, s.x, s.y, Math.max(hexPx, 4));
      ctx.strokeStyle = 'rgba(255,255,255,.7)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (!snap) return;

    // Effects under tanks (scan rings etc. draw here too; ordering is fine for v0.1).
    // Energy cells.
    const pulse = 0.75 + 0.25 * Math.sin(now / 350);
    const er = Math.max(2.5, hexPx * 0.36);
    for (let i = 0; i < snap.energy.length; i += 3) {
      const s = this.hexScreen({ q: snap.energy[i], r: snap.energy[i + 1] });
      if (s.x < -20 || s.y < -20 || s.x > this.w + 20 || s.y > this.h + 20) continue;
      ctx.globalAlpha = 0.18 * pulse;
      ctx.fillStyle = C.energy;
      ctx.beginPath();
      ctx.arc(s.x, s.y, er * 2.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - er); ctx.lineTo(s.x + er * 0.72, s.y); ctx.lineTo(s.x, s.y + er); ctx.lineTo(s.x - er * 0.72, s.y);
      ctx.closePath();
      ctx.fillStyle = C.energy;
      ctx.fill();
      if (er > 4) {
        ctx.fillStyle = C.energyCore;
        ctx.globalAlpha = pulse;
        ctx.beginPath();
        ctx.arc(s.x, s.y, er * 0.22, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // Tanks: dead first, then ghosts (player view), then live ones on top.
    const order = [...snap.tanks].sort((a, b) => Number(a.alive) - Number(b.alive));
    for (const t of order) this.drawTank(ctx, t, now);

    // Effects.
    for (const e of this.effects) {
      if (now < e.start) continue;
      ctx.save();
      e.draw(ctx, Math.min(1, (now - e.start) / e.dur));
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  private drawBoardEdge(ctx: CanvasRenderingContext2D) {
    const pts = DIRECTIONS.map((d) => {
      const v = hexToPixel(DIRECTION_VECTORS[d], S);
      return this.toScreen(v.x * (this.radius + 0.55), v.y * (this.radius + 0.55));
    });
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.strokeStyle = C.edge;
    ctx.globalAlpha = 0.12;
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawTank(ctx: CanvasRenderingContext2D, t: TankView, now: number) {
    const wp = this.tankWorldPos(t, now);
    if (!wp) return;
    const s = this.toScreen(wp.x, wp.y);
    const r = this.tankRadius();
    if (s.x < -80 || s.y < -80 || s.x > this.w + 80 || s.y > this.h + 80) return;
    const ghost = t.seenTick !== undefined && t.id !== this.myTankId && t.alive;
    const isMe = t.id === this.myTankId;
    ctx.save();

    if (!t.alive) {
      ctx.globalAlpha = 0.55;
      this.hexPath(ctx, s.x, s.y, r * 0.9);
      ctx.fillStyle = '#2a3340';
      ctx.fill();
      ctx.strokeStyle = '#4a5868';
      ctx.lineWidth = 2;
      line(ctx, s.x - r * 0.45, s.y - r * 0.45, s.x + r * 0.45, s.y + r * 0.45);
      line(ctx, s.x + r * 0.45, s.y - r * 0.45, s.x - r * 0.45, s.y + r * 0.45);
      ctx.restore();
      return;
    }

    if (ghost) {
      const age = (this.snap?.tick ?? 0) - (t.seenTick ?? 0);
      ctx.globalAlpha = Math.max(0.25, 0.75 - age * 0.05);
      ctx.setLineDash([3, 3]);
    }

    // Focus ring after clicking a tank card.
    if (this.focusRing?.id === t.id) {
      const k = (now - this.focusRing.start) / 1500;
      if (k < 1) {
        ctx.strokeStyle = t.color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 1 - k;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r * (1.4 + k * 2.5), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        this.dirty = true;
      } else this.focusRing = null;
    }

    // Soft glow.
    const g = ctx.createRadialGradient(s.x, s.y, r * 0.4, s.x, s.y, r * 2.2);
    g.addColorStop(0, hexA(t.color, ghost ? 0.12 : 0.35));
    g.addColorStop(1, hexA(t.color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * 2.2, 0, Math.PI * 2);
    ctx.fill();

    if (isMe) {
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.5 + 0.3 * Math.sin(now / 300);
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * 1.55, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Body: hexagonal hull, darker core, turret toward facing.
    const ang = this.facing.get(t.id) ?? 0;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(ang);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r * 0.86);
    }
    ctx.closePath();
    ctx.fillStyle = ghost ? hexA(t.color, 0.35) : t.color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(7,10,15,.8)';
    ctx.stroke();
    ctx.fillStyle = 'rgba(7,10,15,.55)';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = ghost ? hexA(t.color, 0.6) : '#fff';
    ctx.lineWidth = Math.max(2, r * 0.22);
    ctx.lineCap = 'round';
    line(ctx, 0, 0, r * 1.15, 0);
    ctx.restore();
    ctx.setLineDash([]);

    // Label + HP bar.
    const label = ghost ? `${t.name} · ${Math.max(0, (this.snap?.tick ?? 0) - (t.seenTick ?? 0))}t ago` : t.name;
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    const tw = ctx.measureText(label).width + 12;
    const ly = s.y - r - 20;
    ctx.fillStyle = 'rgba(10,14,20,.85)';
    roundRect(ctx, s.x - tw / 2, ly - 8, tw, 17, 5);
    ctx.fill();
    ctx.fillStyle = ghost ? '#9aa6b4' : C.text;
    ctx.fillText(label, s.x, ly + 4);

    if (t.hp !== undefined) {
      const bw = Math.max(26, r * 2.4), by = s.y + r + 7;
      const hp = Math.max(0, t.hp) / 100;
      ctx.fillStyle = 'rgba(10,14,20,.85)';
      roundRect(ctx, s.x - bw / 2 - 1, by - 1, bw + 2, 6, 3);
      ctx.fill();
      ctx.fillStyle = hp > 0.5 ? '#3ddc97' : hp > 0.25 ? '#ffb020' : '#ff4d5e';
      roundRect(ctx, s.x - bw / 2, by, bw * hp, 4, 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawMinimap() {
    const m = this.mini;
    const W = this.miniCanvas.width, H = this.miniCanvas.height;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(0, 0, W, H);
    if (!this.radius) return;
    const s = Math.min(W / (this.halfW * 2), H / (this.halfH * 2));
    const ox = (W - this.halfW * 2 * s) / 2, oy = (H - this.halfH * 2 * s) / 2;
    m.drawImage(this.cache, ox, oy, this.halfW * 2 * s, this.halfH * 2 * s);
    const P = (x: number, y: number) => ({ x: ox + (x + this.halfW) * s, y: oy + (y + this.halfH) * s });

    if (this.snap) {
      m.fillStyle = C.energy;
      for (let i = 0; i < this.snap.energy.length; i += 3) {
        const w = hexToPixel({ q: this.snap.energy[i], r: this.snap.energy[i + 1] }, S);
        const p = P(w.x, w.y);
        m.fillRect(p.x - 1, p.y - 1, 2 * this.dpr, 2 * this.dpr);
      }
      for (const t of this.snap.tanks) {
        if (!t.pos) continue;
        const w = hexToPixel(t.pos, S), p = P(w.x, w.y);
        m.globalAlpha = t.alive ? (t.seenTick !== undefined && t.id !== this.myTankId ? 0.5 : 1) : 0.35;
        m.fillStyle = t.alive ? t.color : '#4a5868';
        m.beginPath();
        m.arc(p.x, p.y, 3.5 * this.dpr, 0, Math.PI * 2);
        m.fill();
        m.globalAlpha = 1;
      }
    }
    // Viewport.
    const a = this.toWorld(0, 0), b = this.toWorld(this.w, this.h);
    const pa = P(a.x, a.y), pb = P(b.x, b.y);
    m.strokeStyle = 'rgba(255,255,255,.8)';
    m.lineWidth = this.dpr;
    m.strokeRect(pa.x, pa.y, pb.x - pa.x, pb.y - pa.y);
  }

  hexDistanceFromMe(h: Hex): { distance: number; inLine: Direction | null } | null {
    const me = this.snap?.tanks.find((t) => t.id === this.myTankId);
    if (!me?.pos) return null;
    return { distance: hexDistance(me.pos, h), inLine: alignedDirection(me.pos, h) };
  }
}

// ------------------------------------------------------------ helpers

function dirAngle(d: Direction) {
  const v = hexToPixel(DIRECTION_VECTORS[d], 1);
  return Math.atan2(v.y, v.x);
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(0, w), h, Math.min(r, h / 2, Math.max(0, w) / 2));
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
