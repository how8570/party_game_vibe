// Quick Draw state-machine tests. Spawns its own server with GAME_FAST timings on separate ports.
// usage: npm test
const { spawn } = require('child_process');
const path = require('path');
const proj = path.join(__dirname, '..');
const WebSocket = require('ws');
const PORT = 18080, HTTPS_PORT = 18443;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, cond, extra) { results.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '   ' + extra : '')); }

// ---- in-process bot ----
function bot(name, { reaction = 250, behavior = 'normal', clockSkew = 0 } = {}) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const now = () => Date.now() + clockSkew;
  const b = { name, ws, beta: 45, screen: 'lobby', screens: [], results: [], misfires: 0, holsterOk: null, zone: null, zones: [] };
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  b.send = send;
  b.close = () => ws.close();
  ws.on('open', () => {
    send({ t: 'hello', role: 'controller', pid: 'bot_' + name, name });
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
    b.screen = m.screen; b.screens.push(m);
    if (m.screen === 'result') b.results.push(m);
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

// ---- display client ----
function display() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const d = { ws, state: null, events: [], fires: 0 };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', role: 'display' })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'state') d.state = m;
    else if (m.t === 'event') d.events.push(m);
    else if (m.t === 'fire') d.fires++;
  });
  d.cmd = (cmd) => ws.send(JSON.stringify({ t: 'cmd', cmd }));
  return d;
}

async function waitFor(fn, timeout = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(20); }
  console.log('   (timeout waiting for ' + label + ')');
  return false;
}

(async () => {
  const server = spawn(process.execPath, [path.join(proj, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HTTPS_PORT: String(HTTPS_PORT), GAME_FAST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await sleep(800);

  const disp = display();
  await sleep(300);
  const duelOf = () => disp.state && disp.state.game.duel;
  const resultOf = () => { const d = duelOf(); return d && d.phase === 'result' ? d.result : null; };

  // ---- 1. basic duel: faster bot wins, reactions plausible ----
  const A = bot('A', { reaction: 120 });
  const B = bot('B', { reaction: 320 });
  await sleep(1200); // clock sync burst
  check('both bots connected and synced', disp.state.players.length === 2 && disp.state.players.every((p) => p.rtt != null));
  disp.cmd('start');
  await waitFor(() => disp.state.game.mode === 'quickdraw', 2000, 'duel mode');
  check('game enters duel mode, round 1', disp.state.game.mode === 'quickdraw' && duelOf().round === 1);
  await waitFor(() => duelOf() && duelOf().phase === 'wait', 3000, 'wait phase');
  check('both holstered -> wait phase', duelOf() && duelOf().phase === 'wait' && duelOf().a.holstered && duelOf().b.holstered);
  check('fireAt hidden during wait', duelOf().fireAt == null);
  await waitFor(() => resultOf(), 4000, 'result');
  let r = resultOf();
  check('faster bot A wins by shot', r && r.winner === 'bot_A' && r.reason === 'shot', JSON.stringify(r && r.reactions));
  await waitFor(() => resultOf() && resultOf().reactions.bot_B != null, 1000, 'late shot recorded');
  r = resultOf();
  check('reaction times plausible (loser\'s late shot recorded too)', r && r.reactions.bot_A >= 100 && r.reactions.bot_A < 260 && r.reactions.bot_B >= 300 && r.reactions.bot_B < 460, JSON.stringify(r && r.reactions));
  check('display received fire event', disp.fires >= 1);
  await waitFor(() => A.results.length >= 1 && B.results.length >= 1, 1000, 'phone results');
  check('phones got win/lose screens', A.results[0] && A.results[0].outcome === 'win' && B.results[0] && B.results[0].outcome === 'lose' && A.results[0].myReaction === r.reactions.bot_A);

  // ---- 2. after the result the game returns to the lobby; the loser is launched out of the zone ----
  await waitFor(() => disp.state.game.mode === 'lobby', 3000, 'back to lobby');
  check('result -> lobby, champion = winner, phones on lobby screen', disp.state.game.mode === 'lobby' && disp.state.game.champion === 'bot_A' && A.screen === 'lobby' && B.screen === 'lobby');
  const posOf = (pid) => disp.state.players.find((p) => p.pid === pid).pos;
  check('loser launched towards the middle of the map', posOf('bot_B').x < 14);

  // ---- 3. zone matchmaking: walk into the Quick Draw zone, duel starts by itself, champion keeps the slot ----
  const C = bot('C', { reaction: 200, behavior: 'falsestart' });
  await sleep(1200);
  const zone = disp.state.game.games.find((g) => g.id === 'quickdraw').zone;
  // Closed-loop walk: hold the direction until the friction stopping distance (v^2 / 2f, f = 14) reaches the target, then release.
  async function walkTo(b, pid, x) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < 12000) {
      const p = disp.state.players.find((q) => q.pid === pid);
      const dx = x - p.pos.x, v = p.vel.x;
      if (Math.abs(dx) < 0.3 && Math.abs(v) < 0.3) break;
      if (duelOf()) break; // a game started (players are frozen inside it); stop steering
      const stop = (v * v) / (2 * 14);
      const dir = Math.sign(dx) !== Math.sign(v) || Math.abs(dx) > stop + 0.1 ? Math.sign(dx) : 0;
      if (dir !== last) { b.send({ t: 'move', dir }); last = dir; }
      if (process.env.DEBUG_WALK && (Date.now() - t0) % 300 < 30) console.log(`   walk ${pid} t=${Date.now() - t0} x=${p.pos.x.toFixed(2)} y=${p.pos.y.toFixed(2)} vx=${v.toFixed(2)} dir=${dir} screen=${b.screen} ground=${p.onGround}`);
      await sleep(30);
    }
    b.send({ t: 'move', dir: 0 });
  }
  await Promise.all([walkTo(A, 'bot_A', zone.x0 + 1.2), walkTo(C, 'bot_C', zone.x0 + 2.6)]);
  await waitFor(() => duelOf(), 4000, 'auto start');
  check('walking into the zone auto-starts a duel (both were inside), champion on side A, challenger on side B', duelOf() && duelOf().a.pid === 'bot_A' && duelOf().b.pid === 'bot_C', JSON.stringify({ a: posOf('bot_A'), c: posOf('bot_C') }));
  check('phones were told they entered the zone', C.zones.includes('quickdraw') && A.zones.includes('quickdraw'));
  await waitFor(() => resultOf(), 8000, 'zone duel result');
  r = resultOf();
  check('C false-starts, A wins', r && r.winner === 'bot_A' && r.loser === 'bot_C' && r.reason === 'falsestart');
  check('C phone told it lost by false start', C.results.at(-1) && C.results.at(-1).outcome === 'lose' && C.results.at(-1).reason === 'falsestart');
  await waitFor(() => disp.state.game.mode === 'lobby', 3000, 'lobby again');
  await sleep(300);
  check('loser kicked out of the zone, champion still inside, no new duel', posOf('bot_C').x < zone.x0 && posOf('bot_A').x >= zone.x0 && !duelOf());
  await walkTo(B, 'bot_B', zone.x0 + 2.8);
  await waitFor(() => duelOf(), 3000, 'next challenger');
  check('next challenger walking in starts a duel against the champion', duelOf() && duelOf().a.pid === 'bot_A' && duelOf().b.pid === 'bot_B');
  disp.cmd('stop');
  C.close();
  await sleep(500);

  // ---- 4. nobody fires -> timeout draw, rematch ----
  const N1 = bot('N1', { behavior: 'nofire' });
  const N2 = bot('N2', { behavior: 'nofire' });
  A.close(); B.close();
  await sleep(1200);
  disp.cmd('reset'); // drop disconnected players so N1/N2 are the only two
  await sleep(200);
  disp.cmd('start');
  await waitFor(() => resultOf(), 8000, 'timeout result');
  r = resultOf();
  check('no shots -> draw by timeout', r && r.winner == null && r.reason === 'timeout');
  check('phones got draw screen', N1.results.at(-1) && N1.results.at(-1).outcome === 'draw');
  disp.cmd('stop'); N1.close(); N2.close();
  await sleep(500);

  // ---- 5. sleepy player never holsters -> holster timeout, other wins ----
  const S = bot('S', { behavior: 'sleepy' });
  const H = bot('H');
  await sleep(1200);
  disp.cmd('reset'); await sleep(200);
  disp.cmd('start');
  await waitFor(() => resultOf(), 8000, 'holster timeout');
  r = resultOf();
  check('holster timeout -> ready player wins', r && r.winner === 'bot_H' && r.reason === 'holster');
  check('holster feedback was pushed to phone', H.holsterOk === true);
  disp.cmd('stop'); S.close(); H.close();
  await sleep(500);

  // ---- 6. misfire (press without raising) is ignored, then a proper shot wins ----
  const M = bot('M', { reaction: 100, behavior: 'misfire' });
  const Q = bot('Q', { behavior: 'nofire' });
  await sleep(1200);
  disp.cmd('reset'); await sleep(200);
  disp.cmd('start');
  await waitFor(() => resultOf(), 8000, 'misfire result');
  r = resultOf();
  check('misfire ignored, later real shot wins', r && r.winner === 'bot_M' && r.reason === 'shot' && M.misfires === 1 && duelOf().a.misfires === 1);
  disp.cmd('stop'); M.close(); Q.close();
  await sleep(500);

  // ---- 7. clock skew: phone clock 5 s ahead still yields a sane reaction ----
  const K = bot('K', { reaction: 150, clockSkew: 5000 });
  const L = bot('L', { reaction: 400 });
  await sleep(1200);
  disp.cmd('reset'); await sleep(200);
  disp.cmd('start');
  await waitFor(() => resultOf(), 8000, 'skew result');
  r = resultOf();
  check('skewed clock corrected, K wins with sane reaction', r && r.winner === 'bot_K' && r.reactions.bot_K >= 100 && r.reactions.bot_K < 300, JSON.stringify(r && r.reactions));
  disp.cmd('stop'); K.close(); L.close();
  await sleep(500);

  // ---- 8. duelist disconnects mid-duel -> other wins ----
  const X = bot('X', { behavior: 'nofire' });
  const Y = bot('Y', { behavior: 'nofire' });
  await sleep(1200);
  disp.cmd('reset'); await sleep(200);
  disp.cmd('start');
  await waitFor(() => duelOf() && duelOf().phase === 'wait', 4000, 'wait');
  X.close();
  await waitFor(() => resultOf(), 2000, 'leave result');
  r = resultOf();
  check('disconnect -> opponent wins by default', r && r.winner === 'bot_Y' && r.reason === 'left');
  await waitFor(() => disp.state.game.mode === 'lobby', 3000, 'back to lobby');
  check('with one player left the game returns to lobby', disp.state.game.mode === 'lobby');
  Y.close();

  await sleep(300);
  disp.ws.close();
  server.kill();
  const failed = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
