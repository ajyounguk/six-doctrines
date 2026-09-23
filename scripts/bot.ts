// Example MCP agent: connects to The Six Doctrines over MCP and plays with the sparring-bot brain.
// Handy for testing, and a template for wiring up your own agent.
//
//   npm run bot -- --name Rover --url http://localhost:8080/mcp

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { decideBotAction, type BotInput } from '../src/bot/brain.js';
import type { Action } from '../src/shared/protocol.js';

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const url = arg('url', 'http://localhost:8080/mcp');
const name = arg('name', `Rover-${Math.floor(Math.random() * 1000)}`);

const client = new Client({ name: 'six-doctrines-example-bot', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

async function call(tool: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 10 * 60_000 });
  const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

const joined = await call('join', { name });
console.log(`joined as ${joined.joined_as}\nplayer view: ${joined.viewer_url}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for the next match to start: first for a return to the lobby, then for the start. */
async function nextMatch() {
  while ((await call('status')).match.phase !== 'lobby') await sleep(2000);
  while (!(await call('wait_for_start')).started) console.log('waiting for the host to start…');
}

while (!(await call('wait_for_start')).started) console.log('waiting for the host to start…');
const rules = await call('rules');
const num = (s: string, re: RegExp) => Number(s.match(re)?.[1]);
const maxMove = num(rules.actions.move, /Up to (\d+)/);
const maxPower = num(rules.actions.fire, /Power 1-(\d+)/);
const maxScan = num(rules.actions.scan, /radius \(1-(\d+)\)/);

// The brain wants remembered forest as a Set; keep our own copy from known_map.
let forest = new Set<string>();
let lastScanTick = -99;
let playedTick = 0;
let blockedByProxy = false;

// Plays forever, match after match, until you stop it (Ctrl+C).
for (;;) {
  const status = await call('status');
  const { match, you } = status;
  // A reset puts the tick back to 0 (lobby) or 1: that's a new match, so forget the old map.
  if (match.tick < playedTick) { forest = new Set(); lastScanTick = -99; }
  playedTick = match.tick;
  if (match.phase === 'paused') { await sleep(1000); continue; }
  if (match.phase !== 'running' || !you.alive) {
    if (match.phase === 'finished') console.log(`match over, placement ${you.placement}`);
    else if (!you.alive) console.log('destroyed; waiting for the next match');
    await nextMatch();
    continue;
  }
  const known = await call('known_map', { radius: 40 });
  for (const [q, r] of known.forest) forest.add(`${q},${r}`);

  const input: BotInput = {
    tick: match.tick,
    pos: you.position,
    hp: you.hp,
    energy: you.energy,
    laserReady: you.laser_ready,
    maxMove, maxPower, maxScanRadius: maxScan,
    gridRadius: match.grid_radius,
    knownForest: forest,
    energyCells: known.energy.map((e: any) => ({ at: { q: e.q, r: e.r }, value: e.value })),
    enemies: known.proxies.map((t: any) => ({ at: { q: t.q, r: t.r }, seenTick: match.tick - t.seen_ticks_ago })),
    lastScanTick,
    seed: [...name].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) | 0,
    blockedByProxy,
  };
  const action: Action = decideBotAction(input);
  if (action.type === 'scan') lastScanTick = match.tick;

  try {
    const { type, ...args } = action;
    const report = await call(type, args);
    blockedByProxy = report.moved?.blocked_by === 'proxy' || report.moved?.blocked_by === 'collision';
    console.log(`t${report.resolved_tick}: ${report.summary}`);
  } catch (e) {
    console.log(`t${match.tick}: ${(e as Error).message}`);
    if (/reset|not started/.test((e as Error).message)) await nextMatch();
    else await sleep(250);
  }
}
