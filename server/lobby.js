// Lobby playground: 2D platformer physics, game zones, emoji. Runs at 60 Hz on the server; the display only draws.
// The physics step (stepBody) is shared with other platformer games (parkour).
const { WORLD, GAMES } = require('./config');
const { players, game, bus } = require('./state');
const { send, event } = require('./net');
const { clamp } = require('./players');

// ---------- physics ----------
// body: { pos, vel, onGround, facing, landedAt, jumpedAt, lastGroundAt, wantJumpAt }
// input: { dir: -1|0|1, jumpHeld, allowJump }
// level: { w, platforms: [{x, y, w}], floor: true|false (implicit ground at y=0?) }
function stepBody(b, input, level, dt, now) {
  const dir = input.dir || 0;
  if (dir) { b.vel.x += dir * WORLD.ACCEL * dt; b.facing = dir > 0 ? 1 : -1; }
  else { const f = (b.onGround ? WORLD.FRICTION : WORLD.AIR_FRICTION) * dt; b.vel.x = Math.abs(b.vel.x) <= f ? 0 : b.vel.x - Math.sign(b.vel.x) * f; }
  b.vel.x = clamp(b.vel.x, -WORLD.MAX_SPEED, WORLD.MAX_SPEED);
  // buffered jump (pressed slightly before landing) + coyote time (just walked off an edge) + held button = bunny hop on every landing
  const canJump = b.onGround || now - b.lastGroundAt < WORLD.COYOTE_MS;
  const wants = (b.wantJumpAt && now - b.wantJumpAt < WORLD.JUMP_BUFFER_MS) || input.jumpHeld;
  if (wants && canJump && input.allowJump !== false) {
    b.vel.y = WORLD.JUMP; b.onGround = false; b.wantJumpAt = 0; b.jumpedAt = now; b.lastGroundAt = 0;
  }
  const prevY = b.pos.y;
  b.vel.y -= WORLD.GRAVITY * dt;
  b.pos.x = clamp(b.pos.x + b.vel.x * dt, 0.4, level.w - 0.4);
  b.pos.y += b.vel.y * dt;
  // one-way platforms: land only when falling through the top surface
  let landed = false;
  if (b.vel.y <= 0) {
    for (const pl of level.platforms) {
      if (b.pos.x >= pl.x - 0.3 && b.pos.x <= pl.x + pl.w + 0.3 && prevY >= pl.y - 0.001 && b.pos.y <= pl.y) {
        b.pos.y = pl.y; b.vel.y = 0; landed = true; break;
      }
    }
  }
  if (landed && !b.onGround) b.landedAt = now;
  b.onGround = landed;
  if (landed) b.lastGroundAt = now;
  if (level.floor !== false && b.pos.y < 0) { b.pos.y = 0; b.vel.y = 0; b.onGround = true; b.lastGroundAt = now; }
  return landed;
}

const LOBBY_LEVEL = { w: WORLD.W, platforms: WORLD.PLATFORMS, floor: true };
let lastMoveAt = Date.now();
function moveTick() {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastMoveAt) / 1000);
  lastMoveAt = now;
  for (const p of players.values()) {
    if (!p.connected) continue;
    const frozen = game.participants.has(p.pid); // people inside a running game stand still in the lobby
    stepBody(p, { dir: frozen ? 0 : (p.moveDir || 0), jumpHeld: !frozen && p.jumpHeld, allowJump: !frozen }, LOBBY_LEVEL, dt, now);
  }
  zoneTick(now);
}
setInterval(moveTick, 1000 / 60);

// ---------- phone inputs ----------
function wantJump(p) { p.wantJumpAt = Date.now(); }
// {t:'jump'} = tap, {t:'jump', down:true} = pressed and held, {t:'jump', down:false} = released
function onJump(p, m) {
  if (m.down === false) { p.jumpHeld = false; return; }
  p.wantJumpAt = Date.now();
  p.jumpHeld = m.down === true;
}
function onMove(p, m) { p.moveDir = clamp(Math.round(Number(m.dir) || 0), -1, 1); }
function onEmoji(p, m) {
  const now = Date.now();
  if (now - p.lastEmojiAt < WORLD.EMOJI_RATE_MS) return;
  const e = String(m.e || '').slice(0, 8);
  if (!e) return;
  p.lastEmojiAt = now; p.emoji = e; p.emojiAt = now;
  event(p, 'emoji', e);
}
bus.on('shake', (p) => {
  wantJump(p);
  if (game.mode === 'lobby') send(p.ws, { t: 'haptic', ms: 80 });
});

// ---------- game zones: stand on a game's patch of floor (ground, or a platform when zone.y is set) to join it ----------
function zoneOf(p) {
  if (!p.connected || !p.onGround) return null;
  return GAMES.find((g) => Math.abs(p.pos.y - (g.zone.y || 0)) < 0.05 && p.pos.x >= g.zone.x0 && p.pos.x <= g.zone.x1) || null;
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
    // bots never start a game among themselves
    if (ready.length < g.min || !ready.some((p) => !p.isBot)) { delete zoneCountdown[g.id]; continue; }
    if (g.countdownMs) {
      // games that take a crowd: open a short join window once enough people are in, then start with everyone inside
      if (!zoneCountdown[g.id]) zoneCountdown[g.id] = now + g.countdownMs;
      if (now < zoneCountdown[g.id] && ready.length < g.max) continue;
      delete zoneCountdown[g.id];
    }
    bus.emit('zone:ready', g.id, ready.slice(0, g.max).map((p) => p.pid));
    return;
  }
}

// Launch an avatar out of its zone so the slot opens up: towards the middle of the map, or off the side of a raised zone.
function kickOut(p) {
  if (!p) return;
  const g = GAMES.find((z) => Math.abs(p.pos.y - (z.zone.y || 0)) < 0.6 && p.pos.x >= z.zone.x0 - 0.5 && p.pos.x <= z.zone.x1 + 0.5);
  const center = g ? (g.zone.x0 + g.zone.x1) / 2 : p.pos.x;
  const toRight = Math.abs(center - WORLD.W / 2) < 1 ? Math.random() < 0.5 : center < WORLD.W / 2;
  if (g) p.pos.x = toRight ? g.zone.x1 + 0.6 : g.zone.x0 - 0.6;
  p.pos.y = (g ? g.zone.y || 0 : 0) + 0.6; p.onGround = false;
  p.vel.x = toRight ? WORLD.KICK.speed : -WORLD.KICK.speed; p.vel.y = WORLD.KICK.vy;
  p.zone = null; p.zoneSince = 0; p.facing = toRight ? 1 : -1;
  send(p.ws, { t: 'zone', game: null, name: null });
}
bus.on('player:kick', (pid) => kickOut(players.get(pid)));

function publicGames() {
  const now = Date.now();
  return GAMES.map((g) => ({
    id: g.id, name: g.name, min: g.min, max: g.max, zone: g.zone, comingSoon: !!g.comingSoon,
    occupants: zoneOccupants(g.id).map((p) => ({ pid: p.pid, progress: Math.min(1, (now - p.zoneSince) / g.holdMs) })),
    countdown: zoneCountdown[g.id] ? Math.max(0, zoneCountdown[g.id] - now) : null,
  }));
}

function publicWorld() { return { w: WORLD.W, h: WORLD.H, platforms: WORLD.PLATFORMS }; }

module.exports = { stepBody, wantJump, onJump, onMove, onEmoji, zoneOccupants, kickOut, publicGames, publicWorld };
