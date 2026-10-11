// Phone-as-controller party game server.
// - Serves the display page (/) and the controller page (/c)
// - Phones connect over HTTPS/WSS (sensors need a secure context), the PC display over plain HTTP/WS
// - Classifies each phone's raw sensor data (tilt / shake / buttons) for the lobby input viewer
// - Runs the "Quick Draw" duel state machine and broadcasts state to displays at ~30 Hz

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = Number(process.env.HTTPS_PORT || 8443);     // HTTPS: phones
const HTTP_PORT = Number(process.env.PORT || 8080);      // HTTP: PC display
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'certs');
const FAST = !!process.env.GAME_FAST;                    // shorter timings for automated tests

// ---------- LAN address ----------
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}
const lan = lanAddresses();
const HOST = process.env.HOST || (lan[0] ? lan[0].address : 'localhost');
const JOIN_URL = `https://${HOST}:${PORT}/c`;

// ---------- TLS certificate ----------
// Prefer certs/cert.pem + certs/key.pem (e.g. from mkcert). Otherwise generate a
// self-signed cert once and cache it.
function loadOrCreateCert() {
  const certPath = path.join(CERT_DIR, 'cert.pem');
  const keyPath = path.join(CERT_DIR, 'key.pem');
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), source: 'certs/' };
  }
  const selfsigned = require('selfsigned');
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...lan.map((l) => ({ type: 7, ip: l.address })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'motion-demo' }], {
    keySize: 2048, days: 3650, algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath, pems.private);
  return { cert: pems.cert, key: pems.private, source: 'self-signed (generated)' };
}
const tls = loadOrCreateCert();

// ---------- Tunables ----------
const TILT_RANGE_DEG = 40;   // this many degrees of tilt = full deflection (1.0)
const TILT_DEADZONE = 0.25;  // below this normalized magnitude counts as CENTER
const SHAKE_THRESHOLD = 16;  // m/s^2 of linear acceleration (gravity removed)
const SHAKE_COOLDOWN_MS = 600;
const GESTURE_SHOW_MS = 700;

// Quick Draw. beta = pitch: +90 upright (top up), 0 flat, -90 top pointing at the floor.
const QD = {
  INTRO_MS: FAST ? 300 : 3500,
  HOLSTER_BETA: -55,         // phone hanging at your side counts as holstered below this pitch
  RAISED_BETA: -30,          // above this pitch the gun is "drawn"
  HOLSTER_HOLD_MS: FAST ? 100 : 600,
  HOLSTER_TIMEOUT_MS: FAST ? 3000 : 30000,
  WAIT_MIN_MS: FAST ? 300 : 2000,
  WAIT_MAX_MS: FAST ? 800 : 6000,
  FIRE_TIMEOUT_MS: FAST ? 800 : 3000,
  RESOLVE_GRACE_MS: 150,     // after the first shot, wait this long for a possibly-earlier shot from the other phone
  RESULT_MS: FAST ? 400 : 5000,
};

const COLORS = ['#ff5252', '#40c4ff', '#69f0ae', '#ffd740', '#e040fb', '#ff6e40', '#18ffff', '#b2ff59', '#ff80ab', '#8c9eff', '#ccff90', '#ffab40'];

// ---------- Players ----------
const players = new Map(); // pid -> player
let nextNum = 1;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function newPlayer(pid, name) {
  const num = nextNum++;
  return {
    pid, num, name: name || `P${num}`,
    color: COLORS[(num - 1) % COLORS.length],
    connected: true,
    ws: null,
    neutral: null,
    orient: { alpha: 0, beta: 0, gamma: 0 },
    accel: { x: 0, y: 0, z: 0, mag: 0 },
    tilt: { x: 0, y: 0, dir: 'CENTER' },
    buttons: { A: false, B: false },
    gesture: null, gestureAt: 0,
    lastShakeAt: 0,
    lastSeen: Date.now(),
    hz: 0, _samples: 0, _hzWindowStart: Date.now(),
    clock: null,               // { offset, rtt } phoneTime ~= serverTime + offset
    clockSamples: [],
    wins: 0,
    screen: null,              // last screen pushed to the phone (for dedupe)
    // lobby platformer: world units (WORLD.W x WORLD.H), y up, pos = feet position
    pos: { x: 6 + Math.random() * 8, y: 7 },   // drop in from the sky, between the game zones
    vel: { x: 0, y: 0 },
    onGround: false, facing: 1, landedAt: 0, jumpedAt: 0, lastGroundAt: 0, wantJumpAt: 0, zone: null, zoneSince: 0, moveDir: 0,
    emoji: null, emojiAt: 0, lastEmojiAt: 0,
  };
}

// ---------- Lobby playground: 2D platformer. Tilt left/right runs, shake or the jump button jumps ----------
const WORLD = {
  W: 20, H: 9,
  GRAVITY: 30, JUMP: 13, ACCEL: 48, MAX_SPEED: 6.5, FRICTION: 14, AIR_FRICTION: 2,   // max jump height = JUMP^2 / (2*GRAVITY) = 2.8
  COYOTE_MS: 120, JUMP_BUFFER_MS: 150,
  PLATFORMS: [                      // a tower in the middle; the game zones at both ends stay under open sky
    { x: 0, y: 0, w: 20 },          // ground
    { x: 5.4, y: 1.7, w: 2.8 },     // each step is at most ~1.7 units above the one below it
    { x: 11.8, y: 1.7, w: 2.8 },
    { x: 8.6, y: 2.4, w: 2.8 },
    { x: 6.4, y: 4.0, w: 2.4 },
    { x: 11.2, y: 4.0, w: 2.4 },
    { x: 8.8, y: 5.6, w: 2.4 },
  ],
  EMOJI_MS: 2500, EMOJI_RATE_MS: 350,
  KICK: { x: 13, vx: -5, vy: 7 },    // where the loser gets launched after a duel
};

// ---------- Game registry: each game owns a zone on the lobby map. Stand inside with enough people and it starts. ----------
const GAMES = [
  { id: 'quickdraw', name: '快槍手', min: 2, max: 2, zone: { x0: 15.4, x1: 19.6 }, holdMs: 1000, countdownMs: 0 },
  { id: 'bumper', name: '碰碰車', min: 2, max: 8, zone: { x0: 0.4, x1: 4.6 }, holdMs: 1000, countdownMs: 5000, comingSoon: true },
];
const gameById = (id) => GAMES.find((g) => g.id === id);
let lastMoveAt = Date.now();
function moveTick() {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastMoveAt) / 1000);
  lastMoveAt = now;
  for (const p of players.values()) {
    if (!p.connected) continue;
    const dueling = game.mode === 'quickdraw' && isDuelist(p.pid);
    // lobby movement comes from the on-screen buttons (tilt was too hard to control on a real phone)
    const input = dueling ? 0 : (p.moveDir || 0);
    // horizontal
    if (input) { p.vel.x += input * WORLD.ACCEL * dt; p.facing = input > 0 ? 1 : -1; }
    else { const f = (p.onGround ? WORLD.FRICTION : WORLD.AIR_FRICTION) * dt; p.vel.x = Math.abs(p.vel.x) <= f ? 0 : p.vel.x - Math.sign(p.vel.x) * f; }
    p.vel.x = clamp(p.vel.x, -WORLD.MAX_SPEED, WORLD.MAX_SPEED);
    // buffered jump (pressed slightly before landing) + coyote time (just walked off an edge)
    const canJump = p.onGround || now - p.lastGroundAt < WORLD.COYOTE_MS;
    if (p.wantJumpAt && now - p.wantJumpAt < WORLD.JUMP_BUFFER_MS && canJump && !dueling) {
      p.vel.y = WORLD.JUMP; p.onGround = false; p.wantJumpAt = 0; p.jumpedAt = now; p.lastGroundAt = 0;
    }
    // vertical
    const prevY = p.pos.y;
    p.vel.y -= WORLD.GRAVITY * dt;
    p.pos.x = clamp(p.pos.x + p.vel.x * dt, 0.4, WORLD.W - 0.4);
    p.pos.y += p.vel.y * dt;
    // one-way platforms: land only when falling through the top surface
    let landed = false;
    if (p.vel.y <= 0) {
      for (const pl of WORLD.PLATFORMS) {
        if (p.pos.x >= pl.x - 0.3 && p.pos.x <= pl.x + pl.w + 0.3 && prevY >= pl.y - 0.001 && p.pos.y <= pl.y) {
          p.pos.y = pl.y; p.vel.y = 0; landed = true; break;
        }
      }
    }
    if (landed && !p.onGround) p.landedAt = now;
    p.onGround = landed;
    if (landed) p.lastGroundAt = now;
    if (p.pos.y < 0) { p.pos.y = 0; p.vel.y = 0; p.onGround = true; p.lastGroundAt = now; }
  }
  zoneTick(now);
}
setInterval(moveTick, 1000 / 60);
function wantJump(p) { p.wantJumpAt = Date.now(); }

// ---------- Game zones: walk into a game's area on the ground to join it ----------
function zoneOf(p) {
  if (!p.connected || !p.onGround || p.pos.y >= 0.05) return null;
  return GAMES.find((g) => p.pos.x >= g.zone.x0 && p.pos.x <= g.zone.x1) || null;
}
function zoneOccupants(gameId) {
  return [...players.values()].filter((p) => p.zone === gameId && p.zoneSince).sort((a, b) => {
    // champion first, then whoever came in first
    if (a.pid === game.champion) return -1; if (b.pid === game.champion) return 1;
    return a.zoneSince - b.zoneSince;
  });
}
const zoneCountdown = {}; // gameId -> timestamp when the game will start (for games with a join window)
function zoneTick(now) {
  for (const p of players.values()) {
    const g = zoneOf(p);
    const id = g ? g.id : null;
    if (id !== p.zone) {
      p.zone = id; p.zoneSince = id ? now : 0;
      send(p.ws, { t: 'zone', game: id, name: g ? g.name : null, comingSoon: !!(g && g.comingSoon) });
    }
  }
  if (game.mode !== 'lobby') return;
  for (const g of GAMES) {
    if (g.comingSoon) continue;
    const ready = zoneOccupants(g.id).filter((p) => now - p.zoneSince >= g.holdMs);
    if (ready.length < g.min) { delete zoneCountdown[g.id]; continue; }
    if (g.countdownMs) {
      // games that take a crowd: open a short join window once enough people are in, then start with everyone inside
      if (!zoneCountdown[g.id]) zoneCountdown[g.id] = now + g.countdownMs;
      if (now < zoneCountdown[g.id] && ready.length < g.max) continue;
      delete zoneCountdown[g.id];
    }
    startGameById(g.id, ready.slice(0, g.max).map((p) => p.pid));
    return;
  }
}
function startGameById(id, pids) {
  if (id === 'quickdraw') startDuel(pids[0], pids[1]);
}
function publicGames() {
  const now = Date.now();
  return GAMES.map((g) => ({
    id: g.id, name: g.name, min: g.min, max: g.max, zone: g.zone, comingSoon: !!g.comingSoon,
    occupants: zoneOccupants(g.id).map((p) => ({ pid: p.pid, progress: Math.min(1, (now - p.zoneSince) / g.holdMs) })),
    countdown: zoneCountdown[g.id] ? Math.max(0, zoneCountdown[g.id] - now) : null,
  }));
}
function kickOut(p) {
  if (!p) return;
  p.pos.x = WORLD.KICK.x; p.pos.y = 0.6; p.vel.x = WORLD.KICK.vx; p.vel.y = WORLD.KICK.vy; p.onGround = false;
  p.zone = null; p.zoneSince = 0; p.facing = -1;
  send(p.ws, { t: 'zone', game: null, name: null });
}

function onEmoji(p, m) {
  const now = Date.now();
  if (now - p.lastEmojiAt < WORLD.EMOJI_RATE_MS) return;
  const e = String(m.e || '').slice(0, 8);
  if (!e) return;
  p.lastEmojiAt = now; p.emoji = e; p.emojiAt = now;
  event(p, 'emoji', e);
}

function connectedPlayers() {
  return [...players.values()].filter((p) => p.connected).sort((a, b) => a.num - b.num);
}

// ---------- Clock sync (NTP-style, pick the sample with the lowest RTT) ----------
function sendPing(p) { send(p.ws, { t: 'ping', s: Date.now() }); }
function onPong(p, m) {
  const now = Date.now();
  if (typeof m.s !== 'number' || typeof m.c !== 'number') return;
  const rtt = now - m.s;
  if (rtt < 0 || rtt > 2000) return;
  const offset = m.c - (m.s + rtt / 2);
  p.clockSamples.push({ offset, rtt });
  if (p.clockSamples.length > 10) p.clockSamples.shift();
  p.clock = p.clockSamples.reduce((best, s) => (!best || s.rtt < best.rtt ? s : best), null);
}
// Convert a phone timestamp to server time; fall back to arrival time if the sync looks broken.
function toServerTime(p, phoneTs, receivedAt) {
  if (!p.clock || typeof phoneTs !== 'number') return receivedAt - (p.clock ? p.clock.rtt / 2 : 0);
  const est = phoneTs - p.clock.offset;
  if (Math.abs(est - receivedAt) > 400) return receivedAt - p.clock.rtt / 2;
  return est;
}

// ---------- Lobby classification ----------
function classifyMotion(p, m, receivedAt) {
  const now = receivedAt;
  p.lastSeen = now;
  p._samples++;
  if (now - p._hzWindowStart >= 1000) { p.hz = p._samples; p._samples = 0; p._hzWindowStart = now; }

  if (typeof m.beta === 'number' && typeof m.gamma === 'number') {
    p.orient = { alpha: m.alpha || 0, beta: m.beta, gamma: m.gamma };
    if (!p.neutral) p.neutral = { beta: m.beta, gamma: m.gamma };
    const x = clamp((m.gamma - p.neutral.gamma) / TILT_RANGE_DEG, -1, 1);
    const y = clamp((p.neutral.beta - m.beta) / TILT_RANGE_DEG, -1, 1);
    let dir = 'CENTER';
    if (Math.abs(x) >= TILT_DEADZONE || Math.abs(y) >= TILT_DEADZONE) {
      dir = Math.abs(x) >= Math.abs(y) ? (x > 0 ? 'RIGHT' : 'LEFT') : (y > 0 ? 'UP' : 'DOWN');
    }
    p.tilt = { x, y, dir };
    duelOnMotion(p, m, receivedAt);
  }

  if (typeof m.ax === 'number') {
    const mag = Math.hypot(m.ax, m.ay || 0, m.az || 0);
    p.accel = { x: m.ax, y: m.ay || 0, z: m.az || 0, mag };
    if (mag >= SHAKE_THRESHOLD && now - p.lastShakeAt > SHAKE_COOLDOWN_MS) {
      p.lastShakeAt = now;
      setGesture(p, 'SHAKE');
      wantJump(p);
      if (game.mode === 'lobby') send(p.ws, { t: 'haptic', ms: 80 });
      event(p, 'shake', `${mag.toFixed(1)} m/s2`);
    }
  }
}
function setGesture(p, g) { p.gesture = g; p.gestureAt = Date.now(); }

function publicPlayer(p) {
  const now = Date.now();
  return {
    pid: p.pid, num: p.num, name: p.name, color: p.color, connected: p.connected,
    orient: p.orient, accel: p.accel, tilt: p.tilt, buttons: p.buttons, hz: p.hz,
    gesture: now - p.gestureAt < GESTURE_SHOW_MS ? p.gesture : null,
    calibrated: !!p.neutral, wins: p.wins,
    rtt: p.clock ? Math.round(p.clock.rtt) : null,
    pos: p.pos, vel: p.vel, onGround: p.onGround, facing: p.facing, landedAt: p.landedAt, jumpedAt: p.jumpedAt,
    emoji: now - p.emojiAt < WORLD.EMOJI_MS ? { e: p.emoji, at: p.emojiAt } : null,
    shakeAt: p.lastShakeAt,
  };
}

// ---------- Quick Draw state machine ----------
const game = {
  mode: 'lobby',     // 'lobby' | 'duel'
  duel: null,
  champion: null,    // pid wearing the crown (last winner)
  message: '',       // one-line status for the display
  round: 0,
};

function randBetween(a, b) { return a + Math.random() * (b - a); }

// Host pressed start: use whoever is standing in the Quick Draw zone, otherwise the first two connected players.
function startGame() {
  const zone = zoneOccupants('quickdraw');
  const ps = zone.length >= 2 ? zone : connectedPlayers();
  if (ps.length < 2) { game.message = '需要至少兩位玩家'; return false; }
  const a = ps.find((p) => p.pid === game.champion) || ps[0];
  const b = ps.find((p) => p !== a);
  startDuel(a.pid, b.pid);
  return true;
}

function startDuel(a, b) {
  if (game.mode !== 'lobby') return;
  game.mode = 'quickdraw';
  game.message = '';
  beginDuel(a, b);
}

function stopGame() {
  game.mode = 'lobby';
  game.duel = null;
  game.message = '';
  pushPhoneScreens();
  broadcastDisplays({ t: 'event', kind: 'game', detail: '回到大廳' });
}

// Result shown long enough: back to the lobby. The loser gets launched out of the zone so the champion's slot opens up.
function endDuel() {
  const d = game.duel;
  if (d && d.result) {
    if (d.result.loser) kickOut(players.get(d.result.loser));
    else if (!d.result.winner) { kickOut(players.get(d.b)); } // draw: challenger steps out, try again
  }
  game.mode = 'lobby';
  game.duel = null;
  pushPhoneScreens();
}

function beginDuel(a, b) {
  game.round++;
  game.duel = {
    a, b, round: game.round,
    phase: 'intro', phaseAt: Date.now(),
    fireAt: null,
    holster: { [a]: { since: null, ok: false }, [b]: { since: null, ok: false } },
    shots: {},           // pid -> reaction ms (server time - fireAt)
    misfires: {},        // pid -> count
    resolveAt: null,
    result: null,
  };
  game.message = '';
  event(players.get(a), 'duel', `第 ${game.round} 回合：${players.get(a).name} vs ${players.get(b).name}`);
  pushPhoneScreens();
}

function setPhase(phase) {
  const d = game.duel;
  d.phase = phase; d.phaseAt = Date.now();
  if (phase === 'fire') {
    d.fireAt = d.phaseAt;
    broadcastDisplays({ t: 'fire', at: d.fireAt });
  }
  pushPhoneScreens();
}

function otherDuelist(pid) { const d = game.duel; return pid === d.a ? d.b : d.a; }
function isDuelist(pid) { const d = game.duel; return !!d && (pid === d.a || pid === d.b); }

function finishDuel(result) {
  const d = game.duel;
  if (!d || d.phase === 'result') return;
  d.result = result;
  if (result.winner) {
    const w = players.get(result.winner);
    w.wins++;
    game.champion = result.winner;
    event(w, 'duel', `${w.name} 獲勝（${REASON_TEXT[result.reason] || result.reason}）`);
  } else {
    event(players.get(d.a), 'duel', `平手（${REASON_TEXT[result.reason] || result.reason}）`);
  }
  setPhase('result');
}
const REASON_TEXT = { shot: '先開槍', falsestart: '對手搶跑', timeout: '沒人開槍', left: '對手離線', holster: '沒就位' };

function duelOnMotion(p, m, receivedAt) {
  const d = game.duel;
  if (game.mode !== 'quickdraw' || !d || !isDuelist(p.pid)) return;
  const beta = m.beta;
  if (d.phase === 'intro' || d.phase === 'holster') {
    const h = d.holster[p.pid];
    if (beta < QD.HOLSTER_BETA) {
      if (h.since == null) h.since = receivedAt;
      const ok = receivedAt - h.since >= QD.HOLSTER_HOLD_MS;
      if (ok !== h.ok) { h.ok = ok; send(p.ws, { t: 'holster', ok }); }
    } else {
      h.since = null;
      if (h.ok) { h.ok = false; send(p.ws, { t: 'holster', ok: false }); }
    }
  } else if (d.phase === 'wait') {
    if (beta > QD.RAISED_BETA) {
      finishDuel({ winner: otherDuelist(p.pid), loser: p.pid, reason: 'falsestart', by: 'raise' });
    }
  }
}

function duelOnShot(p, m, receivedAt) {
  const d = game.duel;
  if (game.mode !== 'quickdraw' || !d || !isDuelist(p.pid)) return;
  const ts = toServerTime(p, m.ts, receivedAt);
  if (d.phase === 'wait' || d.phase === 'holster') {
    finishDuel({ winner: otherDuelist(p.pid), loser: p.pid, reason: 'falsestart', by: 'press' });
    return;
  }
  if (d.phase === 'result') {
    // Late shot after the duel was decided: record it so the loser's reaction time shows too.
    if (d.result && d.result.reason === 'shot' && d.shots[p.pid] == null && ts >= d.fireAt) {
      const beta = typeof m.beta === 'number' ? m.beta : p.orient.beta;
      if (beta >= QD.RAISED_BETA) {
        d.shots[p.pid] = Math.max(0, Math.round(ts - d.fireAt));
        d.result.reactions = { [d.a]: d.shots[d.a], [d.b]: d.shots[d.b] };
        pushPhoneScreens();
      }
    }
    return;
  }
  if (d.phase !== 'fire') return;
  if (ts < d.fireAt) {
    finishDuel({ winner: otherDuelist(p.pid), loser: p.pid, reason: 'falsestart', by: 'press' });
    return;
  }
  const beta = typeof m.beta === 'number' ? m.beta : p.orient.beta;
  if (beta < QD.RAISED_BETA) {
    d.misfires[p.pid] = (d.misfires[p.pid] || 0) + 1;
    send(p.ws, { t: 'misfire' });
    return;
  }
  if (d.shots[p.pid] != null) return; // already shot
  d.shots[p.pid] = Math.max(0, Math.round(ts - d.fireAt));
  if (!d.resolveAt) d.resolveAt = receivedAt + QD.RESOLVE_GRACE_MS;
  if (d.shots[d.a] != null && d.shots[d.b] != null) resolveShots();
}

function resolveShots() {
  const d = game.duel;
  const ra = d.shots[d.a], rb = d.shots[d.b];
  let winner, loser;
  if (ra != null && (rb == null || ra <= rb)) { winner = d.a; loser = d.b; } else { winner = d.b; loser = d.a; }
  finishDuel({ winner, loser, reason: 'shot', reactions: { [d.a]: ra, [d.b]: rb } });
}

function duelOnLeave(p) {
  const d = game.duel;
  if (game.mode !== 'quickdraw' || !d) return;
  if (isDuelist(p.pid) && d.phase !== 'result') {
    finishDuel({ winner: otherDuelist(p.pid), loser: null, reason: 'left' });
  }
}

function duelTick() {
  const d = game.duel;
  if (game.mode !== 'quickdraw' || !d) return;
  const now = Date.now();
  const elapsed = now - d.phaseAt;
  switch (d.phase) {
    case 'intro':
      if (elapsed >= QD.INTRO_MS) setPhase('holster');
      break;
    case 'holster':
      if (d.holster[d.a].ok && d.holster[d.b].ok) {
        setPhase('wait');
        d.fireAt = now + randBetween(QD.WAIT_MIN_MS, QD.WAIT_MAX_MS);
      } else if (elapsed >= QD.HOLSTER_TIMEOUT_MS) {
        const okA = d.holster[d.a].ok, okB = d.holster[d.b].ok;
        if (okA !== okB) finishDuel({ winner: okA ? d.a : d.b, loser: okA ? d.b : d.a, reason: 'holster' });
        else finishDuel({ winner: null, loser: null, reason: 'holster' });
      }
      break;
    case 'wait':
      if (now >= d.fireAt) setPhase('fire');
      break;
    case 'fire':
      if (d.resolveAt && now >= d.resolveAt) resolveShots();
      else if (elapsed >= QD.FIRE_TIMEOUT_MS) finishDuel({ winner: null, loser: null, reason: 'timeout' });
      break;
    case 'result':
      if (elapsed >= QD.RESULT_MS) endDuel();
      break;
  }
}
setInterval(duelTick, 25);

function publicDuel() {
  const d = game.duel;
  if (!d) return null;
  const pub = (pid) => { const p = players.get(pid); return { pid, num: p.num, name: p.name, color: p.color, wins: p.wins, connected: p.connected, holstered: d.holster[pid].ok, reaction: d.shots[pid] != null ? d.shots[pid] : null, misfires: d.misfires[pid] || 0 }; };
  return {
    round: d.round, phase: d.phase, phaseAt: d.phaseAt,
    // never leak fireAt before it happens
    fireAt: d.phase === 'fire' || d.phase === 'result' ? d.fireAt : null,
    a: pub(d.a), b: pub(d.b),
    result: d.result,
    phaseMs: { intro: QD.INTRO_MS, result: QD.RESULT_MS, fireTimeout: QD.FIRE_TIMEOUT_MS },
  };
}

// What each phone should show right now.
function phoneScreen(p) {
  if (game.mode !== 'quickdraw' || !game.duel) return { screen: 'lobby' };
  const d = game.duel;
  if (!isDuelist(p.pid)) {
    return { screen: 'spectate', game: '快槍手', a: players.get(d.a).name, b: players.get(d.b).name, phase: d.phase };
  }
  const opp = players.get(otherDuelist(p.pid));
  const base = { opponent: opp.name, opponentColor: opp.color, round: d.round };
  switch (d.phase) {
    case 'intro': return { screen: 'intro', ...base };
    case 'holster': return { screen: 'holster', ...base, ok: d.holster[p.pid].ok };
    case 'wait': return { screen: 'wait', ...base };
    case 'fire': return { screen: 'fire', ...base };
    case 'result': {
      const r = d.result;
      const outcome = !r.winner ? 'draw' : r.winner === p.pid ? 'win' : 'lose';
      return { screen: 'result', ...base, outcome, reason: r.reason, by: r.by || null, myReaction: d.shots[p.pid] != null ? d.shots[p.pid] : null, theirReaction: d.shots[opp.pid] != null ? d.shots[opp.pid] : null, wins: p.wins };
    }
  }
  return { screen: 'lobby' };
}

function pushPhoneScreens() {
  for (const p of players.values()) {
    if (!p.connected) continue;
    const s = phoneScreen(p);
    const key = JSON.stringify(s);
    if (p.screen === key) continue;
    p.screen = key;
    send(p.ws, { t: 'game', ...s });
  }
}

// ---------- WebSocket ----------
const displays = new Set();

function send(ws, obj) { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function broadcastDisplays(obj) {
  const s = JSON.stringify(obj);
  for (const d of displays) if (d.readyState === d.OPEN) d.send(s);
}
function event(p, kind, detail) {
  broadcastDisplays({ t: 'event', pid: p ? p.pid : null, num: p ? p.num : null, kind, detail: detail || '' });
}

function snapshot() {
  return {
    t: 'state',
    joinUrl: JOIN_URL,
    world: { w: WORLD.W, h: WORLD.H, platforms: WORLD.PLATFORMS },
    players: [...players.values()].sort((a, b) => a.num - b.num).map(publicPlayer),
    game: {
      mode: game.mode, round: game.round, message: game.message,
      champion: game.champion,
      games: publicGames(),
      duel: publicDuel(),
    },
  };
}
setInterval(() => { if (displays.size) broadcastDisplays(snapshot()); }, 1000 / 30);

function handleController(ws, hello) {
  const pid = (typeof hello.pid === 'string' && hello.pid.slice(0, 40)) || `p_${Math.random().toString(36).slice(2, 10)}`;
  let p = players.get(pid);
  if (!p) { p = newPlayer(pid, String(hello.name || '').slice(0, 16)); players.set(pid, p); }
  else { p.connected = true; if (hello.name) p.name = String(hello.name).slice(0, 16); }
  if (p.ws && p.ws !== ws) { try { p.ws.close(); } catch (e) { /* ignore */ } }
  p.ws = ws;
  p.neutral = null;
  p.screen = null;
  p.clockSamples = []; p.clock = null;
  send(ws, { t: 'welcome', pid: p.pid, num: p.num, name: p.name, color: p.color });
  event(p, 'join', p.name);
  console.log(`[join] #${p.num} ${p.name} (${pid})`);

  // clock sync burst, then a slow trickle
  for (let i = 0; i < 6; i++) setTimeout(() => sendPing(p), 150 * i);
  const pingTimer = setInterval(() => sendPing(p), 4000);

  send(ws, { t: 'game', ...phoneScreen(p) });
  p.screen = JSON.stringify(phoneScreen(p));

  ws.on('message', (raw) => {
    const receivedAt = Date.now();
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    switch (m.t) {
      case 'motion': classifyMotion(p, m, receivedAt); break;
      case 'pong': onPong(p, m); break;
      case 'shot': duelOnShot(p, m, receivedAt); break;
      case 'emoji': onEmoji(p, m); break;
      case 'jump': wantJump(p); break;
      case 'move': p.moveDir = clamp(Math.round(Number(m.dir) || 0), -1, 1); break;
      case 'btn': {
        if (m.k in p.buttons) {
          p.buttons[m.k] = !!m.down;
          if (m.down) { setGesture(p, `BTN ${m.k}`); event(p, 'button', m.k); }
        }
        break;
      }
      case 'calib': p.neutral = null; event(p, 'calibrate'); break;
      case 'name': p.name = String(m.name || '').slice(0, 16) || p.name; break;
    }
  });
  ws.on('close', () => {
    clearInterval(pingTimer);
    if (p.ws !== ws) return;
    p.connected = false; p.ws = null;
    p.buttons = { A: false, B: false };
    p.moveDir = 0;
    event(p, 'leave', p.name);
    console.log(`[leave] #${p.num} ${p.name}`);
    duelOnLeave(p);
    pushPhoneScreens();
  });
}

function handleDisplay(ws) {
  displays.add(ws);
  send(ws, snapshot());
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t !== 'cmd') return;
    switch (m.cmd) {
      case 'start': if (game.mode === 'lobby') startGame(); break;
      case 'stop': if (game.mode === 'quickdraw') stopGame(); break;
      case 'skip': if (game.mode === 'quickdraw' && game.duel && game.duel.phase !== 'result') finishDuel({ winner: null, loser: null, reason: 'timeout' }); break;
      case 'reset': {
        // forget players that are no longer connected
        for (const [pid, p] of players) if (!p.connected) players.delete(pid);
        break;
      }
    }
  });
  ws.on('close', () => displays.delete(ws));
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const isLocalHost = (h) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h || '');

async function handleRequest(req, res, secure) {
  const url = new URL(req.url, `${secure ? 'https' : 'http'}://${req.headers.host || 'localhost'}`);
  let file = null;
  if (url.pathname === '/') file = 'display.html';
  else if (url.pathname === '/c' || url.pathname === '/c/') {
    // Sensors need a secure context. http://localhost counts as one (handy for testing on the PC);
    // anything else over plain http gets redirected to the https join URL.
    if (!secure && !isLocalHost(req.headers.host)) { res.writeHead(302, { Location: JOIN_URL }); return res.end(); }
    file = 'controller.html';
  } else if (url.pathname === '/qr.svg') {
    const svg = await QRCode.toString(JOIN_URL, { type: 'svg', margin: 1, width: 256 });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    return res.end(svg);
  } else if (url.pathname === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ joinUrl: JOIN_URL, host: HOST, port: PORT, httpPort: HTTP_PORT }));
  } else file = url.pathname.replace(/^\/+/, '');

  const abs = path.join(PUBLIC_DIR, file);
  if (!abs.startsWith(PUBLIC_DIR) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(abs).pipe(res);
}

const httpsServer = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => handleRequest(req, res, true));
const httpServer = http.createServer((req, res) => handleRequest(req, res, false));

function onConnection(ws) {
  ws.once('message', (raw) => {
    let hello; try { hello = JSON.parse(raw); } catch (e) { return ws.close(); }
    if (hello.t !== 'hello') return ws.close();
    if (hello.role === 'controller') handleController(ws, hello);
    else if (hello.role === 'display') handleDisplay(ws);
    else ws.close();
  });
}
new WebSocketServer({ server: httpsServer }).on('connection', onConnection);
new WebSocketServer({ server: httpServer }).on('connection', onConnection);

httpServer.listen(HTTP_PORT, '0.0.0.0');
httpsServer.listen(PORT, '0.0.0.0', async () => {
  console.log('');
  console.log(`  Display (open on this PC):  http://localhost:${HTTP_PORT}/`);
  console.log(`  Controller (open on phone): ${JOIN_URL}`);
  if (lan.length > 1) {
    console.log(`  Other interfaces: ${lan.map((l) => `${l.name}=${l.address}`).join(', ')}  (override with HOST=...)`);
  }
  console.log(`  TLS cert: ${tls.source}${FAST ? '   [GAME_FAST timings]' : ''}`);
  console.log('');
  console.log(await QRCode.toString(JOIN_URL, { type: 'terminal', small: true }));
});
