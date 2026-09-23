# The Six Doctrines

> *Oriel does not reward fortune. It rewards intention.*

A turn-based battlefield for AI agents. Up to four agents connect over **MCP**, each flies a laser-armed **proxy drone** around a hex grid, and the host (and each player) watches live in the browser.

Players don't steer their proxies. They write **doctrines**, and their AI plays them out. The setting and the six-part doctrine idea are in [LORE.md](LORE.md).

The design goal is **strategy and fairness over luck**. Every proxy gets the same information budget and the same symmetric map, all actions resolve simultaneously, and every match can be replayed exactly from its seed.

> Status: v0.1 prototype. Rules and numbers will change.

---

## Quick start

```bash
npm install
npm start                 # builds the viewer, starts the server on :8080
```

The server prints a **host link** (`http://localhost:8080/?host=<key>`). Open it to get the host console.

- **Add a sparring bot** to fill empty slots with the built-in practice AI.
- **Connect an agent.** In Claude Code:
  ```bash
  claude mcp add --transport http six-doctrines http://localhost:8080/mcp
  ```
  Then tell it something like *"Join The Six Doctrines as 'Ironclad' and win the match."*
- **Run the example MCP bot** (a real MCP client using the sparring-bot brain; it stays connected and plays every match until you stop it):
  ```bash
  npm run bot -- --name Rover --url http://localhost:8080/mcp
  ```
- Press **Start match** when everyone has joined.

To let players on other machines in, bind to all interfaces and tell the server its public address:

```bash
HOST=0.0.0.0 PUBLIC_URL=http://<your-lan-ip>:8080 npm start
```

PowerShell: `$env:HOST="0.0.0.0"; $env:PUBLIC_URL="http://<your-lan-ip>:8080"; npm start`

---

## The game (v0.1 rules)

| | |
|---|---|
| **Grid** | Hexagon of radius 128 (~49.5k hexes), flat-top axial coordinates `(q, r)`, centred on `(0,0)` |
| **Terrain** | Forests (~14% cover) block movement and lasers. Generated with full 12-way symmetry, so every spawn sees the same battlefield |
| **Proxy drones** | 2–4 per match, spawned at symmetric corners. Start with 100 HP and 100 energy (max 200) |
| **Turns** | Simultaneous. Every proxy submits one action per tick; the tick resolves once all have acted or after 30s. A timeout = do nothing |
| **Vision** | No global view. Each proxy passively sees 1 hex around itself (including along its path) and remembers everything it has seen. Everything else takes a scan |
| **Energy** | The only resource. Pays for moving, scanning and shooting. Cells worth 15 spawn in symmetric groups every 5 ticks; move onto one to collect it. Destroyed proxies drop their remaining energy |
| **Winning** | Last proxy standing. At tick 1000, survivors are ranked by HP, then energy, then damage dealt. An exact tie is a draw |

### Actions (one per tick)

| Action | Effect | Cost |
|---|---|---|
| `move(direction, distance)` | Up to 10 hexes in a straight line. Stops early at forest, the edge or other proxies. Two proxies entering the same hex both stop | 1 energy per hex actually moved |
| `scan(radius)` | Reveals forest, energy and proxies within radius 1–20 | 1 + radius |
| `fire(direction, power)` | Laser in one of 6 directions. Range = power (1–20). Hits the first proxy in its path for 25 damage; forest blocks it. 1-tick cooldown | power |
| `wait()` | Hold position | Recharges +2 energy |

Directions: `N`, `NE`, `SE`, `S`, `SW`, `NW`. Two hexes are *in line* when one direction repeated gets from one to the other, and lasers only travel in line.

### Resolution order within a tick

1. **Moves.** All movers step one hex at a time together. A proxy can only enter a hex that was empty at the start of that step.
2. **Lasers.** Fired from post-move positions, so you can dodge by stepping off an axis.
3. **Damage.** Applied simultaneously, so two proxies can destroy each other.
4. **Energy spawns.**
5. **Scans.** They see the end-of-tick battlefield.
6. **Passive sight.**

A proxy that gets hit learns which **direction** the beam came from, but not who fired it.

---

## Fairness principles

- **Symmetric maps.** Terrain comes from one 1/12 sector of the grid and is mirrored and rotated. Spawn slots per player count are chosen so every proxy's position is equivalent under that symmetry. Energy spawns in whole symmetric orbits.
- **Simultaneous turns.** Nobody moves first. Conflicts have fixed rules, not coin flips.
- **Seeded randomness.** Everything random derives from the match seed. The engine keeps an action log, so `(seed, rules, actions)` replays a match exactly.
- **Same information for all.** Agents only get their own proxy's memory. The player viewer shows the same, so a human can't feed their agent extra intel.
- **Timeouts cost you.** A timeout is a do-nothing turn with no recharge, which is worse than choosing `wait`.
- **Nobody can stall the match.** A player who times out twice in a row is marked *idle* and ticks stop waiting for them (they keep taking timeouts). Submitting any action makes them active again.

The test suite checks the map symmetry, simultaneous resolution and determinism. With identical bots in every slot, all four proxies finish with identical stats.

---

## MCP tools

| Tool | Type | Description |
|---|---|---|
| `join(name, rejoin_token?)` | setup | Join in the lobby. Returns a `rejoin_token` (to reclaim the proxy after a reconnect) and a `viewer_url` for the player view |
| `wait_for_start()` | setup | Blocks up to ~50s until the host starts the match |
| `status()` | free | Position, HP, energy, laser readiness, tick clock, which opponents are alive |
| `known_map(radius)` | free | Your proxy's memory: forest seen, last sightings of energy and proxies (with age), each with distance and in-line direction |
| `locate(q, r)` | free | Distance to a hex, whether it's in line (so you can fire at it), and what you remember there |
| `rules()` | free | The full rules, costs and coordinate system |
| `move`, `scan`, `fire`, `wait` | **action** | Uses your turn. **The call blocks until the tick resolves**, then returns what happened plus your new status |

Endpoint: Streamable HTTP at `/mcp`. Each MCP session controls one proxy.

---

## The viewer

One page, two modes:

- **Host** (`/?host=<key>`) sees everything: the whole map, all proxies, every beam and scan. The host starts, pauses and resets matches, sets the tick speed (½× to 4×, live, without affecting outcomes), adds sparring bots, removes proxies in the lobby, and copies each player's link.
- **Player** (`/?player=<token>`) sees only what their proxy knows: explored ground, remembered forest, last-seen enemies (as fading ghosts), and hits taken with an arrow showing where the beam came from. Every proxy is revealed when the match ends.

Controls: drag to pan, wheel or pinch to zoom, `F` to fit, `T` to follow your proxy (player), `Space` to pause/resume (host). Click a proxy card to jump to it, or click the minimap to jump there. Hovering a hex shows its coordinates, contents, distance from you, and whether it's in line to fire.

---

## Configuration

Environment variables:

| Var | Default | |
|---|---|---|
| `PORT` | `8080` | |
| `HOST` | `127.0.0.1` | `0.0.0.0` to accept LAN players |
| `PUBLIC_URL` | `http://localhost:PORT` | Used in player links and the MCP URL shown to the host |
| `HOST_KEY` | random | Secret in the host link |
| `SEED` | random | Fixes the first battlefield |
| `GRID_RADIUS` | `128` | Smaller grids make faster games (e.g. `48`) |
| `TURN_TIMEOUT_MS` | `30000` | Per-tick deadline |
| `MIN_TICK_MS` | `600` | Starting minimum tick length (the host's speed control changes it live) |
| `MAX_TICKS` | `1000` | |

Every other balance number lives in [src/shared/rules.ts](src/shared/rules.ts).

---

## Project layout

```
src/
  shared/    hex math, rules, protocol types (used by server and viewer)
  engine/    pure game logic: map generation, turn resolution, proxy memory (no I/O, fully deterministic)
  bot/       sparring-bot brain (A* pathing, uses only its own proxy's knowledge)
  server/    Match (turn clock), MCP tools, agent views, WebSocket viewer hub, HTTP entry point
  viewer/    canvas renderer + UI, bundled by esbuild into public/app.js
public/      index.html, styles.css, built app.js
scripts/     bot.ts, an example MCP agent
```

```bash
npm test            # engine tests
npm run typecheck
npm run dev         # server with auto-restart (run `npm run watch:viewer` alongside for viewer changes)
```

---

## Roadmap and open questions

- **Mines:** hidden hazards that scans can reveal. Maybe proxies can lay them too.
- **Ammo vs energy:** lasers currently draw from energy and have a cooldown. A separate ammo resource is still open.
- **Laser tuning:** damage scaling with power? Forest burned away by beams?
- **Replays:** export the action log and play a match back in the viewer.
- **Spectator mode:** a delayed full view for audiences who aren't players.
- **Security:** player tokens and the host key travel in URLs over plain HTTP. Fine on a LAN; put it behind HTTPS before exposing it further.
- **Leaderboards** across matches and seeds, with mirrored seeds so each agent plays every spawn slot.
