// The Six Doctrines server: MCP endpoint for agents, WebSocket + static viewer for humans.

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomSeed } from '../engine/rng.js';
import { DEFAULT_RULES, type Rules } from '../shared/rules.js';
import { allowedHostnames, isAllowedRequest } from './hosts.js';
import { createMcpServer, type SessionState } from './mcp.js';
import { Match } from './match.js';
import { attachViewerHub } from './viewerHub.js';

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

const PORT = num(env.PORT, 8080);
const HOST = env.HOST ?? '127.0.0.1';
const PUBLIC_URL = (env.PUBLIC_URL ?? `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`).replace(/\/$/, '');
const HOST_KEY = env.HOST_KEY || randomBytes(12).toString('base64url'); // 96 bits
const SEED = num(env.SEED, randomSeed());
const ALLOWED_HOSTS = allowedHostnames({ host: HOST, publicUrl: PUBLIC_URL, extra: env.ALLOWED_HOSTS });
const MAX_SESSIONS = num(env.MAX_SESSIONS, 64);

if (HOST_KEY.length < 12) console.warn('Warning: HOST_KEY is short. Anyone who can reach the server can try to guess it; use 12+ random characters.');

const rules: Rules = {
  ...DEFAULT_RULES,
  gridRadius: num(env.GRID_RADIUS, DEFAULT_RULES.gridRadius),
  turnTimeoutMs: num(env.TURN_TIMEOUT_MS, DEFAULT_RULES.turnTimeoutMs),
  minTickMs: num(env.MIN_TICK_MS, DEFAULT_RULES.minTickMs),
  maxTicks: num(env.MAX_TICKS, DEFAULT_RULES.maxTicks),
};

const match = new Match(rules, SEED);
const playerUrl = (token: string) => `${PUBLIC_URL}/?player=${token}`;
const rpcError = (message: string) => ({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (isAllowedRequest(ALLOWED_HOSTS, req.headers.host, req.headers.origin)) return next();
  res.status(403).json(rpcError('Host or Origin not allowed. Set PUBLIC_URL or ALLOWED_HOSTS to the address players use.'));
});
app.use('/mcp', express.json({ limit: '64kb' }));

// --- MCP (Streamable HTTP), one transport + server per session
interface Session {
  transport: StreamableHTTPServerTransport;
  state: SessionState;
  lastSeen: number;
  busy: number; // requests in flight; never expire a session mid-request
}
const sessions = new Map<string, Session>();

async function serve(s: Session, req: express.Request, res: express.Response, body?: unknown) {
  s.busy++;
  s.lastSeen = Date.now();
  try {
    await s.transport.handleRequest(req, res, body);
  } finally {
    s.busy--;
    s.lastSeen = Date.now();
  }
}

// Per the MCP spec, an unknown session gets 404 so the client starts a new one.
const noSession = (res: express.Response) =>
  res.status(404).json(rpcError('Unknown or expired MCP session. Re-initialise, then join with your rejoin_token.'));

app.post('/mcp', async (req, res) => {
  const sid = req.header('mcp-session-id');
  if (sid) {
    const s = sessions.get(sid);
    if (!s) { noSession(res); return; }
    await serve(s, req, res, req.body);
    return;
  }
  if (!isInitializeRequest(req.body)) { res.status(400).json(rpcError('No MCP session. Send an initialize request first.')); return; }
  if (sessions.size >= MAX_SESSIONS) { res.status(503).json(rpcError('Server is full. Try again later.')); return; }

  const state: SessionState = { proxyId: null };
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => { sessions.set(id, s); },
  });
  const s: Session = { transport, state, lastSeen: Date.now(), busy: 0 };
  transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
  await createMcpServer(match, state, { playerUrl }).connect(transport);
  await serve(s, req, res, req.body);
});

const sessionRequest: express.RequestHandler = async (req, res) => {
  const sid = req.header('mcp-session-id');
  const s = sid ? sessions.get(sid) : undefined;
  if (!s) { noSession(res); return; }
  await serve(s, req, res);
};
app.get('/mcp', sessionRequest);
app.delete('/mcp', sessionRequest);

// Drop abandoned sessions. Their proxies stay in the match; agents reclaim them with rejoin_token.
const UNJOINED_IDLE_MS = 10 * 60_000;
const JOINED_IDLE_MS = 60 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.busy) continue;
    const idle = now - s.lastSeen;
    if (idle > JOINED_IDLE_MS || (!s.state.proxyId && idle > UNJOINED_IDLE_MS)) void s.transport.close();
  }
}, 60_000).unref();

// --- Viewer
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
app.use(express.static(publicDir));

// Body-parser errors (oversized or malformed JSON): answer briefly instead of logging a stack trace.
app.use(((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const status: number = err?.status ?? err?.statusCode ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json(rpcError(status === 413 ? 'Request too large.' : status < 500 ? 'Bad request.' : 'Internal error.'));
}) as express.ErrorRequestHandler);

const httpServer = createServer(app);
attachViewerHub(httpServer, match, { hostKey: HOST_KEY, mcpUrl: `${PUBLIC_URL}/mcp`, playerUrl, allowedHosts: ALLOWED_HOSTS });

httpServer.listen(PORT, HOST, () => {
  const line = '─'.repeat(64);
  console.log(`\n${line}\n  THE SIX DOCTRINES  ·  seed ${SEED}  ·  grid radius ${rules.gridRadius}\n${line}`);
  console.log(`  Host view   ${PUBLIC_URL}/?host=${HOST_KEY}`);
  console.log(`  MCP         ${PUBLIC_URL}/mcp`);
  console.log(`  Listening   ${HOST}:${PORT}${HOST === '127.0.0.1' ? '  (set HOST=0.0.0.0 to let players on your network in)' : ''}`);
  console.log(`  Hosts       ${ALLOWED_HOSTS.join(', ')}`);
  console.log(`${line}\n`);
});
