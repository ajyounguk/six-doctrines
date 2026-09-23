import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalHex, hexKey, symmetricImages, alignedDirection } from '../shared/hex.js';
import { DEFAULT_RULES, type Rules } from '../shared/rules.js';
import { decideBotAction } from '../bot/brain.js';
import { botInputFromTank } from '../bot/fromTank.js';
import { Game } from './game.js';
import { generateTrees, spawnCorner } from './map.js';

const small: Rules = { ...DEFAULT_RULES, boardRadius: 40, spawnInset: 5 };

test('terrain is identical under all 12 hex symmetries', () => {
  const trees = generateTrees(small, 1234);
  assert.ok(trees.size > 0);
  for (const k of trees) {
    const [q, r] = k.split(',').map(Number);
    for (const img of symmetricImages({ q, r })) assert.ok(trees.has(hexKey(img)), `missing mirror of ${k}`);
  }
});

test('canonical hex is stable across an orbit', () => {
  const imgs = symmetricImages({ q: 7, r: -3 });
  const c = hexKey(canonicalHex(imgs[0]));
  for (const i of imgs) assert.equal(hexKey(canonicalHex(i)), c);
});

test('in-line detection', () => {
  assert.equal(alignedDirection({ q: 0, r: 0 }, { q: 0, r: -5 }), 'N');
  assert.equal(alignedDirection({ q: 0, r: 0 }, { q: 3, r: -3 }), 'NE');
  assert.equal(alignedDirection({ q: 0, r: 0 }, { q: -2, r: 2 }), 'SW');
  assert.equal(alignedDirection({ q: 0, r: 0 }, { q: 2, r: 1 }), null);
});

test('head-on lasers land simultaneously', () => {
  const g = new Game({ ...small, treeDensity: 0 }, 1);
  const a = g.join('A'), b = g.join('B');
  g.start();
  a.pos = { q: 0, r: 0 };
  b.pos = { q: 0, r: -5 };
  a.hp = b.hp = 25;
  g.submit(a.id, { type: 'fire', direction: 'N', power: 5 });
  g.submit(b.id, { type: 'fire', direction: 'S', power: 5 });
  const res = g.resolveTick();
  assert.equal(a.alive, false);
  assert.equal(b.alive, false);
  assert.equal(g.phase, 'finished');
  assert.equal(res.reports.get(a.id)!.hitsTaken[0].fromDirection, 'N');
});

test('two tanks entering the same hex both stop', () => {
  const g = new Game({ ...small, treeDensity: 0 }, 1);
  const a = g.join('A'), b = g.join('B');
  g.start();
  // Both want (-1,-1) on the first sub-step.
  a.pos = { q: -2, r: 0 };
  b.pos = { q: 0, r: -2 };
  g.submit(a.id, { type: 'move', direction: 'NE', distance: 3 });
  g.submit(b.id, { type: 'move', direction: 'SW', distance: 3 });
  g.resolveTick();
  assert.deepEqual(a.pos, { q: -2, r: 0 });
  assert.deepEqual(b.pos, { q: 0, r: -2 });
  assert.equal(a.energy, small.startEnergy);
});

test('laser cooldown is enforced', () => {
  const g = new Game(small, 1);
  const a = g.join('A');
  g.start();
  g.submit(a.id, { type: 'fire', direction: 'N', power: 1 });
  g.resolveTick();
  assert.throws(() => g.submit(a.id, { type: 'fire', direction: 'N', power: 1 }), /cooling down/);
});

test('spawn corners are equidistant from the centre', () => {
  const d = [0, 1, 2, 3, 4, 5].map((i) => {
    const h = spawnCorner(i, small);
    return Math.max(Math.abs(h.q), Math.abs(h.r), Math.abs(h.q + h.r));
  });
  assert.ok(d.every((x) => x === d[0]));
});

function playBots(seed: number) {
  const g = new Game({ ...small, maxTicks: 300 }, seed);
  for (const n of ['A', 'B', 'C', 'D']) g.join(n, { isBot: true });
  g.start();
  while (g.phase === 'running') {
    for (const t of g.aliveTanks()) {
      try { g.submit(t.id, decideBotAction(botInputFromTank(g, t))); }
      catch { g.submit(t.id, { type: 'wait' }); }
    }
    g.resolveTick();
  }
  return g;
}

test('bot match runs to completion and is deterministic', () => {
  const g1 = playBots(42), g2 = playBots(42);
  assert.equal(g1.phase, 'finished');
  assert.equal(g1.tick, g2.tick);
  assert.equal(g1.winnerId, g2.winnerId);
  assert.deepEqual([...g1.tanks.values()].map((t) => t.stats), [...g2.tanks.values()].map((t) => t.stats));
});
