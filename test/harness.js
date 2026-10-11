// Shared helpers for the integration tests: spawn a GAME_FAST server, fake phones, a fake display, waiting and checks.
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port, httpsPort) {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), HTTPS_PORT: String(httpsPort), GAME_FAST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => { const s = String(d); if (!s.includes('selfsigned') && !s.includes('TLS')) process.stderr.write('[server] ' + s); });
  return server;
}

// A fake display: keeps the latest state, every event, and game-specific notifications.
function display(port) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const d = { ws, state: null, events: [], fires: 0, bumps: [], outs: [], dashes: [] };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', role: 'display' })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'state') d.state = m;
    else if (m.t === 'event') d.events.push(m);
    else if (m.t === 'fire') d.fires++;
    else if (m.t === 'bumper:bump') d.bumps.push(m);
    else if (m.t === 'bumper:out') d.outs.push(m.pid);
    else if (m.t === 'bumper:dash') d.dashes.push(m.pid);
  });
  d.cmd = (cmd) => ws.send(JSON.stringify({ t: 'cmd', cmd }));
  d.player = (pid) => d.state && d.state.players.find((p) => p.pid === pid);
  d.mode = () => d.state && d.state.game.mode;
  d.zone = (id) => d.state.game.games.find((g) => g.id === id).zone;
  d.close = () => ws.close();
  return d;
}

// A fake phone. It answers pings, streams orientation at 30 Hz, and (optionally) plays Quick Draw by itself.
// behavior: normal | falsestart | sleepy | nofire | misfire | manual (does nothing by itself)
function bot(port, name, { reaction = 250, behavior = 'normal', clockSkew = 0 } = {}) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const now = () => Date.now() + clockSkew;
  const b = { name, pid: 'bot_' + name, ws, beta: 45, screen: 'lobby', screens: [], results: [], misfires: 0, holsterOk: null, zone: null, zones: [], open: false };
  const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  b.send = send;
  b.close = () => ws.close();
  b.ready = new Promise((res) => ws.on('open', () => { b.open = true; res(); }));
  ws.on('open', () => {
    send({ t: 'hello', role: 'controller', pid: b.pid, name });
    b.timer = setInterval(() => send({ t: 'motion', ts: now(), alpha: 0, beta: b.beta, gamma: 0, ax: 0, ay: 0, az: 0 }), 33);
  });
  ws.on('close', () => clearInterval(b.timer));
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t === 'ping') return send({ t: 'pong', s: m.s, c: now() });
    if (m.t === 'misfire') { b.misfires++; return; }
    if (m.t === 'holster') { b.holsterOk = m.ok; return; }
    if (m.t === 'zone') { b.zone = m.game; b.zones.push(m.game); return; }
    if (m.t !== 'game') return;
    b.screen = m.screen; b.screens.push(m); b.last = m;
    if (m.screen.endsWith('result')) b.results.push(m); // result / bumper-result / parkour-result
    if (behavior === 'manual') return;
    switch (m.screen) {
      case 'lobby': case 'spectate': b.beta = 45; break;
      case 'intro': case 'holster': if (behavior !== 'sleepy') b.beta = -80; break;
      case 'wait': if (behavior === 'falsestart') setTimeout(() => { b.beta = 0; send({ t: 'shot', ts: now(), beta: 0 }); }, 150); break;
      case 'fire':
        if (behavior === 'nofire') break;
        if (behavior === 'misfire') {
          setTimeout(() => send({ t: 'shot', ts: now(), beta: -80 }), reaction);
          setTimeout(() => { b.beta = 0; send({ t: 'shot', ts: now(), beta: 0 }); }, reaction + 300);
          break;
        }
        setTimeout(() => { b.beta = 0; send({ t: 'shot', ts: now(), beta: 0 }); }, reaction);
        break;
    }
  });
  return b;
}

async function waitFor(fn, timeout = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { if (fn()) return true; } catch (e) { /* state not ready yet */ } await sleep(20); }
  console.log('   (timeout waiting for ' + label + ')');
  return false;
}

// Closed-loop walk in the lobby: hold the direction until the friction stopping distance (v^2/2f, f=14) reaches the
// target, then release. Gives up when a game starts (players inside are frozen).
async function walkTo(disp, b, x, timeout = 12000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    const p = disp.player(b.pid);
    if (!p) { await sleep(30); continue; }
    const dx = x - p.pos.x, v = p.vel.x;
    if (Math.abs(dx) < 0.3 && Math.abs(v) < 0.3) break;
    if (disp.mode() !== 'lobby') break;
    const stop = (v * v) / (2 * 14);
    const dir = Math.sign(dx) !== Math.sign(v) || Math.abs(dx) > stop + 0.1 ? Math.sign(dx) : 0;
    if (dir !== last) { b.send({ t: 'move', dir }); last = dir; }
    await sleep(30);
  }
  b.send({ t: 'move', dir: 0 });
}

function makeChecker(suite) {
  const results = [];
  const check = (name, cond, extra) => { results.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '   ' + extra : '')); };
  const summary = () => {
    const failed = results.filter((r) => !r[1]).length;
    console.log(`\n[${suite}] ${results.length - failed}/${results.length} passed\n`);
    return failed === 0;
  };
  return { check, summary, results };
}

module.exports = { sleep, startServer, display, bot, waitFor, walkTo, makeChecker };
