// Lobby playground: 2D platformer physics, game zones, emoji. Runs at 60 Hz on the server; the display only draws.
const { WORLD, GAMES } = require('./config');
const { players, game, bus } = require('./state');
const { send, event } = require('./net');
const { clamp } = require('./players');

// ---------- physics ----------
let lastMoveAt = Date.now();
function moveTick() {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastMoveAt) / 1000);
  lastMoveAt = now;
  for (const p of players.values()) {
    if (!p.connected) continue;
    const frozen = game.participants.has(p.pid); // people inside a running game stand still
    const input = frozen ? 0 : (p.moveDir || 0);
    // horizontal
    if (input) { p.vel.x += input * WORLD.ACCEL * dt; p.facing = input > 0 ? 1 : -1; }
    else { const f = (p.onGround ? WORLD.FRICTION : WORLD.AIR_FRICTION) * dt; p.vel.x = Math.abs(p.vel.x) <= f ? 0 : p.vel.x - Math.sign(p.vel.x) * f; }
    p.vel.x = clamp(p.vel.x, -WORLD.MAX_SPEED, WORLD.MAX_SPEED);
    // buffered jump (pressed slightly before landing) + coyote time (just walked off an edge) + held button = bunny hop on every landing
    const canJump = p.onGround || now - p.lastGroundAt < WORLD.COYOTE_MS;
    const wants = (p.wantJumpAt && now - p.wantJumpAt < WORLD.JUMP_BUFFER_MS) || p.jumpHeld;
    if (wants && canJump && !frozen) {
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

// ---------- game zones: walk into a game's area on the ground to join it ----------
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

// Launch an avatar out of its zone towards the middle of the map so the slot opens up.
function kickOut(p) {
  if (!p) return;
  const g = GAMES.find((z) => p.pos.x >= z.zone.x0 - 0.5 && p.pos.x <= z.zone.x1 + 0.5);
  const toRight = g ? (g.zone.x0 + g.zone.x1) / 2 < WORLD.W / 2 : p.pos.x < WORLD.W / 2;
  p.pos.x = g ? (toRight ? g.zone.x1 + 0.6 : g.zone.x0 - 0.6) : p.pos.x;
  p.pos.y = 0.6; p.onGround = false;
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

module.exports = { wantJump, onJump, onMove, onEmoji, zoneOccupants, kickOut, publicGames, publicWorld };
