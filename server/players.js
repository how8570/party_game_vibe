// Player registry: join/leave, raw sensor classification, phone clock sync.
const { COLORS, INPUT, WORLD } = require('./config');
const { players, game, bus } = require('./state');
const { send, event } = require('./net');

let nextNum = 1;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function newPlayer(pid, name) {
  const num = nextNum++;
  return {
    pid, num, name: name || `P${num}`,
    color: COLORS[(num - 1) % COLORS.length],
    connected: true,
    ws: null,
    wins: 0,
    screen: null,              // last screen pushed to the phone (for dedupe)
    // raw input
    neutral: null,             // { beta, gamma } captured at join / calibrate
    orient: { alpha: 0, beta: 0, gamma: 0 },
    accel: { x: 0, y: 0, z: 0, mag: 0 },
    tilt: { x: 0, y: 0, dir: 'CENTER' },
    buttons: { A: false, B: false },
    gesture: null, gestureAt: 0,
    lastShakeAt: 0,
    lastSeen: Date.now(),
    hz: 0, _samples: 0, _hzWindowStart: Date.now(),
    // clock sync: phoneTime ~= serverTime + offset
    clock: null,
    clockSamples: [],
    // lobby platformer
    pos: { x: WORLD.SPAWN.x0 + Math.random() * (WORLD.SPAWN.x1 - WORLD.SPAWN.x0), y: WORLD.SPAWN.y },
    vel: { x: 0, y: 0 },
    onGround: false, facing: 1, landedAt: 0, jumpedAt: 0, lastGroundAt: 0, wantJumpAt: 0,
    moveDir: 0, zone: null, zoneSince: 0,
    emoji: null, emojiAt: 0, lastEmojiAt: 0,
  };
}

function connectedPlayers() {
  return [...players.values()].filter((p) => p.connected).sort((a, b) => a.num - b.num);
}

// ---------- Clock sync (NTP-style, keep the sample with the lowest RTT) ----------
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

// ---------- Raw sensor classification ----------
function setGesture(p, g) { p.gesture = g; p.gestureAt = Date.now(); }

function classifyMotion(p, m, receivedAt) {
  const now = receivedAt;
  p.lastSeen = now;
  p._samples++;
  if (now - p._hzWindowStart >= 1000) { p.hz = p._samples; p._samples = 0; p._hzWindowStart = now; }

  if (typeof m.beta === 'number' && typeof m.gamma === 'number') {
    p.orient = { alpha: m.alpha || 0, beta: m.beta, gamma: m.gamma };
    if (!p.neutral) p.neutral = { beta: m.beta, gamma: m.gamma };
    const x = clamp((m.gamma - p.neutral.gamma) / INPUT.TILT_RANGE_DEG, -1, 1);
    const y = clamp((p.neutral.beta - m.beta) / INPUT.TILT_RANGE_DEG, -1, 1);
    let dir = 'CENTER';
    if (Math.abs(x) >= INPUT.TILT_DEADZONE || Math.abs(y) >= INPUT.TILT_DEADZONE) {
      dir = Math.abs(x) >= Math.abs(y) ? (x > 0 ? 'RIGHT' : 'LEFT') : (y > 0 ? 'UP' : 'DOWN');
    }
    p.tilt = { x, y, dir };
    bus.emit('motion', p, m, receivedAt);
  }

  if (typeof m.ax === 'number') {
    const mag = Math.hypot(m.ax, m.ay || 0, m.az || 0);
    p.accel = { x: m.ax, y: m.ay || 0, z: m.az || 0, mag };
    if (mag >= INPUT.SHAKE_THRESHOLD && now - p.lastShakeAt > INPUT.SHAKE_COOLDOWN_MS) {
      p.lastShakeAt = now;
      setGesture(p, 'SHAKE');
      event(p, 'shake', `${mag.toFixed(1)} m/s2`);
      bus.emit('shake', p);
    }
  }
}

function onButton(p, m) {
  if (!(m.k in p.buttons)) return;
  p.buttons[m.k] = !!m.down;
  if (m.down) { setGesture(p, `BTN ${m.k}`); event(p, 'button', m.k); }
}

function publicPlayer(p) {
  const now = Date.now();
  return {
    pid: p.pid, num: p.num, name: p.name, color: p.color, connected: p.connected,
    orient: p.orient, accel: p.accel, tilt: p.tilt, buttons: p.buttons, hz: p.hz,
    gesture: now - p.gestureAt < INPUT.GESTURE_SHOW_MS ? p.gesture : null,
    calibrated: !!p.neutral, wins: p.wins,
    rtt: p.clock ? Math.round(p.clock.rtt) : null,
    pos: p.pos, vel: p.vel, onGround: p.onGround, facing: p.facing, landedAt: p.landedAt, jumpedAt: p.jumpedAt,
    emoji: now - p.emojiAt < WORLD.EMOJI_MS ? { e: p.emoji, at: p.emojiAt } : null,
    shakeAt: p.lastShakeAt,
  };
}

// ---------- Join / leave ----------
function join(ws, hello) {
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
  p._pingTimer = setInterval(() => sendPing(p), 4000);
  return p;
}

function leave(p, ws) {
  clearInterval(p._pingTimer);
  if (p.ws !== ws) return false; // an older socket of a player who already reconnected
  p.connected = false; p.ws = null;
  p.buttons = { A: false, B: false };
  p.moveDir = 0;
  event(p, 'leave', p.name);
  console.log(`[leave] #${p.num} ${p.name}`);
  bus.emit('player:leave', p);
  return true;
}

function forgetDisconnected() {
  for (const [pid, p] of players) if (!p.connected) players.delete(pid);
}

module.exports = { newPlayer, connectedPlayers, classifyMotion, onPong, toServerTime, onButton, publicPlayer, join, leave, forgetDisconnected, clamp };
