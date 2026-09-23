// Streams the battlefield to browser viewers over WebSocket.
//   host   – sees everything and controls the match (needs the host key)
//   player – sees only what their tank knows (needs the tank's token)

import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { GameError, type Tank } from '../engine/game.js';
import { parseKey } from '../shared/hex.js';
import type { ClientMessage, GameEvent, ServerMessage, Snapshot, TankView, Welcome } from '../shared/protocol.js';
import type { Match } from './match.js';

interface Conn {
  ws: WebSocket;
  role: 'host' | 'player';
  tankId: string | null;
  exploredSent: number;
  treesSent: number;
}

const flatten = (keys: Iterable<string>): number[] => {
  const out: number[] = [];
  for (const k of keys) { const h = parseKey(k); out.push(h.q, h.r); }
  return out;
};

export interface HubOptions {
  hostKey: string;
  mcpUrl: string;
  playerUrl: (token: string) => string;
}

export function attachViewerHub(httpServer: Server, match: Match, opts: HubOptions) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const conns = new Set<Conn>();

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const playerLinks = () =>
    Object.fromEntries([...match.game.tanks.values()].map((t) => [t.id, opts.playerUrl(t.token)]));

  function fullTank(t: Tank): TankView {
    const g = match.game;
    return {
      id: t.id, name: t.name, color: t.color, alive: t.alive,
      pos: g.phase === 'lobby' ? undefined : t.pos,
      hp: t.hp, energy: t.energy,
      submitted: g.hasSubmitted(t.id),
      lastAction: t.lastAction,
      canFireAtTick: t.canFireAtTick,
      stats: t.stats,
      deathTick: t.deathTick,
      placement: t.placement,
    };
  }

  function hostSnapshot(): Snapshot {
    const g = match.game;
    const energy: number[] = [];
    for (const [k, v] of g.energyCells) { const h = parseKey(k); energy.push(h.q, h.r, v); }
    return {
      tick: g.tick, phase: g.phase, deadline: match.deadline, serverNow: Date.now(),
      tanks: [...g.tanks.values()].map(fullTank),
      energy, events: g.lastEvents, eventsTick: g.lastEventsTick, winnerId: g.winnerId,
    };
  }

  function playerSnapshot(c: Conn): Snapshot {
    const g = match.game;
    const me = g.tanks.get(c.tankId!);
    const over = g.phase === 'finished';
    const tanks = [...g.tanks.values()].map((t): TankView => {
      if (t === me || over) return fullTank(t);
      const seen = me?.seenTanks.get(t.id);
      return {
        id: t.id, name: t.name, color: t.color, alive: t.alive,
        pos: seen?.pos, hp: seen?.hp, seenTick: seen?.tick,
        deathTick: t.deathTick, placement: over ? t.placement : undefined,
      };
    });
    const energy: number[] = [];
    if (me) for (const [k, v] of me.seenEnergy) { const h = parseKey(k); energy.push(h.q, h.r, v.value); }

    // Only events this tank took part in; attackers stay anonymous.
    const mine = (e: GameEvent): GameEvent | null => {
      if (!me) return null;
      if (e.type === 'damage') return e.tankId === me.id ? { ...e, by: '' } : e.by === me.id ? e : null;
      if (e.type === 'destroyed') return e.tankId === me.id || e.by === me.id ? e : null;
      if (e.type === 'spawn') return null;
      if (e.type === 'fire') return e.tankId === me.id ? e : null;
      return 'tankId' in e && e.tankId === me.id ? e : null;
    };
    const events = g.lastEvents.map(mine).filter((e): e is GameEvent => e !== null);

    const exploredDelta = me ? flatten(me.exploredLog.slice(c.exploredSent)) : [];
    const treesDelta = me ? flatten(me.knownTreesLog.slice(c.treesSent)) : [];
    if (me) { c.exploredSent = me.exploredLog.length; c.treesSent = me.knownTreesLog.length; }

    return {
      tick: g.tick, phase: g.phase, deadline: match.deadline, serverNow: Date.now(),
      tanks, energy, events, eventsTick: g.lastEventsTick, winnerId: g.winnerId,
      exploredDelta, treesDelta,
    };
  }

  function welcome(c: Conn): Welcome {
    const g = match.game;
    const me = c.tankId ? g.tanks.get(c.tankId) : undefined;
    if (me) { c.exploredSent = 0; c.treesSent = 0; }
    const trees = c.role === 'host' ? flatten(g.trees) : me ? flatten(me.knownTreesLog) : [];
    const explored = c.role === 'player' && me ? flatten(me.exploredLog) : null;
    if (me) { c.exploredSent = me.exploredLog.length; c.treesSent = me.knownTreesLog.length; }
    return {
      type: 'welcome', role: c.role, tankId: c.tankId, seed: g.seed, rules: g.rules,
      trees, explored,
      snapshot: c.role === 'host' ? hostSnapshot() : playerSnapshot(c),
      mcpUrl: opts.mcpUrl,
      playerLinks: c.role === 'host' ? playerLinks() : undefined,
    };
  }

  // A reset swaps the Game object: everyone needs a fresh welcome.
  let lastGame = match.game;
  match.onChange(() => {
    const reset = match.game !== lastGame;
    lastGame = match.game;
    let host: Snapshot | null = null;
    for (const c of conns) {
      if (reset) { send(c.ws, welcome(c)); continue; }
      if (c.role === 'host') {
        host ??= hostSnapshot();
        send(c.ws, { type: 'state', ...host });
        send(c.ws, { type: 'links', playerLinks: playerLinks() });
      } else {
        send(c.ws, { type: 'state', ...playerSnapshot(c) });
      }
    }
  });

  // Keep the turn clock honest on clients even when nothing else changes.
  const heartbeat = setInterval(() => {
    for (const c of conns) if (c.ws.readyState === WebSocket.OPEN) c.ws.ping();
  }, 20_000);
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws) => {
    let conn: Conn | null = null;
    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      if (msg.type === 'hello') {
        if (msg.role === 'host') {
          if (msg.key !== opts.hostKey) return send(ws, { type: 'error', message: 'Invalid host key.' });
          conn = { ws, role: 'host', tankId: null, exploredSent: 0, treesSent: 0 };
        } else {
          const t = match.findByToken(msg.token);
          if (!t) return send(ws, { type: 'error', message: 'Unknown player link. Ask the host for a new one.' });
          conn = { ws, role: 'player', tankId: t.id, exploredSent: 0, treesSent: 0 };
        }
        conns.add(conn);
        send(ws, welcome(conn));
        return;
      }

      if (msg.type === 'host') {
        if (conn?.role !== 'host') return send(ws, { type: 'error', message: 'Host commands need the host key.' });
        try {
          switch (msg.cmd) {
            case 'start': match.start(); break;
            case 'pause': match.pause(); break;
            case 'resume': match.resume(); break;
            case 'reset': match.reset(msg.seed); break;
            case 'kick': match.kick(msg.tankId); break;
            case 'addBot': match.join(`Bot ${botName()}`, { isBot: true }); break;
          }
        } catch (e) {
          send(ws, { type: 'error', message: e instanceof GameError ? e.message : 'Command failed.' });
        }
      }
    });
    ws.on('close', () => { if (conn) conns.delete(conn); });
  });

  const BOT_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
  const botName = () => BOT_NAMES.find((n) => ![...match.game.tanks.values()].some((t) => t.name === `Bot ${n}`)) ?? 'Zulu';

  return wss;
}
