// The Six Doctrines engine. Pure game logic: no timers, no I/O. The server decides *when*
// a tick resolves; the engine decides *what* happens. Given the same seed, rules and
// action log, a match always plays out identically.

import {
  DIRECTIONS, type Direction, type Hex,
  alignedDirection, hexDistance, hexKey, hexesInRange, neighbor, parseKey, symmetricImages,
} from '../shared/hex.js';
import type { Action, BlockReason, GameEvent, Phase, TankStats } from '../shared/protocol.js';
import { type Rules, SPAWN_SLOTS, TANK_COLORS, scanCost } from '../shared/rules.js';
import { onBoard, spawnCorner, generateTrees } from './map.js';
import { type Rng, createRng, randInt, shuffle } from './rng.js';

export class GameError extends Error {}

export interface SeenEnergy { value: number; tick: number }
export interface SeenTank { pos: Hex; hp: number; tick: number }

export interface Tank {
  id: string;
  name: string;
  color: string;
  /** Secret handed to the tank's owner: rejoins the tank and opens its player view. */
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
  stats: TankStats;
  // What this tank knows. Append-only logs let viewers stream deltas.
  explored: Set<string>;
  exploredLog: string[];
  knownTrees: Set<string>;
  knownTreesLog: string[];
  seenEnergy: Map<string, SeenEnergy>;
  seenTanks: Map<string, SeenTank>;
}

export interface ScanResult {
  center: Hex;
  radius: number;
  trees: Hex[];
  energy: { at: Hex; value: number }[];
  tanks: { id: string; name: string; at: Hex; hp: number }[];
}

/** Everything that happened to one tank in one tick, for the agent that drives it. */
export interface TankReport {
  tick: number;
  action: Action | null; // null = timed out
  moved?: { from: Hex; to: Hex; hexes: number; requested: number; blockedBy?: BlockReason; blockedAt?: Hex };
  fired?: { direction: Direction; power: number; hitTankId?: string; hitTankName?: string; stoppedBy: string; endAt: Hex };
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
  reports: Map<string, TankReport>;
}

const emptyStats = (): TankStats => ({
  kills: 0, damageDealt: 0, damageTaken: 0, shotsFired: 0, shotsHit: 0,
  hexesMoved: 0, energyCollected: 0, scans: 0, timeouts: 0,
});

const opposite = (d: Direction): Direction => DIRECTIONS[(DIRECTIONS.indexOf(d) + 3) % 6];

export class Game {
  readonly rules: Rules;
  readonly seed: number;
  readonly trees: Set<string>;
  readonly energyCells = new Map<string, number>();
  readonly tanks = new Map<string, Tank>();

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
    this.trees = generateTrees(rules, seed);
  }

  // ---------------------------------------------------------------- lobby

  join(name: string, opts: { isBot?: boolean; token?: string; id?: string } = {}): Tank {
    if (this.phase !== 'lobby') throw new GameError('The match has already started; wait for the next one.');
    if (this.tanks.size >= this.rules.maxPlayers) throw new GameError(`The battlefield is full (${this.rules.maxPlayers} tanks).`);

    const clean = name.trim().slice(0, 24) || 'Tank';
    let unique = clean;
    for (let n = 2; [...this.tanks.values()].some((t) => t.name === unique); n++) unique = `${clean} ${n}`;

    const used = new Set([...this.tanks.values()].map((t) => t.color));
    let id = opts.id;
    if (!id || this.tanks.has(id)) {
      while (this.tanks.has(`t${this.nextId}`)) this.nextId++;
      id = `t${this.nextId++}`;
    }
    const tank: Tank = {
      id,
      name: unique,
      color: TANK_COLORS.find((c) => !used.has(c)) ?? TANK_COLORS[0],
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
      knownTrees: new Set(), knownTreesLog: [],
      seenEnergy: new Map(),
      seenTanks: new Map(),
    };
    this.tanks.set(tank.id, tank);
    return tank;
  }

  leave(tankId: string): void {
    if (this.phase !== 'lobby') throw new GameError('Tanks can only be removed in the lobby.');
    this.tanks.delete(tankId);
  }

  start(): void {
    if (this.phase !== 'lobby') throw new GameError('Match already started.');
    const tanks = [...this.tanks.values()];
    if (tanks.length === 0) throw new GameError('Need at least one tank to start.');

    const slots = shuffle(this.rng, [...SPAWN_SLOTS[tanks.length]]);
    tanks.forEach((t, i) => (t.pos = spawnCorner(slots[i], this.rules)));
    for (let i = 0; i < this.rules.initialEnergyWaves; i++) this.spawnEnergyWave();

    this.startedWith = tanks.length;
    this.phase = 'running';
    this.tick = 1;
    for (const t of tanks) this.observe(t, t.pos, this.rules.passiveSightRadius);
  }

  // ---------------------------------------------------------------- queries

  aliveTanks(): Tank[] {
    return [...this.tanks.values()].filter((t) => t.alive);
  }

  hasSubmitted(tankId: string): boolean {
    return this.pending.has(tankId);
  }

  allSubmitted(): boolean {
    return this.aliveTanks().every((t) => this.pending.has(t.id));
  }

  tankAt(h: Hex): Tank | undefined {
    return this.aliveTanks().find((t) => t.pos.q === h.q && t.pos.r === h.r);
  }

  // ---------------------------------------------------------------- actions

  /** Validates and queues an action for the current tick. Throws GameError with an agent-readable reason. */
  submit(tankId: string, action: Action): void {
    const t = this.tanks.get(tankId);
    if (!t) throw new GameError('Unknown tank.');
    if (this.phase === 'lobby') throw new GameError('The match has not started yet. Call wait_for_start.');
    if (this.phase === 'finished') throw new GameError('The match is over.');
    if (!t.alive) throw new GameError('Your tank has been destroyed.');
    if (this.pending.has(tankId)) throw new GameError(`You already submitted an action for tick ${this.tick}.`);

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
    this.pending.set(tankId, action);
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
    const reports = new Map<string, TankReport>();
    const alive = this.aliveTanks();

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
        events.push({ type: 'timeout', tankId: t.id });
      } else if (a?.type === 'wait') {
        const gained = Math.min(R.waitRecharge, R.maxEnergy - t.energy);
        t.energy += gained;
        reports.get(t.id)!.recharged = gained;
        events.push({ type: 'wait', tankId: t.id, recharged: gained });
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
      events.push({ type: 'scan', tankId: t.id, center: t.pos, radius: a.radius, cost });
    }

    for (const t of this.aliveTanks()) this.observe(t, t.pos, R.passiveSightRadius);

    this.lastEvents = events;
    this.lastEventsTick = tick;
    this.checkEnd(tick);
    if (this.phase === 'running') this.tick++;
    return { tick, events, reports };
  }

  private resolveMoves(alive: Tank[], actions: Map<string, Action | null>, reports: Map<string, TankReport>, events: GameEvent[]) {
    const R = this.rules;
    interface Mover { t: Tank; dir: Direction; left: number; path: Hex[]; requested: number; blockedBy?: BlockReason; blockedAt?: Hex }
    const movers: Mover[] = [];
    for (const t of alive) {
      const a = actions.get(t.id);
      if (a?.type === 'move') movers.push({ t, dir: a.direction, left: a.distance, path: [t.pos], requested: a.distance });
    }

    // Lock-step: every mover advances one hex per sub-step. A tank may only enter a hex
    // that was empty at the start of the sub-step; two tanks entering the same hex both stop.
    while (movers.some((m) => m.left > 0)) {
      const occupied = new Set(this.aliveTanks().map((t) => hexKey(t.pos)));
      const intents: { m: Mover; next: Hex; key: string }[] = [];
      for (const m of movers) {
        if (m.left <= 0) continue;
        const next = neighbor(m.t.pos, m.dir);
        const key = hexKey(next);
        const stop = (why: BlockReason) => { m.left = 0; m.blockedBy = why; m.blockedAt = next; };
        if (!onBoard(next, R.boardRadius)) stop('edge');
        else if (this.trees.has(key)) stop('tree');
        else if (occupied.has(key)) stop('tank');
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
          events.push({ type: 'pickup', tankId: m.t.id, at: next, amount: gained });
        }
      }
    }

    for (const m of movers) {
      const from = m.path[0];
      const rep = reports.get(m.t.id)!;
      if (m.blockedBy === 'tree' && m.blockedAt) this.learnTree(m.t, hexKey(m.blockedAt));
      rep.moved = { from, to: m.t.pos, hexes: m.path.length - 1, requested: m.requested, blockedBy: m.blockedBy, blockedAt: m.blockedAt };
      events.push({ type: 'move', tankId: m.t.id, path: m.path, direction: m.dir, requested: m.requested, blockedBy: m.blockedBy, blockedAt: m.blockedAt });
    }
  }

  private resolveLasers(alive: Tank[], actions: Map<string, Action | null>, reports: Map<string, TankReport>, events: GameEvent[], tick: number) {
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
      let hit: Tank | undefined;
      let stoppedBy: 'tree' | 'edge' | 'tank' | 'range' = 'range';
      for (let i = 0; i < a.power; i++) {
        cur = neighbor(cur, a.direction);
        if (!onBoard(cur, R.boardRadius)) { stoppedBy = 'edge'; break; }
        path.push(cur);
        if (this.trees.has(hexKey(cur))) { stoppedBy = 'tree'; this.learnTree(t, hexKey(cur)); break; }
        hit = alive.find((o) => o !== t && o.pos.q === cur.q && o.pos.r === cur.r);
        if (hit) { stoppedBy = 'tank'; break; }
      }
      if (hit) {
        const list = damage.get(hit.id) ?? [];
        list.push({ by: t.id, amount: R.laserDamage, dir: opposite(a.direction) });
        damage.set(hit.id, list);
        t.stats.shotsHit++;
      }
      rep.fired = {
        direction: a.direction, power: a.power, hitTankId: hit?.id, hitTankName: hit?.name, stoppedBy,
        endAt: path[path.length - 1] ?? t.pos,
      };
      events.push({ type: 'fire', tankId: t.id, from: t.pos, direction: a.direction, power: a.power, path, hit: hit?.id, stoppedBy });
    }

    // Damage lands simultaneously, so two tanks can destroy each other.
    const destroyedNow: Tank[] = [];
    for (const [id, hits] of damage) {
      const victim = this.tanks.get(id)!;
      for (const h of hits) {
        victim.hp -= h.amount;
        victim.stats.damageTaken += h.amount;
        this.tanks.get(h.by)!.stats.damageDealt += h.amount;
        reports.get(id)!.hitsTaken.push({ fromDirection: h.dir, amount: h.amount });
        events.push({ type: 'damage', tankId: id, by: h.by, amount: h.amount, hp: Math.max(0, victim.hp), fromDirection: h.dir });
      }
      if (victim.hp <= 0) {
        victim.hp = 0;
        // Credit the kill to the attacker who joined first, so ties are deterministic.
        const killer = hits.map((h) => this.tanks.get(h.by)!).sort((a, b) => a.joinOrder - b.joinOrder)[0];
        killer.stats.kills++;
        destroyedNow.push(victim);
        events.push({ type: 'destroyed', tankId: id, by: killer.id, at: victim.pos, dropped: victim.energy });
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
    const aliveAfter = this.aliveTanks().length;
    for (const v of destroyedNow) v.placement = aliveAfter + 1;
  }

  private checkEnd(tick: number) {
    const alive = this.aliveTanks();
    const lastStanding = this.startedWith >= 2 && alive.length <= 1;
    const allDead = alive.length === 0;
    if (!lastStanding && !allDead && tick < this.rules.maxTicks) return;

    // Survivors ranked by hp, then energy, then damage dealt. Exact ties share a placement,
    // and a tie at the top is a draw (winnerId stays null) rather than going to join order.
    const cmp = (a: Tank, b: Tank) => b.hp - a.hp || b.energy - a.energy || b.stats.damageDealt - a.stats.damageDealt;
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

  private learnTree(t: Tank, key: string) {
    if (!t.knownTrees.has(key)) {
      t.knownTrees.add(key);
      t.knownTreesLog.push(key);
    }
  }

  /** Records everything within `radius` of `center` into the tank's memory. */
  observe(t: Tank, center: Hex, radius: number): ScanResult {
    const result: ScanResult = { center, radius, trees: [], energy: [], tanks: [] };
    for (const h of hexesInRange(center, radius)) {
      if (!onBoard(h, this.rules.boardRadius)) continue;
      const k = hexKey(h);
      if (!t.explored.has(k)) {
        t.explored.add(k);
        t.exploredLog.push(k);
      }
      if (this.trees.has(k)) {
        this.learnTree(t, k);
        result.trees.push(h);
      }
      const e = this.energyCells.get(k);
      if (e !== undefined) {
        t.seenEnergy.set(k, { value: e, tick: this.tick });
        result.energy.push({ at: h, value: e });
      } else {
        t.seenEnergy.delete(k);
      }
    }
    for (const o of this.aliveTanks()) {
      if (o === t) continue;
      if (hexDistance(o.pos, center) <= radius) {
        t.seenTanks.set(o.id, { pos: o.pos, hp: o.hp, tick: this.tick });
        result.tanks.push({ id: o.id, name: o.name, at: o.pos, hp: o.hp });
      }
    }
    // Forget sightings that this observation proves stale.
    for (const [id, seen] of t.seenTanks) {
      const o = this.tanks.get(id)!;
      const stillThere = o.alive && o.pos.q === seen.pos.q && o.pos.r === seen.pos.r;
      if (!stillThere && hexDistance(seen.pos, center) <= radius) t.seenTanks.delete(id);
    }
    return result;
  }

  // ---------------------------------------------------------------- energy

  /** Spawns one symmetric orbit of energy cells (up to 12), so no corner is favoured. */
  private spawnEnergyWave(): GameEvent | null {
    const R = this.rules;
    const occupied = new Set(this.aliveTanks().map((t) => hexKey(t.pos)));
    for (let attempt = 0; attempt < 60; attempt++) {
      const q = randInt(this.rng, -R.boardRadius, R.boardRadius);
      const r = randInt(this.rng, Math.max(-R.boardRadius, -q - R.boardRadius), Math.min(R.boardRadius, -q + R.boardRadius));
      const orbit = symmetricImages({ q, r });
      if (orbit.length < 6) continue; // skip the centre and axis-degenerate spots
      if (this.energyCells.size + orbit.length > R.maxEnergyCells) return null;
      const keys = orbit.map(hexKey);
      if (keys.some((k) => this.trees.has(k) || this.energyCells.has(k) || occupied.has(k))) continue;
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
