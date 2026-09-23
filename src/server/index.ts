// The Six Doctrines server: MCP endpoint for agents, WebSocket + static viewer for humans.

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomSeed } from '../engine/rng.js';
import { DEFAULT_RULES, type Rules } from '../shared/rules.js';
import { createMcpServer, type SessionState } from './mcp.js';
import { Match } from './match.js';
import { attachViewerHub } from './viewerHub.js';

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

const PORT = num(env.PORT, 8080);
const HOST = env.HOST ?? '127.0.0.1';
const PUBLIC_URL = (env.PUBLIC_URL ?? `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`).replace(/\/$/, '');
const HOST_KEY = env.HOST_KEY ?? randomUUID().slice(0, 8);
const SEED = num(env.SEED, randomSeed());

const rules: Rules = {
  ...DEFAULT_RULES,
  boardRadius: num(env.BOARD_RADIUS, DEFAULT_RULES.boardRadius),
  turnTimeoutMs: num(env.TURN_TIMEOUT_MS, DEFAULT_RULES.turnTimeoutMs),
  minTickMs: num(env.MIN_TICK_MS, DEFAULT_RULES.minTickMs),
  maxTicks: num(env.MAX_TICKS, DEFAULT_RULES.maxTicks),
};

const match = new Match(rules, SEED);
const playerUrl = (token: string) => `${PUBLIC_URL}/?player=${token}`;

const app = express();
app.disable('x-powered-by');
app.use('/mcp', express.json({ limit: '1mb' }));

// --- MCP (Streamable HTTP), one transport + server per session
const sessions = new Map<string, StreamableHTTPServerTransport>();

app.post('/mcp', async (req, res) => {
  const sid = req.header('mcp-session-id');
  let transport = sid ? sessions.get(sid) : undefined;

  if (!transport) {
    if (sid || !isInitializeRequest(req.body)) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid MCP session. Re-initialise.' }, id: null });
      return;
    }
    const state: SessionState = { tankId: null };
    const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, t); },
    });
    t.onclose = () => { if (t.sessionId) sessions.delete(t.sessionId); };
    await createMcpServer(match, state, { playerUrl }).connect(t);
    transport = t;
  }
  await transport.handleRequest(req, res, req.body);
});

const sessionRequest: express.RequestHandler = async (req, res) => {
  const sid = req.header('mcp-session-id');
  const transport = sid ? sessions.get(sid) : undefined;
  if (!transport) { res.status(400).send('No valid MCP session.'); return; }
  await transport.handleRequest(req, res);
};
app.get('/mcp', sessionRequest);
app.delete('/mcp', sessionRequest);

// --- Viewer
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
app.use(express.static(publicDir));

const httpServer = createServer(app);
attachViewerHub(httpServer, match, { hostKey: HOST_KEY, mcpUrl: `${PUBLIC_URL}/mcp`, playerUrl });

httpServer.listen(PORT, HOST, () => {
  const line = '─'.repeat(64);
  console.log(`\n${line}\n  THE SIX DOCTRINES  ·  seed ${SEED}  ·  board radius ${rules.boardRadius}\n${line}`);
  console.log(`  Host view   ${PUBLIC_URL}/?host=${HOST_KEY}`);
  console.log(`  MCP         ${PUBLIC_URL}/mcp`);
  console.log(`  Listening   ${HOST}:${PORT}${HOST === '127.0.0.1' ? '  (set HOST=0.0.0.0 to let players on your network in)' : ''}`);
  console.log(`${line}\n`);
});
