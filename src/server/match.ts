// Turn controller. Owns the clock around a Game: opens ticks, waits for every live proxy
// to act (or time out), resolves, and tells everyone what happened.

import { Game, GameError, type ProxyDrone, type ProxyReport, type TickResult } from '../engine/game.js';
import { randomSeed } from '../engine/rng.js';
import type { Action } from '../shared/protocol.js';
import type { Rules } from '../shared/rules.js';
import { decideBotAction } from '../bot/brain.js';
import { botInputFromProxy } from '../bot/fromProxy.js';

type Listener = (result?: TickResult) => void;

/** Consecutive timeouts before a player counts as idle. */
const IDLE_AFTER = 2;

interface Waiter {
  resolve: (r: ProxyReport) => void;
  reject: (e: Error) => void;
}

export class Match {
  game: Game;
  deadline: number | null = null;
  /** Minimum tick length; the host can change it mid-match. Doesn't affect game outcomes. */
  tickMs: number;
  /**
   * Proxies whose player seems to have gone (timed out IDLE_AFTER ticks in a row). Ticks stop
   * waiting for them; they still take a timeout each tick, and any action they submit wakes them.
   */
  readonly idle = new Set<string>();
  private timeoutStreak = new Map<string, number>();

  private waiters = new Map<string, Waiter>();
  private startWaiters = new Set<() => void>();
  private listeners = new Set<Listener>();
  private tickTimer: NodeJS.Timeout | null = null;
  private resolveTimer: NodeJS.Timeout | null = null;
  private tickOpenedAt = 0;
  private remainingMs: number | null = null; // time left on the clock when paused

  constructor(readonly rules: Rules, seed: number) {
    this.game = new Game(rules, seed);
    this.tickMs = rules.minTickMs;
  }

  setTickMs(ms: number) {
    this.tickMs = Math.max(50, Math.min(5000, Math.round(ms)));
    this.emit();
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(result?: TickResult) {
    for (const fn of this.listeners) {
      try { fn(result); } catch (e) { console.error('listener failed', e); }
    }
  }

  // ---------------------------------------------------------------- lobby

  join(name: string, opts: { isBot?: boolean } = {}): ProxyDrone {
    const t = this.game.join(name, opts);
    this.forgetIdle(t.id); // ids can be reused after a kick
    this.emit();
    return t;
  }

  findByToken(token: string): ProxyDrone | undefined {
    return [...this.game.proxies.values()].find((t) => t.token === token);
  }

  kick(proxyId: string) {
    this.game.leave(proxyId);
    this.forgetIdle(proxyId);
    this.emit();
  }

  private forgetIdle(proxyId: string) {
    this.idle.delete(proxyId);
    this.timeoutStreak.delete(proxyId);
  }

  /** Resolves when the match starts, or after `maxWaitMs` if it hasn't. */
  waitForStart(maxWaitMs: number): Promise<boolean> {
    if (this.game.phase !== 'lobby') return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.startWaiters.delete(done); resolve(this.game.phase !== 'lobby'); };
      const timer = setTimeout(done, maxWaitMs);
      this.startWaiters.add(done);
    });
  }

  // ---------------------------------------------------------------- host controls

  start() {
    this.game.start();
    for (const fn = [...this.startWaiters]; fn.length; ) fn.pop()!();
    this.openTick(this.rules.turnTimeoutMs);
    this.emit();
  }

  pause() {
    if (this.game.phase !== 'running') return;
    this.remainingMs = this.deadline ? Math.max(1000, this.deadline - Date.now()) : null;
    this.clearTimers();
    this.deadline = null;
    this.game.pause();
    this.emit();
  }

  resume() {
    if (this.game.phase !== 'paused') return;
    this.game.resume();
    this.openTick(this.remainingMs ?? this.rules.turnTimeoutMs, true);
    this.emit();
  }

  /** New battlefield, same players, back to the lobby. */
  reset(seed = randomSeed()) {
    this.clearTimers();
    this.deadline = null;
    for (const w of this.waiters.values()) w.reject(new GameError('The host reset the match. Call wait_for_start.'));
    this.waiters.clear();
    this.timeoutStreak.clear(); // idle players stay idle until they act again
    const old = [...this.game.proxies.values()].sort((a, b) => a.joinOrder - b.joinOrder);
    this.game = new Game(this.rules, seed);
    // Same ids and tokens, so bound MCP sessions and player links keep working.
    for (const t of old) this.game.join(t.name, { isBot: t.isBot, token: t.token, id: t.id });
    this.emit();
  }

  // ---------------------------------------------------------------- turns

  /** Queues an action and resolves with this proxy's report once the tick resolves. */
  submit(proxyId: string, action: Action): Promise<ProxyReport> {
    this.game.submit(proxyId, action);
    this.idle.delete(proxyId);
    this.timeoutStreak.set(proxyId, 0);
    const p = new Promise<ProxyReport>((resolve, reject) => this.waiters.set(proxyId, { resolve, reject }));
    this.emit();
    this.maybeResolve();
    return p;
  }

  private openTick(timeoutMs: number, resumed = false) {
    this.clearTimers();
    if (!resumed) this.tickOpenedAt = Date.now();
    this.deadline = Date.now() + timeoutMs;
    this.tickTimer = setTimeout(() => this.resolveNow(), timeoutMs);
    this.runBots();
    this.maybeResolve();
  }

  private runBots() {
    for (const t of this.game.aliveProxies()) {
      if (!t.isBot || this.game.hasSubmitted(t.id)) continue;
      const action = decideBotAction(botInputFromProxy(this.game, t));
      try {
        this.game.submit(t.id, action);
      } catch {
        this.game.submit(t.id, { type: 'wait' });
      }
    }
  }

  private maybeResolve() {
    if (this.game.phase !== 'running' || !this.game.allSubmitted(this.idle) || this.resolveTimer) return;
    const wait = Math.max(0, this.tickOpenedAt + this.tickMs - Date.now());
    this.resolveTimer = setTimeout(() => this.resolveNow(), wait);
  }

  private resolveNow() {
    this.clearTimers();
    if (this.game.phase !== 'running') return;
    const result = this.game.resolveTick();
    for (const [id, rep] of result.reports) {
      const streak = rep.action === null ? (this.timeoutStreak.get(id) ?? 0) + 1 : 0;
      this.timeoutStreak.set(id, streak);
      if (streak >= IDLE_AFTER) this.idle.add(id);
    }
    for (const [id, w] of this.waiters) {
      const rep = result.reports.get(id);
      if (rep) w.resolve(rep);
      else w.reject(new GameError('Your action was not resolved.'));
    }
    this.waiters.clear();
    this.deadline = null;
    if (this.game.phase === 'running') this.openTick(this.rules.turnTimeoutMs);
    this.emit(result);
  }

  private clearTimers() {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.resolveTimer) clearTimeout(this.resolveTimer);
    this.tickTimer = this.resolveTimer = null;
  }
}
