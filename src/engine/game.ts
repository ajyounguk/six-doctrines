// The Six Doctrines engine. Pure game logic: no timers, no I/O. The server decides *when*
// a tick resolves; the engine decides *what* happens. Given the same seed, rules and
// action log, a match always plays out identically.

import {
  DIRECTIONS, type Direction, type Hex,
  alignedDirection, hexDistance, hexKey, hexesInRange, neighbor, parseKey, symmetricImages,
} from '../shared/hex.js';
import type { Action, BlockReason, GameEvent, Phase, ProxyStats } from '../shared/protocol.js';
import { type Rules, SPAWN_SLOTS, PROXY_COLORS, scanCost } from '../shared/rules.js';
import { onGrid, spawnCorner, generateForest } from './map.js';
import { type Rng, createRng, randInt, shuffle } from './rng.js';

export class GameError extends Error {}

export interface SeenEnergy { value: number; tick: number }
export interface SeenProxy { pos: Hex; hp: number; tick: number }

export interface ProxyDrone {
  id: string;
  name: string;
  color: string;
  /** Secret handed to the proxy's owner: rejoins the proxy and opens its player view. */
  token: string;
  isBot: boolean;
  joinOrder: number;
  pos: Hex;
  hp: number;
  energy: number;
  alive: boolean;
  canFireAtTick: number;
  lastAction: Action | null;
  deathTick?: number;
  placement?: number;
  stats: ProxyStats;
  // What this proxy knows. Append-only logs let viewers stream deltas.
  explored: Set<string>;
  exploredLog: string[];
  knownForest: Set<string>;
  knownForestLog: string[];
  seenEnergy: Map<string, SeenEnergy>;
  seenProxies: Map<string, SeenProxy>;
}

export interface ScanResult {
  center: Hex;
  radius: number;
  forest: Hex[];
  energy: { at: Hex; value: number }[];
  proxies: { id: string; name: string; at: Hex; hp: number }[];
}

/** Everything that happened to one proxy in one tick, for the agent that drives it. */
export interface ProxyReport {
  tick: number;
  action: Action | null; // null = timed out
  moved?: { from: Hex; to: Hex; hexes: number; requested: number; blockedBy?: BlockReason; blockedAt?: Hex };
  fired?: { direction: Direction; power: number; hitProxyId?: string; hitProxyName?: string; stoppedBy: string; endAt: Hex };
  scan?: ScanResult;
  recharged?: number;
  pickups: { at: Hex; amount: number }[];
  hitsTaken: { fromDirection: Direction; amount: number }[];
  destroyed: boolean;
  energySpent: number;
}

export interface TickResult {
  tick: number;
  events: GameEvent[];
  reports: Map<string, ProxyReport>;
}

const emptyStats = (): ProxyStats => ({
  kills: 0, damageDealt: 0, damageTaken: 0, shotsFired: 0, shotsHit: 0,
  hexesMoved: 0, energyCollected: 0, scans: 0, timeouts: 0,
});

const opposite = (d: Direction): Direction => DIRECTIONS[(DIRECTIONS.indexOf(d) + 3) % 6];

export class Game {
  readonly rules: Rules;
  readonly seed: number;
  readonly forest: Set<string>;
  readonly energyCells = new Map<string, number>();
  readonly proxies = new Map<string, ProxyDrone>();

  phase: Phase = 'lobby';
  tick = 0;
  winnerId: string | null = null;
  lastEvents: GameEvent[] = [];
  lastEventsTick = 0;
  /** Every submitted action by tick, enough to replay the match. */
  readonly actionLog: { tick: number; actions: Record<string, Action | null> }[] = [];

  private rng: Rng;
  private pending = new Map<string, Action>();
  private startedWith = 0;
  private nextId = 1;
  private joinCounter = 0;

  constructor(rules: Rules, seed: number) {
    this.rules = rules;
    this.seed = seed;
    this.rng = createRng(seed);
    this.forest = generateForest(rules, seed);
  }

  // ---------------------------------------------------------------- lobby

  join(name: string, opts: { isBot?: boolean; token?: string; id?: string } = {}): ProxyDrone {
    if (this.phase !== 'lobby') throw new GameError('The match has already started; wait for the next one.');
    if (this.proxies.size >= this.rules.maxPlayers) throw new GameError(`The battlefield is full (${this.rules.maxPlayers} proxies).`);

    const clean = name.trim().slice(0, 24) || 'Proxy';
    let unique = clean;
    for (let n = 2; [...this.proxies.values()].some((t) => t.name === unique); n++) unique = `${clean} ${n}`;

    const used = new Set([...this.proxies.values()].map((t) => t.color));
    let id = opts.id;
    if (!id || this.proxies.has(id)) {
      while (this.proxies.has(`t${this.nextId}`)) this.nextId++;
      id = `t${this.nextId++}`;
    }
    const proxy: ProxyDrone = {
      id,
      name: unique,
      color: PROXY_COLORS.find((c) => !used.has(c)) ?? PROXY_COLORS[0],
      token: opts.token ?? crypto.randomUUID().replace(/-/g, ''),
      isBot: !!opts.isBot,
      joinOrder: ++this.joinCounter,
      pos: { q: 0, r: 0 },
      hp: this.rules.startHp,
      energy: this.rules.startEnergy,
      alive: true,
      canFireAtTick: 0,
      lastAction: null,
      stats: emptyStats(),
      explored: new Set(), exploredLog: [],
      knownForest: new Set(), knownForestLog: [],
      seenEnergy: new Map(),
      seenProxies: new Map(),
    };
    this.proxies.set(proxy.id, proxy);
    return proxy;
  }

  leave(proxyId: string): void {
    if (this.phase !== 'lobby') throw new GameError('Proxies can only be removed in the lobby.');
    this.proxies.delete(proxyId);
  }

  start(): void {
    if (this.phase !== 'lobby') throw new GameError('Match already started.');
    const proxies = [...this.proxies.values()];
    if (proxies.length === 0) throw new GameError('Need at least one proxy to start.');

    const slots = shuffle(this.rng, [...SPAWN_SLOTS[proxies.length]]);
    proxies.forEach((t, i) => (t.pos = spawnCorner(slots[i], this.rules)));
    for (let i = 0; i < this.rules.initialEnergyWaves; i++) this.spawnEnergyWave();

    this.startedWith = proxies.length;
    this.phase = 'running';
    this.tick = 1;
    for (const t of proxies) this.observe(t, t.pos, this.rules.passiveSightRadius);
  }

  // ---------------------------------------------------------------- queries

  aliveProxies(): ProxyDrone[] {
    return [...this.proxies.values()].filter((t) => t.alive);
  }

  hasSubmitted(proxyId: string): boolean {
    return this.pending.has(proxyId);
  }

  /** True when every live proxy has acted, not counting `skip` (idle players the server won't wait for). */
  allSubmitted(skip: ReadonlySet<string> = new Set()): boolean {
    return this.aliveProxies().every((t) => skip.has(t.id) || this.pending.has(t.id));
  }

  proxyAt(h: Hex): ProxyDrone | undefined {
    return this.aliveProxies().find((t) => t.pos.q === h.q && t.pos.r === h.r);
  }

  // ---------------------------------------------------------------- actions

  /** Validates and queues an action for the current tick. Throws GameError with an agent-readable reason. */
  submit(proxyId: string, action: Action): void {
    const t = this.proxies.get(proxyId);
    if (!t) throw new GameError('Unknown proxy.');
    if (this.phase === 'lobby') throw new GameError('The match has not started yet. Call wait_for_start.');
    if (this.phase === 'finished') throw new GameError('The match is over.');
    if (!t.alive) throw new GameError('Your proxy has been destroyed.');
    if (this.pending.has(proxyId)) throw new GameError(`You already submitted an action for tick ${this.tick}.`);

    const R = this.rules;
    const isInt = (n: number) => Number.isInteger(n);
    switch (action.type) {
      case 'move': {
        if (!DIRECTIONS.includes(action.direction)) throw new GameError(`Direction must be one of ${DIRECTIONS.join(', ')}.`);
        if (!isInt(action.distance) || action.distance < 1 || action.distance > R.maxMoveDistance)
          throw new GameError(`Move distance must be a whole number from 1 to ${R.maxMoveDistance}.`);
        const cost = action.distance * R.moveCostPerHex;
        if (cost > t.energy) throw new GameError(`Moving ${action.distance} hexes costs ${cost} energy; you have ${t.energy}.`);
        break;
      }
      case 'scan': {
        if (!isInt(action.radius) || action.radius < 1 || action.radius > R.maxScanRadius)
          throw new GameError(`Scan radius must be a whole number from 1 to ${R.maxScanRadius}.`);
        const cost = scanCost(R, action.radius);
        if (cost > t.energy) throw new GameError(`A radius ${action.radius} scan costs ${cost} energy; you have ${t.energy}.`);
        break;
      }
      case 'fire': {
        if (!DIRECTIONS.includes(action.direction)) throw new GameError(`Direction must be one of ${DIRECTIONS.join(', ')}.`);
        if (!isInt(action.power) || action.power < 1 || action.power > R.maxLaserPower)
          throw new GameError(`Laser power must be a whole number from 1 to ${R.maxLaserPower}.`);
        if (action.power > t.energy) throw new GameError(`Firing with power ${action.power} costs ${action.power} energy; you have ${t.energy}.`);
        if (this.tick < t.canFireAtTick) throw new GameError(`Laser is cooling down; it can fire again on tick ${t.canFireAtTick}.`);
        break;
      }
      case 'wait':
        break;
      default:
        throw new GameError('Unknown action.');
    }
    this.pending.set(proxyId, action);
  }

  // ---------------------------------------------------------------- resolution

  /**
   * Resolves the current tick. All actions happen simultaneously, in fixed phases:
   *   1. movement (in lock-step, one hex at a time)  2. lasers (from post-move positions)
   *   3. damage + destruction  4. energy spawns  5. scans  6. passive sight
   */
  resolveTick(): TickResult {
    if (this.phase !== 'running') throw new GameError(`Cannot resolve a tick while ${this.phase}.`);
    const R = this.rules;
    const tick = this.tick;
    const events: GameEvent[] = [];
    const reports = new Map<string, ProxyReport>();
    const alive = this.aliveProxies();

    const actions = new Map<string, Action | null>();
    for (const t of alive) {
      const a = this.pending.get(t.id) ?? null;
      actions.set(t.id, a);
      t.lastAction = a;
      reports.set(t.id, { tick, action: a, pickups: [], hitsTaken: [], destroyed: false, energySpent: 0 });
    }
    this.actionLog.push({ tick, actions: Object.fromEntries(actions) });
    this.pending.clear();

    // Timeouts and waits.
    for (const t of alive) {
      const a = actions.get(t.id);
      if (a === null) {
        t.stats.timeouts++;
        events.push({ type: 'timeout', proxyId: t.id });
      } else if (a?.type === 'wait') {
        const gained = Math.min(R.waitRecharge, R.maxEnergy - t.energy);
        t.energy += gained;
        reports.get(t.id)!.recharged = gained;
        events.push({ type: 'wait', proxyId: t.id, recharged: gained });
      }
    }

    this.resolveMoves(alive, actions, reports, events);
    this.resolveLasers(alive, actions, reports, events, tick);

    if (tick % R.energySpawnInterval === 0) {
      const ev = this.spawnEnergyWave();
      if (ev) events.push(ev);
    }

    // Scans see the battlefield as it stands at the end of the tick.
    for (const t of alive) {
      const a = actions.get(t.id);
      if (a?.type !== 'scan' || !t.alive) continue;
      const cost = scanCost(R, a.radius);
      t.energy -= cost;
      t.stats.scans++;
      const rep = reports.get(t.id)!;
      rep.energySpent += cost;
      rep.scan = this.observe(t, t.pos, a.radius);
      events.push({ type: 'scan', proxyId: t.id, center: t.pos, radius: a.radius, cost });
    }

    for (const t of this.aliveProxies()) this.observe(t, t.pos, R.passiveSightRadius);

    this.lastEvents = events;
    this.lastEventsTick = tick;
    this.checkEnd(tick);
    if (this.phase === 'running') this.tick++;
    return { tick, events, reports };
  }

  private resolveMoves(alive: ProxyDrone[], actions: Map<string, Action | null>, reports: Map<string, ProxyReport>, events: GameEvent[]) {
    const R = this.rules;
    interface Mover { t: ProxyDrone; dir: Direction; left: number; path: Hex[]; requested: number; blockedBy?: BlockReason; blockedAt?: Hex }
    const movers: Mover[] = [];
    for (const t of alive) {
      const a = actions.get(t.id);
      if (a?.type === 'move') movers.push({ t, dir: a.direction, left: a.distance, path: [t.pos], requested: a.distance });
    }

    // Lock-step: every mover advances one hex per sub-step. A proxy may only enter a hex
    // that was empty at the start of the sub-step; two proxies entering the same hex both stop.
    while (movers.some((m) => m.left > 0)) {
      const occupied = new Set(this.aliveProxies().map((t) => hexKey(t.pos)));
      const intents: { m: Mover; next: Hex; key: string }[] = [];
      for (const m of movers) {
        if (m.left <= 0) continue;
        const next = neighbor(m.t.pos, m.dir);
        const key = hexKey(next);
        const stop = (why: BlockReason) => { m.left = 0; m.blockedBy = why; m.blockedAt = next; };
        if (!onGrid(next, R.gridRadius)) stop('edge');
        else if (this.forest.has(key)) stop('forest');
        else if (occupied.has(key)) stop('proxy');
        else intents.push({ m, next, key });
      }
      const counts = new Map<string, number>();
      for (const i of intents) counts.set(i.key, (counts.get(i.key) ?? 0) + 1);
      for (const { m, next, key } of intents) {
        if (counts.get(key)! > 1) {
          m.left = 0; m.blockedBy = 'collision'; m.blockedAt = next;
          continue;
        }
        m.t.pos = next;
        m.t.energy -= R.moveCostPerHex;
        m.t.stats.hexesMoved++;
        m.left--;
        m.path.push(next);
        reports.get(m.t.id)!.energySpent += R.moveCostPerHex;
        this.observe(m.t, next, R.passiveSightRadius);
        const cell = this.energyCells.get(key);
        if (cell !== undefined) {
          this.energyCells.delete(key);
          const gained = Math.min(cell, R.maxEnergy - m.t.energy);
          m.t.energy += gained;
          m.t.stats.energyCollected += gained;
          reports.get(m.t.id)!.pickups.push({ at: next, amount: gained });
          events.push({ type: 'pickup', proxyId: m.t.id, at: next, amount: gained });
        }
      }
    }

    for (const m of movers) {
      const from = m.path[0];
      const rep = reports.get(m.t.id)!;
      if (m.blockedBy === 'forest' && m.blockedAt) this.learnForest(m.t, hexKey(m.blockedAt));
      rep.moved = { from, to: m.t.pos, hexes: m.path.length - 1, requested: m.requested, blockedBy: m.blockedBy, blockedAt: m.blockedAt };
      events.push({ type: 'move', proxyId: m.t.id, path: m.path, direction: m.dir, requested: m.requested, blockedBy: m.blockedBy, blockedAt: m.blockedAt });
    }
  }

  private resolveLasers(alive: ProxyDrone[], actions: Map<string, Action | null>, reports: Map<string, ProxyReport>, events: GameEvent[], tick: number) {
    const R = this.rules;
    const damage = new Map<string, { by: string; amount: number; dir: Direction }[]>();

    for (const t of alive) {
      const a = actions.get(t.id);
      if (a?.type !== 'fire') continue;
      t.energy -= a.power;
      t.canFireAtTick = tick + 1 + R.laserCooldownTicks;
      t.stats.shotsFired++;
      const rep = reports.get(t.id)!;
      rep.energySpent += a.power;

      const path: Hex[] = [];
      let cur = t.pos;
      let hit: ProxyDrone | undefined;
      let stoppedBy: 'forest' | 'edge' | 'proxy' | 'range' = 'range';
      for (let i = 0; i < a.power; i++) {
        cur = neighbor(cur, a.direction);
        if (!onGrid(cur, R.gridRadius)) { stoppedBy = 'edge'; break; }
        path.push(cur);
        if (this.forest.has(hexKey(cur))) { stoppedBy = 'forest'; this.learnForest(t, hexKey(cur)); break; }
        hit = alive.find((o) => o !== t && o.pos.q === cur.q && o.pos.r === cur.r);
        if (hit) { stoppedBy = 'proxy'; break; }
      }
      if (hit) {
        const list = damage.get(hit.id) ?? [];
        list.push({ by: t.id, amount: R.laserDamage, dir: opposite(a.direction) });
        damage.set(hit.id, list);
        t.stats.shotsHit++;
      }
      rep.fired = {
        direction: a.direction, power: a.power, hitProxyId: hit?.id, hitProxyName: hit?.name, stoppedBy,
        endAt: path[path.length - 1] ?? t.pos,
      };
      events.push({ type: 'fire', proxyId: t.id, from: t.pos, direction: a.direction, power: a.power, path, hit: hit?.id, stoppedBy });
    }

    // Damage lands simultaneously, so two proxies can destroy each other.
    const destroyedNow: ProxyDrone[] = [];
    for (const [id, hits] of damage) {
      const victim = this.proxies.get(id)!;
      for (const h of hits) {
        victim.hp -= h.amount;
        victim.stats.damageTaken += h.amount;
        this.proxies.get(h.by)!.stats.damageDealt += h.amount;
        reports.get(id)!.hitsTaken.push({ fromDirection: h.dir, amount: h.amount });
        events.push({ type: 'damage', proxyId: id, by: h.by, amount: h.amount, hp: Math.max(0, victim.hp), fromDirection: h.dir });
      }
      if (victim.hp <= 0) {
        victim.hp = 0;
        // Credit the kill to the attacker who joined first, so ties are deterministic.
        const killer = hits.map((h) => this.proxies.get(h.by)!).sort((a, b) => a.joinOrder - b.joinOrder)[0];
        killer.stats.kills++;
        destroyedNow.push(victim);
        events.push({ type: 'destroyed', proxyId: id, by: killer.id, at: victim.pos, dropped: victim.energy });
      }
    }
    for (const v of destroyedNow) {
      v.alive = false;
      v.deathTick = tick;
      reports.get(v.id)!.destroyed = true;
      // The wreck leaks its remaining energy onto the battlefield.
      if (v.energy > 0) {
        const k = hexKey(v.pos);
        this.energyCells.set(k, (this.energyCells.get(k) ?? 0) + v.energy);
      }
      v.energy = 0;
    }
    const aliveAfter = this.aliveProxies().length;
    for (const v of destroyedNow) v.placement = aliveAfter + 1;
  }

  private checkEnd(tick: number) {
    const alive = this.aliveProxies();
    const lastStanding = this.startedWith >= 2 && alive.length <= 1;
    const allDead = alive.length === 0;
    if (!lastStanding && !allDead && tick < this.rules.maxTicks) return;

    // Survivors ranked by hp, then energy, then damage dealt. Exact ties share a placement,
    // and a tie at the top is a draw (winnerId stays null) rather than going to join order.
    const cmp = (a: ProxyDrone, b: ProxyDrone) => b.hp - a.hp || b.energy - a.energy || b.stats.damageDealt - a.stats.damageDealt;
    alive.sort(cmp);
    alive.forEach((t, i) => (t.placement = i > 0 && cmp(alive[i - 1], t) === 0 ? alive[i - 1].placement : i + 1));
    this.winnerId = alive.length && (alive.length === 1 || cmp(alive[0], alive[1]) !== 0) ? alive[0].id : null;
    this.phase = 'finished';
  }

  pause(): void {
    if (this.phase === 'running') this.phase = 'paused';
  }

  resume(): void {
    if (this.phase === 'paused') this.phase = 'running';
  }

  // ---------------------------------------------------------------- knowledge

  private learnForest(t: ProxyDrone, key: string) {
    if (!t.knownForest.has(key)) {
      t.knownForest.add(key);
      t.knownForestLog.push(key);
    }
  }

  /** Records everything within `radius` of `center` into the proxy's memory. */
  observe(t: ProxyDrone, center: Hex, radius: number): ScanResult {
    const result: ScanResult = { center, radius, forest: [], energy: [], proxies: [] };
    for (const h of hexesInRange(center, radius)) {
      if (!onGrid(h, this.rules.gridRadius)) continue;
      const k = hexKey(h);
      if (!t.explored.has(k)) {
        t.explored.add(k);
        t.exploredLog.push(k);
      }
      if (this.forest.has(k)) {
        this.learnForest(t, k);
        result.forest.push(h);
      }
      const e = this.energyCells.get(k);
      if (e !== undefined) {
        t.seenEnergy.set(k, { value: e, tick: this.tick });
        result.energy.push({ at: h, value: e });
      } else {
        t.seenEnergy.delete(k);
      }
    }
    for (const o of this.aliveProxies()) {
      if (o === t) continue;
      if (hexDistance(o.pos, center) <= radius) {
        t.seenProxies.set(o.id, { pos: o.pos, hp: o.hp, tick: this.tick });
        result.proxies.push({ id: o.id, name: o.name, at: o.pos, hp: o.hp });
      }
    }
    // Forget sightings that this observation proves stale.
    for (const [id, seen] of t.seenProxies) {
      const o = this.proxies.get(id)!;
      const stillThere = o.alive && o.pos.q === seen.pos.q && o.pos.r === seen.pos.r;
      if (!stillThere && hexDistance(seen.pos, center) <= radius) t.seenProxies.delete(id);
    }
    return result;
  }

  // ---------------------------------------------------------------- energy

  /** Spawns one symmetric orbit of energy cells (up to 12), so no corner is favoured. */
  private spawnEnergyWave(): GameEvent | null {
    const R = this.rules;
    const occupied = new Set(this.aliveProxies().map((t) => hexKey(t.pos)));
    for (let attempt = 0; attempt < 60; attempt++) {
      const q = randInt(this.rng, -R.gridRadius, R.gridRadius);
      const r = randInt(this.rng, Math.max(-R.gridRadius, -q - R.gridRadius), Math.min(R.gridRadius, -q + R.gridRadius));
      const orbit = symmetricImages({ q, r });
      if (orbit.length < 6) continue; // skip the centre and axis-degenerate spots
      if (this.energyCells.size + orbit.length > R.maxEnergyCells) return null;
      const keys = orbit.map(hexKey);
      if (keys.some((k) => this.forest.has(k) || this.energyCells.has(k) || occupied.has(k))) continue;
      for (const k of keys) this.energyCells.set(k, R.energyCellValue);
      return { type: 'spawn', cells: orbit, value: R.energyCellValue };
    }
    return null;
  }

  // ---------------------------------------------------------------- helpers for views

  describeRelative(from: Hex, to: Hex) {
    return { distance: hexDistance(from, to), in_line: alignedDirection(from, to) };
  }

  energyList(): { at: Hex; value: number }[] {
    return [...this.energyCells].map(([k, value]) => ({ at: parseKey(k), value }));
  }
}
