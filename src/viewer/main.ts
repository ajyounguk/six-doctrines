// The Six Doctrines viewer: connects over WebSocket as host (?host=KEY) or player (?player=TOKEN).

import { hexDistance, hexLength, alignedDirection } from '../shared/hex.js';
import type { Action, ClientMessage, GameEvent, HostCommand, ServerMessage, Snapshot, TankView, Welcome } from '../shared/protocol.js';
import type { Rules } from '../shared/rules.js';
import { Renderer } from './renderer.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const params = new URLSearchParams(location.search);
const hostKey = params.get('host');
const playerToken = params.get('player');

// ------------------------------------------------------------ landing

if (!hostKey && !playerToken) {
  $('landing').hidden = false;
  $('landing-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $<HTMLInputElement>('landing-input').value.trim();
    if (!v) return;
    try {
      const u = new URL(v);
      location.href = `${location.pathname}${u.search}`;
    } catch {
      location.href = `${location.pathname}?host=${encodeURIComponent(v)}`;
    }
  });
} else {
  $('app').hidden = false;
  start();
}

// ------------------------------------------------------------ app

function start() {
  const renderer = new Renderer($<HTMLCanvasElement>('board'), $<HTMLCanvasElement>('minimap'));

  let ws: WebSocket | null = null;
  let role: Welcome['role'] = hostKey ? 'host' : 'player';
  let myId: string | null = null;
  let rules: Rules | null = null;
  let snap: Snapshot | null = null;
  let clockOffset = 0; // serverNow - Date.now()
  let tickLength = 30_000;
  let lastEventsTick = -1;
  let links: Record<string, string> = {};
  let firstWelcome = true;
  let retry = 0;
  let lastLobbyKey = '';

  const send = (m: ClientMessage) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  const host = (m: HostCommand) => send({ type: 'host', ...m });

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      $('hud-conn').hidden = true;
      send(hostKey ? { type: 'hello', role: 'host', key: hostKey } : { type: 'hello', role: 'player', token: playerToken! });
    };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data) as ServerMessage);
    ws.onclose = () => {
      $('hud-conn').hidden = false;
      setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
    };
  }

  function onMessage(m: ServerMessage) {
    switch (m.type) {
      case 'welcome': {
        role = m.role;
        myId = m.tankId;
        rules = m.rules;
        tickLength = m.rules.turnTimeoutMs;
        links = m.playerLinks ?? {};
        renderer.setBoard(m.rules.boardRadius, m.trees, m.explored);
        lastEventsTick = m.snapshot.eventsTick; // don't replay old events on (re)connect
        $('log').innerHTML = '';
        setupChrome(m);
        applySnapshot(m.snapshot);
        if (firstWelcome) {
          firstWelcome = false;
          const me = m.snapshot.tanks.find((t) => t.id === myId);
          if (role === 'player' && me?.pos) {
            renderer.focusHex(me.pos, 20);
            renderer.setFollow(true);
          } else renderer.fit();
        }
        break;
      }
      case 'state': {
        const { type: _, ...s } = m;
        applySnapshot(s);
        break;
      }
      case 'links':
        links = m.playerLinks;
        break;
      case 'error':
        toast(m.message, true);
        break;
    }
  }

  function applySnapshot(s: Snapshot) {
    const prev = snap;
    snap = s;
    clockOffset = s.serverNow - Date.now();
    if (s.exploredDelta?.length || s.treesDelta?.length) renderer.reveal(s.exploredDelta, s.treesDelta);

    // Play the last resolved tick's events once; move paths come from the events themselves.
    const fresh = s.eventsTick > lastEventsTick && s.eventsTick > 0;
    renderer.setSnapshot(s, myId);
    if (fresh) {
      lastEventsTick = s.eventsTick;
      renderer.playEvents(s.events, s.tanks);
      logEvents(s.eventsTick, s.events, s.tanks);
    }
    if (prev && prev.phase !== s.phase) logPhase(s);
    renderSidebar();
    renderOverlay();
  }

  // ------------------------------------------------------------ chrome

  function setupChrome(w: Welcome) {
    const me = w.snapshot.tanks.find((t) => t.id === w.tankId);
    $('role-badge').innerHTML = role === 'host'
      ? `<span class="swatch" style="background:var(--accent)"></span><span class="who">Host console</span>`
      : `<span class="swatch" style="background:${me?.color}"></span><span class="who">${esc(me?.name ?? 'Player')}</span>`;
    $('panel-host').hidden = role !== 'host';
    $('btn-follow').hidden = role !== 'player';
    $('foot-follow').hidden = role !== 'player';
    $('mcp-url').textContent = w.mcpUrl;
    $('mcp-cmd').textContent = `claude mcp add --transport http six-doctrines ${w.mcpUrl}`;
    $('seed-label').textContent = `seed ${w.seed}`;
    document.title = role === 'host' ? 'Six Doctrines · Host' : `Six Doctrines · ${me?.name ?? 'Player'}`;
  }

  function renderSidebar() {
    if (!snap || !rules) return;
    const s = snap;
    const pill = $('phase-pill');
    pill.className = `phase ${s.phase}`;
    pill.textContent = s.phase;
    $('hud-tick').textContent = s.phase === 'lobby' ? 'LOBBY' : `TICK ${s.tick} / ${rules.maxTicks}`;
    $('tank-count').textContent = `${s.tanks.filter((t) => t.alive).length}/${s.tanks.length} alive`;

    if (role === 'host') {
      $<HTMLButtonElement>('btn-start').disabled = s.phase !== 'lobby' || s.tanks.length === 0;
      const pause = $<HTMLButtonElement>('btn-pause');
      pause.disabled = s.phase !== 'running' && s.phase !== 'paused';
      pause.textContent = s.phase === 'paused' ? 'Resume' : 'Pause';
      $<HTMLButtonElement>('btn-bot').disabled = s.phase !== 'lobby' || s.tanks.length >= rules.maxPlayers;
    }

    const tanks = [...s.tanks].sort((a, b) => Number(b.id === myId) - Number(a.id === myId));
    const html = tanks.map((t) => tankCard(t, s)).join('');
    const empties = s.phase === 'lobby' ? Math.max(0, rules.maxPlayers - s.tanks.length) : 0;
    $('tanks').innerHTML = html + Array.from({ length: empties }, () => `<div class="tank-empty">Open slot</div>`).join('');
  }

  function tankCard(t: TankView, s: Snapshot): string {
    const R = rules!;
    const me = t.id === myId;
    const full = t.energy !== undefined; // we're allowed to see this tank's internals
    let chip = '';
    if (!t.alive) chip = `<span class="chip dead">destroyed</span>`;
    else if (s.phase === 'finished') chip = t.id === s.winnerId ? `<span class="chip win">winner</span>` : t.placement ? `<span class="chip">#${t.placement}</span>` : '';
    else if (s.phase === 'running' && t.submitted !== undefined) chip = t.submitted ? `<span class="chip ready">ready</span>` : `<span class="chip thinking">thinking</span>`;
    else if (s.phase === 'lobby') chip = `<span class="chip ready">joined</span>`;

    const hp = t.hp ?? null;
    const bars = full || hp !== null ? `
      <div class="bars">
        ${hp !== null ? bar('HP', hp, R.startHp, 'hp') : ''}
        ${full ? bar('EN', t.energy!, R.maxEnergy, 'en') : ''}
      </div>` : '';

    let meta = '';
    if (full && t.stats) {
      const act = describeAction(t.lastAction ?? null, s.phase);
      const laser = t.canFireAtTick !== undefined && t.canFireAtTick > s.tick ? `laser ${t.canFireAtTick - s.tick}t` : 'laser ready';
      meta = `<div class="tank-meta"><span class="act">${esc(act)}</span><span>${laser}</span></div>
        <div class="tank-meta"><span>K ${t.stats.kills} · dmg ${t.stats.damageDealt} · hit ${t.stats.shotsHit}/${t.stats.shotsFired}</span><span>⌛${t.stats.timeouts}</span></div>`;
    } else if (!me && t.alive && s.phase !== 'lobby') {
      meta = `<div class="tank-meta"><span>${t.seenTick !== undefined ? `last seen ${s.tick - t.seenTick} ticks ago` : 'not seen yet'}</span>${t.pos && snap ? `<span>${distanceFromMe(t.pos)}</span>` : ''}</div>`;
    }

    const actions = role === 'host' ? `
      <div class="tank-actions">
        ${links[t.id] ? `<button class="btn" data-link="${t.id}">Copy player link</button>` : ''}
        ${s.phase === 'lobby' ? `<button class="btn btn-ghost" data-kick="${t.id}">Remove</button>` : ''}
      </div>` : '';

    return `<div class="tank ${me ? 'me' : ''} ${t.alive ? '' : 'dead'}" style="--c:${t.color}" data-tank="${t.id}">
      <div class="tank-head"><span class="tank-name">${esc(t.name)}${me ? ' <span class="muted small">(you)</span>' : ''}</span>${chip}</div>
      ${bars}${meta}${actions}
    </div>`;
  }

  const bar = (label: string, v: number, max: number, cls: string) => {
    const pct = Math.max(0, Math.min(100, (v / max) * 100));
    const pos = cls === 'hp' ? `background-position:${pct}% 0` : '';
    return `<div class="bar"><span>${label}</span><div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%;${pos}"></div></div><span class="val">${v}</span></div>`;
  };

  function distanceFromMe(pos: { q: number; r: number }) {
    const me = snap?.tanks.find((t) => t.id === myId);
    if (!me?.pos) return '';
    const d = hexDistance(me.pos, pos);
    const dir = alignedDirection(me.pos, pos);
    return `${d} hex${dir ? ` · in line ${dir}` : ''}`;
  }

  function describeAction(a: Action | null, phase: string): string {
    if (phase === 'lobby') return 'waiting to start';
    if (!a) return 'idle';
    switch (a.type) {
      case 'move': return `moved ${a.direction} ×${a.distance}`;
      case 'scan': return `scanned r${a.radius}`;
      case 'fire': return `fired ${a.direction} p${a.power}`;
      case 'wait': return 'waited';
    }
  }

  // ------------------------------------------------------------ overlay

  function renderOverlay() {
    const s = snap!;
    const ov = $('overlay');
    if (s.phase === 'lobby') {
      const key = JSON.stringify(s.tanks.map((t) => [t.id, t.name]));
      if (!ov.hidden && key === lastLobbyKey) return;
      lastLobbyKey = key;
      const slots = Array.from({ length: rules!.maxPlayers }, (_, i) => {
        const t = s.tanks[i];
        return t
          ? `<div class="slot filled" style="--c:${t.color}"><div class="hexdot"></div><span>${esc(t.name)}</span></div>`
          : `<div class="slot"><div class="hexdot"></div><span>open</span></div>`;
      }).join('');
      ov.innerHTML = `<div class="overlay-card">
        <h2>Waiting for tanks</h2>
        <p>${s.tanks.length} of ${rules!.maxPlayers} joined${role === 'host' ? ' · start when ready' : ' · the host starts the match'}</p>
        <div class="slots">${slots}</div>
        ${role === 'host' ? `<button class="btn btn-primary" id="ov-start" ${s.tanks.length ? '' : 'disabled'}>Start match</button>` : ''}
      </div>`;
      ov.hidden = false;
      $('ov-start')?.addEventListener('click', () => host({ cmd: 'start' }));
      return;
    }
    lastLobbyKey = '';
    if (s.phase === 'finished') {
      const ranked = [...s.tanks].sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99));
      const winner = s.tanks.find((t) => t.id === s.winnerId);
      const rows = ranked.map((t) => `<div class="podium-row" style="--c:${t.color}">
        <span class="place">${t.placement ?? '–'}</span>
        <span>${esc(t.name)}${t.id === myId ? ' <span class="muted small">(you)</span>' : ''}</span>
        <span class="stats">${t.stats ? `K ${t.stats.kills} · dmg ${t.stats.damageDealt} · ${t.hp ?? 0} hp` : ''}</span>
      </div>`).join('');
      ov.innerHTML = `<div class="overlay-card">
        <h2>${winner ? `${esc(winner.name)} wins` : 'Draw'}</h2>
        <p>Match over at tick ${s.tick}</p>
        <div class="podium">${rows}</div>
        ${role === 'host' ? `<button class="btn btn-primary" id="ov-reset" style="margin-top:14px">New battlefield</button>` : ''}
        <button class="btn btn-ghost" id="ov-close" style="margin-top:14px">View battlefield</button>
      </div>`;
      ov.hidden = false;
      $('ov-reset')?.addEventListener('click', () => host({ cmd: 'reset' }));
      $('ov-close').addEventListener('click', () => (ov.hidden = true), { once: true });
      return;
    }
    ov.hidden = true;
  }

  // ------------------------------------------------------------ log

  const nameOf = (id: string, tanks: TankView[]) => {
    const t = tanks.find((x) => x.id === id);
    return t ? `<span class="n" style="color:${t.color}">${esc(t.name)}</span>` : '<span class="n">?</span>';
  };

  function logLine(tick: number | string, html: string) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="t">${tick}</span><span>${html}</span>`;
    const log = $('log');
    log.prepend(li);
    while (log.children.length > 300) log.lastElementChild!.remove();
  }

  function logEvents(tick: number, events: GameEvent[], tanks: TankView[]) {
    const n = (id: string) => nameOf(id, tanks);
    for (const e of events) {
      switch (e.type) {
        case 'move':
          logLine(tick, `${n(e.tankId)} moved ${e.direction} ${e.path.length - 1}/${e.requested}${e.blockedBy ? ` <span class="muted">(${e.blockedBy})</span>` : ''}`);
          break;
        case 'fire':
          logLine(tick, `${n(e.tankId)} fired ${e.direction} p${e.power} → ${e.hit ? `<span class="hit">hit</span> ${n(e.hit)}` : `<span class="muted">${e.stoppedBy}</span>`}`);
          break;
        case 'damage':
          logLine(tick, `${n(e.tankId)} <span class="hit">−${e.amount} hp</span>${e.by ? ` from ${n(e.by)}` : ` from the ${e.fromDirection}`} <span class="muted">(${e.hp} left)</span>`);
          break;
        case 'destroyed':
          logLine(tick, `<span class="hit">✖</span> ${n(e.tankId)} destroyed by ${n(e.by)}`);
          break;
        case 'pickup':
          logLine(tick, `${n(e.tankId)} <span class="en">+${e.amount} energy</span>`);
          break;
        case 'scan':
          logLine(tick, `${n(e.tankId)} scanned r${e.radius} <span class="muted">(−${e.cost})</span>`);
          break;
        case 'timeout':
          logLine(tick, `${n(e.tankId)} <span class="muted">timed out</span>`);
          break;
        case 'spawn':
          logLine(tick, `<span class="en">◆ ${e.cells.length} energy cells spawned</span>`);
          break;
        case 'wait':
          break; // too chatty
      }
    }
  }

  function logPhase(s: Snapshot) {
    const msg = { lobby: 'Back in the lobby', running: 'Match running', paused: 'Match paused', finished: 'Match over' }[s.phase];
    logLine('—', `<span class="good">${msg}</span>`);
  }

  // ------------------------------------------------------------ clock

  setInterval(() => {
    const clock = $('hud-clock');
    const text = $('clock-text');
    const ring = $('clock-ring');
    if (!snap?.deadline || snap.phase !== 'running') {
      text.textContent = snap?.phase === 'paused' ? '❚❚' : '—';
      ring.style.strokeDashoffset = '0';
      clock.className = 'hud-clock';
      return;
    }
    const left = Math.max(0, snap.deadline - (Date.now() + clockOffset));
    const frac = left / tickLength;
    text.textContent = String(Math.ceil(left / 1000));
    ring.style.strokeDashoffset = String(94.25 * (1 - frac));
    clock.className = `hud-clock ${frac < 0.2 ? 'low' : frac < 0.5 ? 'mid' : ''}`;
  }, 200);

  // ------------------------------------------------------------ tooltip

  const tip = $('tooltip');
  renderer.onHover = (info) => {
    if (!info || !snap) { tip.hidden = true; return; }
    const { hex: h } = info;
    const lines: string[] = [`<b>(${h.q}, ${h.r})</b> <span class="k">· ${hexLength(h)} from centre</span>`];
    if (!renderer.isExplored(h)) lines.push('<span class="k">unexplored</span>');
    else if (renderer.isTree(h)) lines.push('🌲 tree <span class="k">blocks movement + lasers</span>');
    for (let i = 0; i < snap.energy.length; i += 3) {
      if (snap.energy[i] === h.q && snap.energy[i + 1] === h.r) lines.push(`<span style="color:var(--accent)">◆ energy ${snap.energy[i + 2]}</span>`);
    }
    for (const t of snap.tanks) {
      if (t.pos?.q === h.q && t.pos?.r === h.r) {
        const ghost = t.seenTick !== undefined && t.id !== myId;
        lines.push(`<span style="color:${t.color}">■ ${esc(t.name)}</span>${t.hp !== undefined ? ` <span class="k">${t.hp} hp</span>` : ''}${ghost ? ` <span class="k">seen ${snap.tick - t.seenTick!}t ago</span>` : ''}`);
      }
    }
    const rel = renderer.hexDistanceFromMe(h);
    if (rel && rel.distance > 0) lines.push(`<span class="k">${rel.distance} hex from you${rel.inLine ? ` · in line <b>${rel.inLine}</b>` : ''}</span>`);
    tip.innerHTML = lines.join('<br>');
    tip.hidden = false;
    const stage = $('board').getBoundingClientRect();
    const x = Math.min(info.x + 16, stage.width - tip.offsetWidth - 8);
    const y = Math.min(info.y + 16, stage.height - tip.offsetHeight - 8);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };

  // ------------------------------------------------------------ controls

  document.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((b) =>
    b.addEventListener('click', () => {
      const z = b.dataset.zoom;
      if (z === 'in') renderer.zoomBy(1.4);
      else if (z === 'out') renderer.zoomBy(1 / 1.4);
      else if (z === 'fit') renderer.fit();
      else if (z === 'follow') renderer.setFollow(!renderer.follow);
    }));
  renderer.onFollowChange = (on) => $('btn-follow').classList.toggle('active', on);

  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'f' || e.key === 'F') renderer.fit();
    else if ((e.key === 't' || e.key === 'T') && role === 'player') renderer.setFollow(!renderer.follow);
    else if (e.key === '+' || e.key === '=') renderer.zoomBy(1.4);
    else if (e.key === '-' || e.key === '_') renderer.zoomBy(1 / 1.4);
    else if (e.key === ' ' && role === 'host' && snap) {
      e.preventDefault();
      host({ cmd: snap.phase === 'paused' ? 'resume' : 'pause' });
    }
  });

  $('btn-start').addEventListener('click', () => host({ cmd: 'start' }));
  $('btn-pause').addEventListener('click', () => host({ cmd: snap?.phase === 'paused' ? 'resume' : 'pause' }));
  $('btn-bot').addEventListener('click', () => host({ cmd: 'addBot' }));
  $('btn-reset').addEventListener('click', () => {
    if (snap?.phase === 'running' && !confirm('Abandon the current match and generate a new battlefield?')) return;
    const v = $<HTMLInputElement>('seed-input').value.trim();
    host({ cmd: 'reset', seed: v ? Number(v) : undefined });
    $<HTMLInputElement>('seed-input').value = '';
  });

  $('tanks').addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const link = el.closest<HTMLElement>('[data-link]')?.dataset.link;
    const kick = el.closest<HTMLElement>('[data-kick]')?.dataset.kick;
    if (link) return copy(links[link], 'Player link copied');
    if (kick) return host({ cmd: 'kick', tankId: kick });
    const id = el.closest<HTMLElement>('[data-tank]')?.dataset.tank;
    if (id) { renderer.setFollow(false); renderer.focusTank(id); }
  });

  document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => copy($(b.dataset.copy!).textContent ?? '', 'Copied')));

  connect();
}

// ------------------------------------------------------------ utils

async function copy(text: string, msg: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; plain http on a LAN falls back to this.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(msg);
}

let toastTimer: number | undefined;
function toast(msg: string, error = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${error ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2600);
}
