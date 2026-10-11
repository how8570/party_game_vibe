// Server-side bots so one person can test every game. A bot is a player whose "socket" is a tiny in-memory
// object: messages the server would send to its phone go to the bot's brain, and the brain answers with the
// same messages a phone would send (motion, move, jump, shot, stick, dash) through router.route().
//
// Behaviour: in the lobby a bot follows humans into whichever game zone they stand in (never starts a game
// alone), in Quick Draw it holsters and fires with a human-ish reaction time, in Bumper it hunts the nearest
// opponent and retreats to the centre when it drifts near the edge.
const { GAMES, WORLD, BUMPER } = require('./config');
const { players, game } = require('./state');
const P = require('./players');
const { route } = require('./router');
const games = require('./games');

const NAMES = ['小豆', '阿強', '大熊', '妹妹', '阿肥', '小白', '胖達', '阿呆', '阿瓜', '小黑'];
const bots = [];
let serial = 0;

class FakeSocket {
  constructor(bot) { this.bot = bot; this.OPEN = 1; this.readyState = 1; }
  send(s) { let m; try { m = JSON.parse(s); } catch (e) { return; } this.bot.onMessage(m); }
  close() { this.readyState = 3; }
}

class Bot {
  constructor() {
    this.index = serial++;
    this.pid = `bot_${this.index}`;
    this.screen = { screen: 'lobby' };
    this.beta = 45;                 // simulated phone pitch (Quick Draw)
    this.shotTimer = null;
    this.wanderX = null; this.wanderUntil = 0; this.nextHopAt = 0; this.nextEmojiAt = 0;
    this.reaction = 230 + Math.random() * 220;
    this.ws = new FakeSocket(this);
    this.p = P.join(this.ws, { pid: this.pid, name: NAMES[this.index % NAMES.length] + (this.index >= NAMES.length ? ` ${Math.floor(this.index / NAMES.length) + 1}` : '') });
    this.p.isBot = true;
    this.motionTimer = setInterval(() => route(this.p, { t: 'motion', ts: Date.now(), alpha: 0, beta: this.beta, gamma: 0, ax: 0, ay: 0, az: 0 }), 50);
    this.brainTimer = setInterval(() => this.think(), 100);
  }

  onMessage(m) {
    if (m.t === 'ping') { route(this.p, { t: 'pong', s: m.s, c: Date.now() }); return; }
    if (m.t !== 'game') return;
    this.screen = m;
    clearTimeout(this.shotTimer);
    switch (m.screen) {
      case 'lobby': case 'spectate': this.beta = 45; break;
      case 'intro': case 'holster': route(this.p, { t: 'move', dir: 0 }); this.beta = -80; break;
      case 'fire':
        this.shotTimer = setTimeout(() => { this.beta = 0; route(this.p, { t: 'shot', ts: Date.now(), beta: 0 }); }, this.reaction);
        break;
      case 'bumper': if (m.phase !== 'play' || !m.alive) route(this.p, { t: 'stick', x: 0, y: 0 }); break;
    }
  }

  think() {
    const s = this.screen.screen;
    if (s === 'lobby') this.thinkLobby();
    else if (s === 'bumper') this.thinkBumper();
    else if (s === 'parkour') this.thinkParkour();
  }

  // ---- parkour: run right, jump at gaps and at steps up ----
  thinkParkour() {
    const st = games.byId.parkour.publicState().parkour;
    if (!st || st.phase !== 'play') return;
    const me = st.bodies.find((b) => b.pid === this.pid);
    if (!me || me.finishedAt != null) return;
    const p = this.p;
    if (p.moveDir !== 1) route(p, { t: 'move', dir: 1 });
    if (!me.onGround) return;
    const ahead = me.pos.x + 1.1;
    const under = (x, y) => st.course.platforms.some((pl) => x >= pl.x && x <= pl.x + pl.w && Math.abs(pl.y - y) < 0.05);
    const stepUp = st.course.platforms.some((pl) => pl.x + pl.w > me.pos.x && pl.x < me.pos.x + 2.2 && pl.y > me.pos.y + 0.3 && pl.y <= me.pos.y + 2.6);
    const spikes = (st.course.hazards || []).some((h) => Math.abs(h.y - me.pos.y) < 0.05 && h.x + h.w > me.pos.x && h.x < me.pos.x + 1.4);
    if (!under(ahead, me.pos.y) || stepUp || spikes) route(p, { t: 'jump' });
  }

  // ---- lobby: follow humans into a zone, otherwise stroll ----
  thinkLobby() {
    const p = this.p, now = Date.now();
    const humans = [...players.values()].filter((q) => q.connected && !q.isBot);
    // follow humans into ground-level zones only (bots cannot climb to the tower yet)
    const zoneHuman = humans.find((q) => q.zone && !(GAMES.find((z) => z.id === q.zone) || {}).zone.y);
    let targetX = null;
    if (zoneHuman) {
      const g = GAMES.find((z) => z.id === zoneHuman.zone);
      const humansIn = humans.filter((q) => q.zone === g.id).length;
      const slots = Math.max(0, g.max - humansIn);
      const myRank = bots.filter((b) => b.p.connected).indexOf(this);
      if (myRank < slots) {
        const w = g.zone.x1 - g.zone.x0;
        targetX = g.zone.x0 + w * 0.25 + ((myRank * 0.9) % (w * 0.6)); // spread out inside the zone
      }
    }
    if (targetX == null) {
      // stroll around the middle, hop and chat now and then; step out of any zone we are still standing in
      if (p.zone || this.wanderX == null || now > this.wanderUntil) {
        this.wanderX = 6 + Math.random() * 8; this.wanderUntil = now + 3000 + Math.random() * 5000;
      }
      targetX = this.wanderX;
      if (now > this.nextHopAt) { route(p, { t: 'jump' }); this.nextHopAt = now + 2500 + Math.random() * 5000; }
      if (now > this.nextEmojiAt) { if (Math.random() < 0.3) route(p, { t: 'emoji', e: ['😂', '🔥', '👋', '🎉', '👑'][Math.floor(Math.random() * 5)] }); this.nextEmojiAt = now + 4000 + Math.random() * 6000; }
    }
    // closed-loop walk: hold the direction until the friction stopping distance reaches the target
    const dx = targetX - p.pos.x, v = p.vel.x;
    const stop = (v * v) / (2 * WORLD.FRICTION);
    let dir = 0;
    if (Math.abs(dx) > 0.25) dir = Math.sign(dx) !== Math.sign(v) || Math.abs(dx) > stop + 0.1 ? Math.sign(dx) : 0;
    if (dir !== p.moveDir) route(p, { t: 'move', dir });
  }

  // ---- bumper: hunt the nearest opponent, keep away from the edge, dash when lined up ----
  thinkBumper() {
    const st = games.byId.bumper.publicState().bumper;
    if (!st || st.phase !== 'play') return;
    const me = st.bodies.find((b) => b.pid === this.pid);
    if (!me || !me.alive) return;
    const others = st.bodies.filter((b) => b.alive && b.pid !== this.pid);
    const d = Math.hypot(me.x, me.y);
    let sx = 0, sy = 0;
    if (others.length) {
      const opp = others.reduce((a, b) => (Math.hypot(b.x - me.x, b.y - me.y) < Math.hypot(a.x - me.x, a.y - me.y) ? b : a));
      const ox = opp.x - me.x, oy = opp.y - me.y, od = Math.hypot(ox, oy) || 0.001;
      sx = ox / od; sy = oy / od;
      // near the edge: blend towards the centre, more the further out we are
      const edge = Math.max(0, (d - st.radius * 0.55) / (st.radius * 0.45));
      sx = sx * (1 - edge) + (-me.x / (d || 1)) * edge;
      sy = sy * (1 - edge) + (-me.y / (d || 1)) * edge;
      // dash when close, lined up, not about to fly out ourselves, and the shove would push them outward
      const aligned = (me.face.x * ox + me.face.y * oy) / od;
      const oppOutward = (opp.x * ox + opp.y * oy) / (od * (Math.hypot(opp.x, opp.y) || 1));
      if (me.dashReady && od < 2.6 && aligned > 0.8 && d < st.radius * 0.7 && oppOutward > -0.2 && Math.random() < 0.5) route(this.p, { t: 'dash' });
    } else { sx = -me.x; sy = -me.y; }
    // a little wobble so bots are not perfect
    sx += (Math.random() - 0.5) * 0.3; sy += (Math.random() - 0.5) * 0.3;
    const l = Math.hypot(sx, sy) || 1;
    route(this.p, { t: 'stick', x: sx / l, y: sy / l });
  }

  destroy() {
    clearInterval(this.motionTimer); clearInterval(this.brainTimer); clearTimeout(this.shotTimer);
    P.leave(this.p, this.ws);
    players.delete(this.pid);
  }
}

function addBot() { const b = new Bot(); bots.push(b); return b.p; }
function removeBot() { const b = bots.pop(); if (b) b.destroy(); return !!b; }
function count() { return bots.length; }

module.exports = { addBot, removeBot, count };
