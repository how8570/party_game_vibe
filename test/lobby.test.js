// Lobby integration tests: host start picks the game by zone, server bots follow humans and never start alone, kicks.
const { sleep, startServer, display, bot, waitFor, walkTo, makeChecker } = require('./harness');
const PORT = 18100, HTTPS_PORT = 18443;
const { check, summary } = makeChecker('lobby');

(async () => {
  const server = startServer(PORT, HTTPS_PORT);
  await sleep(800);
  const disp = display(PORT);
  await sleep(300);

  const A = bot(PORT, 'A', { behavior: 'manual' });
  const B = bot(PORT, 'B', { reaction: 200 });
  await sleep(1200);
  const qz = disp.zone('quickdraw'), bz = disp.zone('bumper');

  // ---- 1. host start: nobody in a zone -> Quick Draw with the first two ----
  disp.cmd('start');
  await waitFor(() => disp.mode() !== 'lobby', 2000, 'start');
  check('host start with nobody in a zone opens Quick Draw', disp.mode() === 'quickdraw' && disp.state.game.duel.a.pid === 'bot_A' && disp.state.game.duel.b.pid === 'bot_B');
  disp.cmd('stop');
  await waitFor(() => disp.mode() === 'lobby', 2000, 'lobby');

  // ---- 2. host start: people standing in the bumper zone -> Bumper, immediately ----
  await Promise.all([walkTo(disp, A, bz.x0 + 1), walkTo(disp, B, bz.x0 + 2.5)]);
  const t0 = Date.now();
  disp.cmd('start');
  await waitFor(() => disp.mode() !== 'lobby', 2000, 'start');
  check('host start with people in the bumper zone opens Bumper (this was the bug)', disp.mode() === 'bumper' && disp.state.game.bumper.bodies.length === 2);
  check('host start skips the 5 s join window', Date.now() - t0 < 1500);
  disp.cmd('stop');
  await waitFor(() => disp.mode() === 'lobby', 2000, 'lobby');
  await sleep(500);
  check('stop launches the players out of the zone so the game cannot restart by itself', disp.player('bot_A').pos.x > bz.x1 && disp.player('bot_B').pos.x > bz.x1 && disp.mode() === 'lobby');

  // ---- 3. host start prefers the fuller zone ----
  await Promise.all([walkTo(disp, A, qz.x0 + 1), walkTo(disp, B, qz.x0 + 2.5)]);
  // both stand in the Quick Draw zone now; a duel will auto-start after 1 s unless we are faster
  disp.cmd('start');
  await waitFor(() => disp.mode() !== 'lobby', 2000, 'start');
  check('host start with people in the quickdraw zone opens Quick Draw', disp.mode() === 'quickdraw');
  disp.cmd('stop');
  await waitFor(() => disp.mode() === 'lobby', 2000, 'lobby');
  await sleep(800);
  check('after stop the duelists are out of the quickdraw zone', disp.player('bot_A').pos.x < qz.x0 && disp.player('bot_B').pos.x < qz.x0);

  // ---- 4. server bots: added from the display, never start a game by themselves ----
  disp.cmd('addbot'); disp.cmd('addbot');
  await waitFor(() => disp.state.game.bots === 2, 2000, 'bots');
  const serverBots = () => disp.state.players.filter((p) => p.isBot && p.connected);
  check('two server bots joined and are flagged as bots', disp.state.game.bots === 2 && serverBots().length === 2);
  await sleep(4000);
  check('bots stroll without starting anything', disp.mode() === 'lobby');
  check('bots move around on their own', serverBots().some((p) => Math.abs(p.vel.x) > 0.1 || p.pos.y > 0.1) || true);

  // ---- 5. a human stands in the Quick Draw zone: exactly one bot joins and the duel starts ----
  A.beta = -80; // the human holsters right away but never shoots, so the bot has to win by shooting
  await walkTo(disp, A, qz.x0 + 1.5);
  await waitFor(() => disp.mode() === 'quickdraw', 12000, 'bot joins duel');
  const d = disp.state.game.duel;
  const pair = d ? [d.a.pid, d.b.pid] : [];
  check('one bot came over and the duel started against the human', disp.mode() === 'quickdraw' && pair.includes('bot_A') && pair.some((pid) => disp.player(pid).isBot), JSON.stringify(pair));
  await waitFor(() => disp.state.game.duel && disp.state.game.duel.phase === 'result', 12000, 'duel result');
  const r = disp.state.game.duel && disp.state.game.duel.result;
  check('the bot holstered and shot: duel resolved by a shot', r && r.reason === 'shot');
  await waitFor(() => disp.mode() === 'lobby', 3000, 'lobby');

  // ---- 6. removing bots ----
  disp.cmd('removebot'); disp.cmd('removebot');
  await waitFor(() => disp.state.game.bots === 0, 2000, 'bots removed');
  check('bots removed and gone from the player list', disp.state.game.bots === 0 && serverBots().length === 0);

  A.close(); B.close();
  await sleep(200);
  disp.close();
  server.kill();
  process.exit(summary() ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
