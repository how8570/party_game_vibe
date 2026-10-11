// Quick Draw bot: a fake phone that follows the duel protocol.
// usage: npm run bot -- <name> [reactionMs=250] [behavior=normal] [port=8080]
// behavior: normal | wander (normal duelist, strolls around the lobby and spams emoji) | falsestart | sleepy (never holsters) | nofire (holsters but never shoots) | misfire (shoots without raising first)
const WebSocket = require('ws');
const name = process.argv[2] || 'Bot';
const reaction = Number(process.argv[3] || 250);
const behavior = process.argv[4] || 'normal';
const port = Number(process.argv[5] || 8080);

const ws = new WebSocket(`ws://localhost:${port}`);
const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
let beta = 45;            // current simulated pitch
let screen = 'lobby';
const log = (...a) => console.log(`[${name}]`, ...a);

const EMOJIS = ['😂', '🔥', '👋', '😱', '🎉', '💩', '❤️', '👑'];
ws.on('open', () => {
  send({ t: 'hello', role: 'controller', pid: 'bot_' + name, name });
  const t0 = Date.now() - Math.random() * 20000; // random phase so several bots don't move in lockstep
  let shakeUntil = 0;
  let dir = 0;
  setInterval(() => {
    let ax = 0, ay = 0, az = 0;
    if (behavior === 'wander' && Date.now() < shakeUntil) { ax = 20; ay = 6; }
    send({ t: 'motion', ts: Date.now(), alpha: 0, beta, gamma: 0, ax, ay, az });
  }, 33);
  if (behavior === 'wander') {
    // stroll: pick a direction, hold it a while, sometimes stop; hop and chat now and then
    const stroll = () => {
      if (screen === 'lobby' || screen === 'spectate') {
        const r = Math.random();
        dir = r < 0.4 ? 1 : r < 0.8 ? -1 : 0;
        send({ t: 'move', dir });
      }
      setTimeout(stroll, 800 + Math.random() * 2200);
    };
    setTimeout(stroll, Math.random() * 1000);
    setInterval(() => { if (screen === 'lobby') send({ t: 'emoji', e: EMOJIS[Math.floor(Math.random() * EMOJIS.length)] }); }, 2500 + Math.random() * 2000);
    setInterval(() => { if (screen === 'lobby') shakeUntil = Date.now() + 100; }, 6000 + Math.random() * 3000);
    setInterval(() => { if (screen === 'lobby') send({ t: 'jump' }); }, 1500 + Math.random() * 2500);
  }
});

ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.t === 'ping') { send({ t: 'pong', s: m.s, c: Date.now() }); return; }
  if (m.t !== 'game') return;
  screen = m.screen;
  log('screen', m.screen, m.outcome || '', m.reason || '', m.myReaction != null ? m.myReaction + 'ms' : '');
  switch (m.screen) {
    case 'lobby': case 'spectate': beta = 45; break;
    case 'intro': case 'holster':
      send({ t: 'move', dir: 0 });
      if (behavior !== 'sleepy') beta = -80;
      break;
    case 'wait':
      if (behavior === 'falsestart') setTimeout(() => { beta = 0; send({ t: 'shot', ts: Date.now(), beta }); }, 150);
      break;
    case 'fire':
      if (behavior === 'nofire') break;
      if (behavior === 'misfire') {
        setTimeout(() => send({ t: 'shot', ts: Date.now(), beta: -80 }), reaction);
        setTimeout(() => { beta = 0; send({ t: 'shot', ts: Date.now(), beta }); }, reaction + 400);
        break;
      }
      setTimeout(() => { beta = 0; send({ t: 'shot', ts: Date.now(), beta }); }, reaction);
      break;
  }
});
ws.on('close', () => { log('closed'); process.exit(0); });
ws.on('error', (e) => { log('error', e.message); process.exit(1); });
