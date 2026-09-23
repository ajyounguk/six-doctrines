// Game rules. Every number that affects balance lives here so matches are reproducible
// from (rules, seed) alone.

export interface Rules {
  boardRadius: number; // hexagon-shaped board, hexes from centre to edge
  maxPlayers: number;
  maxTicks: number; // match ends here if more than one tank is still alive

  startHp: number;
  startEnergy: number;
  maxEnergy: number;

  maxMoveDistance: number; // hexes per move action
  moveCostPerHex: number;

  scanBaseCost: number; // scan cost = base + perRadius * radius
  scanCostPerRadius: number;
  maxScanRadius: number;
  passiveSightRadius: number; // what a tank sees around itself for free every tick

  laserDamage: number;
  maxLaserPower: number; // energy spent = range in hexes
  laserCooldownTicks: number; // ticks that must pass between shots

  waitRecharge: number; // energy gained by an explicit wait action (not by timing out)

  energyCellValue: number;
  energySpawnInterval: number; // ticks between spawn waves
  initialEnergyWaves: number;
  maxEnergyCells: number;

  treeDensity: number; // 0..1 target share of forest cover
  spawnInset: number; // how far in from the board corners tanks start
  spawnClearRadius: number; // trees cleared around every spawn corner

  turnTimeoutMs: number; // no action by then = timeout (acts as a wait with no recharge)
  minTickMs: number; // lower bound on tick length so humans can follow the action
}

export const DEFAULT_RULES: Rules = {
  boardRadius: 128,
  maxPlayers: 4,
  maxTicks: 1000,

  startHp: 100,
  startEnergy: 100,
  maxEnergy: 200,

  maxMoveDistance: 10,
  moveCostPerHex: 1,

  scanBaseCost: 1,
  scanCostPerRadius: 1,
  maxScanRadius: 20,
  passiveSightRadius: 1,

  laserDamage: 25,
  maxLaserPower: 20,
  laserCooldownTicks: 1,

  waitRecharge: 2,

  energyCellValue: 15,
  energySpawnInterval: 5,
  initialEnergyWaves: 30,
  maxEnergyCells: 400,

  treeDensity: 0.14,
  spawnInset: 12,
  spawnClearRadius: 4,

  turnTimeoutMs: 30_000,
  minTickMs: 600,
};

export const scanCost = (rules: Rules, radius: number): number =>
  rules.scanBaseCost + rules.scanCostPerRadius * radius;

/** Spawn slots (indices into the 6 board corners) per player count, chosen so every
 *  tank's position is equivalent under the map's symmetry. */
export const SPAWN_SLOTS: Record<number, number[]> = {
  1: [0],
  2: [0, 3],
  3: [0, 2, 4],
  4: [0, 1, 3, 4],
};

export const TANK_COLORS = ['#ff5d5d', '#4da3ff', '#ffc233', '#b77dff'];
