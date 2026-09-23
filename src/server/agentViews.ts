// What an agent sees. Everything here is built from the agent's own tank and its memory,
// never from global state, so every agent plays with the same information budget.

import type { Tank, TankReport, ScanResult } from '../engine/game.js';
import { type Hex, alignedDirection, hexDistance, hexLength, parseKey } from '../shared/hex.js';
import { scanCost } from '../shared/rules.js';
import type { Match } from './match.js';

const xy = (h: Hex) => ({ q: h.q, r: h.r });

function rel(from: Hex, to: Hex) {
  return { distance: hexDistance(from, to), in_line: alignedDirection(from, to) };
}

export function statusFor(match: Match, t: Tank) {
  const g = match.game;
  const R = g.rules;
  const opponents = [...g.tanks.values()].filter((o) => o.id !== t.id);
  return {
    match: {
      phase: g.phase,
      tick: g.tick,
      max_ticks: R.maxTicks,
      seconds_left_this_tick: match.deadline ? Math.max(0, Math.round((match.deadline - Date.now()) / 1000)) : null,
      board_radius: R.boardRadius,
      winner: g.winnerId ? g.tanks.get(g.winnerId)?.name ?? null : null,
    },
    you: {
      name: t.name,
      alive: t.alive,
      position: g.phase === 'lobby' ? null : xy(t.pos),
      distance_from_centre: g.phase === 'lobby' ? null : hexLength(t.pos),
      hp: t.hp,
      energy: t.energy,
      max_energy: R.maxEnergy,
      laser_ready: g.tick >= t.canFireAtTick,
      laser_ready_on_tick: Math.max(g.tick, t.canFireAtTick),
      submitted_this_tick: g.hasSubmitted(t.id),
      placement: t.placement ?? null,
    },
    opponents: opponents.map((o) => ({ name: o.name, alive: o.alive })),
  };
}

function scanView(from: Hex, s: ScanResult) {
  return {
    center: xy(s.center),
    radius: s.radius,
    trees: s.trees.map((h) => [h.q, h.r]),
    energy: s.energy
      .map((e) => ({ ...xy(e.at), value: e.value, ...rel(from, e.at) }))
      .sort((a, b) => a.distance - b.distance),
    tanks: s.tanks.map((o) => ({ name: o.name, ...xy(o.at), hp: o.hp, ...rel(from, o.at) })),
  };
}

function summarise(r: TankReport, t: Tank): string {
  const parts: string[] = [];
  const a = r.action;
  if (!a) parts.push('You timed out; your tank did nothing this tick.');
  else if (a.type === 'wait') parts.push(`Waited and recharged ${r.recharged ?? 0} energy.`);
  if (r.moved) {
    const m = r.moved;
    let s = `Moved ${m.hexes}/${m.requested} hexes ${a?.type === 'move' ? a.direction : ''} to (${m.to.q},${m.to.r}).`;
    if (m.blockedBy && m.blockedAt) {
      const what = { tree: 'a tree', tank: 'another tank', edge: 'the edge of the battlefield', collision: 'another tank moving into the same hex' }[m.blockedBy];
      s += ` Stopped by ${what} at (${m.blockedAt.q},${m.blockedAt.r}).`;
    }
    parts.push(s);
  }
  if (r.fired) {
    const f = r.fired;
    parts.push(f.hitTankName
      ? `Laser fired ${f.direction} (power ${f.power}) and HIT ${f.hitTankName} at (${f.endAt.q},${f.endAt.r}).`
      : `Laser fired ${f.direction} (power ${f.power}) and missed; beam stopped by ${f.stoppedBy} at (${f.endAt.q},${f.endAt.r}).`);
  }
  if (r.scan) parts.push(`Scanned radius ${r.scan.radius}: ${r.scan.trees.length} trees, ${r.scan.energy.length} energy cells, ${r.scan.tanks.length} tanks.`);
  for (const p of r.pickups) parts.push(`Collected ${p.amount} energy at (${p.at.q},${p.at.r}).`);
  for (const h of r.hitsTaken) parts.push(`HIT by a laser coming from the ${h.fromDirection} for ${h.amount} damage.`);
  if (r.destroyed) parts.push('Your tank was DESTROYED.');
  parts.push(`HP ${t.hp}, energy ${t.energy}.`);
  return parts.join(' ');
}

export function reportFor(match: Match, t: Tank, r: TankReport) {
  return {
    resolved_tick: r.tick,
    summary: summarise(r, t),
    moved: r.moved ? { from: xy(r.moved.from), to: xy(r.moved.to), hexes: r.moved.hexes, blocked_by: r.moved.blockedBy ?? null } : undefined,
    fired: r.fired ? { direction: r.fired.direction, power: r.fired.power, hit: r.fired.hitTankName ?? null, stopped_by: r.fired.stoppedBy, beam_end: xy(r.fired.endAt) } : undefined,
    scan: r.scan ? scanView(t.pos, r.scan) : undefined,
    pickups: r.pickups.length ? r.pickups.map((p) => ({ ...xy(p.at), amount: p.amount })) : undefined,
    hits_taken: r.hitsTaken.length ? r.hitsTaken.map((h) => ({ from_direction: h.fromDirection, damage: h.amount })) : undefined,
    energy_spent: r.energySpent,
    status: statusFor(match, t),
  };
}

/** The tank's memory around it: trees it has seen, and its last sightings of energy and tanks. */
export function knownMapFor(match: Match, t: Tank, radius: number) {
  const g = match.game;
  const near = (h: Hex) => hexDistance(t.pos, h) <= radius;
  const trees = [...t.knownTrees].map(parseKey).filter(near).map((h) => [h.q, h.r]);
  const energy = [...t.seenEnergy]
    .map(([k, v]) => ({ at: parseKey(k), ...v }))
    .filter((e) => near(e.at))
    .map((e) => ({ ...xy(e.at), value: e.value, seen_ticks_ago: g.tick - e.tick, ...rel(t.pos, e.at) }))
    .sort((a, b) => a.distance - b.distance);
  const tanks = [...t.seenTanks]
    .map(([id, s]) => ({ name: g.tanks.get(id)?.name ?? id, ...xy(s.pos), hp: s.hp, seen_ticks_ago: g.tick - s.tick, ...rel(t.pos, s.pos) }));
  return {
    you: xy(t.pos),
    radius,
    explored_hexes_total: t.explored.size,
    trees,
    energy,
    tanks,
  };
}

export function rulesFor(match: Match) {
  const R = match.rules;
  return {
    board: {
      shape: `Hexagon of radius ${R.boardRadius} centred on (0,0). A hex (q,r) is on the board when max(|q|, |r|, |q+r|) <= ${R.boardRadius}.`,
      coordinates: 'Axial (q, r), flat-top hexes. Distance between hexes = max(|dq|, |dr|, |dq+dr|).',
      directions: {
        N: '(q, r-1)', NE: '(q+1, r-1)', SE: '(q+1, r)', S: '(q, r+1)', SW: '(q-1, r+1)', NW: '(q-1, r)',
      },
      in_line: 'Two hexes are "in line" when one is reachable from the other by repeating a single direction. Lasers only travel in line.',
    },
    turns: `Simultaneous. Every tank submits one action per tick; the tick resolves when all have acted or after ${R.turnTimeoutMs / 1000}s. A timeout counts as doing nothing.`,
    resolution_order: ['moves (all tanks step one hex at a time together)', 'lasers (fired from post-move positions)', 'damage and destruction', 'energy spawns', 'scans', 'free passive sight'],
    energy: `Start ${R.startEnergy}, max ${R.maxEnergy}. Energy cells (${R.energyCellValue} each) spawn in symmetric groups every ${R.energySpawnInterval} ticks. Drive over a cell to collect it. Destroyed tanks drop their remaining energy.`,
    actions: {
      move: `Up to ${R.maxMoveDistance} hexes in one direction, ${R.moveCostPerHex} energy per hex actually moved. You stop early at trees, the edge, or other tanks; two tanks entering the same hex both stop.`,
      scan: `Reveals trees, energy and tanks within a radius (1-${R.maxScanRadius}). Costs ${R.scanBaseCost} + ${R.scanCostPerRadius} x radius energy (e.g. radius 10 = ${scanCost(R, 10)}).`,
      fire: `Laser in one direction. Power 1-${R.maxLaserPower} = range in hexes = energy spent. Hits the first tank in its path for ${R.laserDamage} damage; trees block it. After firing you must wait ${R.laserCooldownTicks} tick(s) before firing again.`,
      wait: `Do nothing and recharge ${R.waitRecharge} energy.`,
    },
    free_tools: 'status, known_map, locate and rules cost nothing and do not use your turn.',
    vision: `No global view. You passively see ${R.passiveSightRadius} hex around you (including along your path while moving). Everything else comes from scans and is remembered in known_map.`,
    hp: `Start ${R.startHp}. At 0 the tank is destroyed.`,
    winning: `Last tank standing wins. After ${R.maxTicks} ticks, survivors are ranked by HP, then energy.`,
  };
}
