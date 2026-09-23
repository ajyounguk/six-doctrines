import type { Game, Tank } from '../engine/game.js';
import { parseKey } from '../shared/hex.js';
import type { BotInput } from './brain.js';

/** Builds a house bot's view from its own tank's memory (never from global state). */
export function botInputFromTank(game: Game, t: Tank): BotInput {
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
    boardRadius: R.boardRadius,
    knownTrees: t.knownTrees,
    energyCells: [...t.seenEnergy].map(([k, v]) => ({ at: parseKey(k), value: v.value })),
    enemies: [...t.seenTanks.values()].map((s) => ({ at: s.pos, seenTick: s.tick })),
    lastScanTick: lastScan?.tick ?? -99,
    seed: t.joinOrder * 7919,
  };
}
