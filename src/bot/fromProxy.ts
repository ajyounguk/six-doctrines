import type { Game, ProxyDrone } from '../engine/game.js';
import { parseKey } from '../shared/hex.js';
import type { BotInput } from './brain.js';

/** Builds a sparring bot's view from its own proxy's memory (never from global state). */
export function botInputFromProxy(game: Game, t: ProxyDrone): BotInput {
  const R = game.rules;
  const lastScan = game.actionLog.findLast((l) => l.actions[t.id]?.type === 'scan');
  return {
    tick: game.tick,
    pos: t.pos,
    hp: t.hp,
    energy: t.energy,
    laserReady: game.tick >= t.canFireAtTick,
    maxMove: R.maxMoveDistance,
    maxPower: R.maxLaserPower,
    maxScanRadius: R.maxScanRadius,
    gridRadius: R.gridRadius,
    knownForest: t.knownForest,
    energyCells: [...t.seenEnergy].map(([k, v]) => ({ at: parseKey(k), value: v.value })),
    enemies: [...t.seenProxies.values()].map((s) => ({ at: s.pos, seenTick: s.tick })),
    lastScanTick: lastScan?.tick ?? -99,
    seed: t.joinOrder * 7919,
  };
}
