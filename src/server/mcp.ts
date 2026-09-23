// MCP tool layer. One McpServer per session; each session drives at most one tank.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GameError } from '../engine/game.js';
import { DIRECTIONS, alignedDirection, hexDistance, hexKey, hexLength } from '../shared/hex.js';
import type { Action } from '../shared/protocol.js';
import { knownMapFor, reportFor, rulesFor, statusFor } from './agentViews.js';
import type { Match } from './match.js';

export interface SessionState {
  tankId: string | null;
}

const INSTRUCTIONS = `The Six Doctrines: a turn-based laser-tank battle on a hex grid, up to 4 tanks.
1. Call join with your tank name. Keep the rejoin_token it returns.
2. Call wait_for_start until the match is running.
3. Each tick, call exactly one action: move, scan, fire or wait. The call returns once the tick resolves (every tank acted, or the turn timer ran out) and tells you what happened.
status, known_map, locate and rules are free and don't use your turn.
You can't see the whole battlefield. Scan to find energy, trees and enemies. Energy pays for everything, so spend it well.`;

const json = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 1) }],
});
const fail = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true,
});

export function createMcpServer(match: Match, session: SessionState, links: { playerUrl: (token: string) => string }) {
  const server = new McpServer({ name: 'six-doctrines', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const dir = z.enum(DIRECTIONS).describe('One of N, NE, SE, S, SW, NW');

  const tank = () => {
    const t = session.tankId ? match.game.tanks.get(session.tankId) : undefined;
    if (!t) throw new GameError('You have not joined. Call join first.');
    return t;
  };

  const guard = (fn: () => CallToolResult | Promise<CallToolResult>) => async () => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof GameError) return fail(e.message);
      console.error(e);
      return fail('Internal error.');
    }
  };

  const act = async (action: Action) => {
    const t = tank();
    const report = await match.submit(t.id, action);
    return json(reportFor(match, t, report));
  };

  server.registerTool('join', {
    description: 'Join the battlefield with a tank. Only possible in the lobby, or with rejoin_token to reclaim your tank after a reconnect.',
    inputSchema: {
      name: z.string().min(1).max(24).describe('Your tank name'),
      rejoin_token: z.string().optional().describe('Token from an earlier join, to take back control of the same tank'),
    },
  }, ({ name, rejoin_token }) => guard(() => {
    let t = rejoin_token ? match.findByToken(rejoin_token) : undefined;
    if (rejoin_token && !t) throw new GameError('Unknown rejoin_token.');
    if (!t && session.tankId) t = match.game.tanks.get(session.tankId);
    if (!t) t = match.join(name);
    session.tankId = t.id;
    return json({
      joined_as: t.name,
      rejoin_token: t.token,
      viewer_url: links.playerUrl(t.token),
      note: 'Share viewer_url with your human to let them watch what your tank knows. Next: call wait_for_start.',
      status: statusFor(match, t),
    });
  })());

  server.registerTool('wait_for_start', {
    description: 'Blocks until the match starts (up to ~50s). Call again if it returns still_waiting.',
    inputSchema: {},
  }, () => guard(async () => {
    const t = tank();
    const started = await match.waitForStart(50_000);
    return json({ started, still_waiting: !started, status: statusFor(match, t) });
  })());

  server.registerTool('status', {
    description: 'Free. Your position, HP, energy, laser readiness, the tick clock and which opponents are still alive.',
    inputSchema: {},
  }, () => guard(() => json(statusFor(match, tank())))());

  server.registerTool('rules', {
    description: 'Free. Full rules, costs and the coordinate system.',
    inputSchema: {},
  }, () => guard(() => json(rulesFor(match)))());

  server.registerTool('known_map', {
    description: "Free. Your tank's memory within a radius: trees you've seen, and your last sightings of energy cells and tanks (with how many ticks ago).",
    inputSchema: { radius: z.number().int().min(1).max(64).default(20).describe('How far around you to list') },
  }, ({ radius }) => guard(() => json(knownMapFor(match, tank(), radius)))());

  server.registerTool('locate', {
    description: 'Free. Distance from you to a hex, whether it is in line (and which direction to fire/move), and what you remember there.',
    inputSchema: { q: z.number().int(), r: z.number().int() },
  }, ({ q, r }) => guard(() => {
    const t = tank();
    const target = { q, r };
    const k = hexKey(target);
    const seenTank = [...t.seenTanks].find(([, s]) => s.pos.q === q && s.pos.r === r);
    return json({
      target,
      on_board: hexLength(target) <= match.rules.boardRadius,
      distance: hexDistance(t.pos, target),
      in_line: alignedDirection(t.pos, target),
      known: {
        tree: t.knownTrees.has(k),
        energy: t.seenEnergy.get(k) ?? null,
        tank: seenTank ? { name: match.game.tanks.get(seenTank[0])?.name, seen_ticks_ago: match.game.tick - seenTank[1].tick } : null,
        explored: t.explored.has(k),
      },
    });
  })());

  server.registerTool('move', {
    description: 'ACTION (uses your turn). Drive up to max distance in one direction; costs energy per hex actually moved. Returns after the tick resolves.',
    inputSchema: { direction: dir, distance: z.number().int().min(1).describe('Hexes to move') },
  }, ({ direction, distance }) => guard(() => act({ type: 'move', direction, distance }))());

  server.registerTool('scan', {
    description: 'ACTION (uses your turn). Reveal trees, energy and tanks within a radius. Cost grows with radius. Returns the findings after the tick resolves.',
    inputSchema: { radius: z.number().int().min(1).describe('Scan radius in hexes') },
  }, ({ radius }) => guard(() => act({ type: 'scan', radius }))());

  server.registerTool('fire', {
    description: 'ACTION (uses your turn). Fire the laser in a straight line. Power = range in hexes = energy spent. Hits the first tank in the path; trees block it.',
    inputSchema: { direction: dir, power: z.number().int().min(1).describe('Range in hexes (and energy cost)') },
  }, ({ direction, power }) => guard(() => act({ type: 'fire', direction, power }))());

  server.registerTool('wait', {
    description: 'ACTION (uses your turn). Hold position and recharge a little energy.',
    inputSchema: {},
  }, () => guard(() => act({ type: 'wait' }))());

  return server;
}
