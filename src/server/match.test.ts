import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES } from '../shared/rules.js';
import { Match } from './match.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fast = { ...DEFAULT_RULES, gridRadius: 20, spawnInset: 4, turnTimeoutMs: 40, minTickMs: 0, maxTicks: 10_000 };

test('a player who stops acting goes idle, and ticks stop waiting for them', async () => {
  const m = new Match(fast, 1);
  const gone = m.join('Gone');
  m.join('Bot', { isBot: true });
  m.start();
  await sleep(200); // several 40ms timeouts
  assert.ok(m.idle.has(gone.id), 'should be idle after repeated timeouts');

  // Once idle, ticks resolve at bot speed rather than waiting out the timeout.
  // (Waiting would allow at most ~2 ticks in 100ms; Windows timers tick at ~15ms, so expect several.)
  const before = m.game.tick;
  await sleep(100);
  assert.ok(m.game.tick - before >= 4, `expected fast ticks, got ${m.game.tick - before}`);

  // Acting again wakes them up.
  m.submit(gone.id, { type: 'wait' }).catch(() => {});
  assert.ok(!m.idle.has(gone.id));
  m.pause();
});

test('a reused id after a kick does not inherit idle state', async () => {
  const m = new Match(fast, 2);
  const gone = m.join('Gone');
  m.join('Bot', { isBot: true });
  m.start();
  await sleep(200);
  assert.ok(m.idle.has(gone.id));

  m.reset(3);
  m.kick(gone.id);
  const fresh = m.join('Fresh');
  assert.equal(fresh.id, gone.id, 'test assumes the freed id is reused');
  assert.ok(!m.idle.has(fresh.id), 'new player must not start idle');
});
