// Bumper (碰碰車) integration tests: zone start, steering, elimination, dash shove, ranking, kick-out, disconnect.
const { sleep, startServer, display, bot, waitFor, walkTo, makeChecker } = require('./harness');
const PORT = 18110, HTTPS_PORT = 18453;
const { check, summary } = makeChecker('bumper');

(async () => {
  const server = startServer(PORT, HTTPS_PORT);
  await sleep(800);
  const disp = display(PORT);
  await sleep(300);
  const bumper = () => disp.state && disp.state.game.bumper;
  const body = (pid) => bumper() && bumper().bodies.find((b) => b.pid === pid);

  const A = bot(PORT, 'A', { behavior: 'manual' });
  const B = bot(PORT, 'B', { behavior: 'manual' });
  const C = bot(PORT, 'C', { behavior: 'manual' });
  await sleep(1200);
  const zone = disp.zone('bumper');

  // ---- 1. walking into the zone starts the game after the join window ----
  await Promise.all([walkTo(disp, A, zone.x0 + 1), walkTo(disp, B, zone.x0 + 2), walkTo(disp, C, zone.x0 + 3)]);
  check('three players standing in the bumper zone', disp.state.game.games.find((g) => g.id === 'bumper').occupants.length === 3);
  await waitFor(() => disp.state.game.games.find((g) => g.id === 'bumper').countdown != null, 3000, 'join window');
  check('join window countdown opened once enough people are inside', disp.state.game.games.find((g) => g.id === 'bumper').countdown != null);
  await waitFor(() => disp.mode() === 'bumper', 8000, 'bumper start');
  check('bumper starts with all three', disp.mode() === 'bumper' && bumper().bodies.length === 3);
  check('bodies placed inside the ring', bumper().bodies.every((b) => Math.hypot(b.x, b.y) < bumper().radius));
  check('phones switched to the bumper screen', A.screen === 'bumper' && A.last.phase === 'ready');
  await waitFor(() => bumper() && bumper().phase === 'play', 3000, 'play phase');
  check('ready -> play', bumper().phase === 'play');

  // ---- 2. steering outward drops you out of the ring ----
  const a0 = body('bot_A');
  const out = { x: a0.x / Math.hypot(a0.x, a0.y), y: a0.y / Math.hypot(a0.x, a0.y) };
  const steer = setInterval(() => A.send({ t: 'stick', x: out.x, y: out.y }), 50);
  await waitFor(() => body('bot_A') && !body('bot_A').alive, 6000, 'A out');
  clearInterval(steer);
  check('A steered out of the ring and was eliminated', body('bot_A') && !body('bot_A').alive && disp.outs.includes('bot_A'));
  check("A's phone shows it is out", A.last.screen === 'bumper' && A.last.alive === false);
  check('2 of 3 still alive, game continues', bumper().phase === 'play' && bumper().bodies.filter((b) => b.alive).length === 2);

  // ---- 3. B hunts C (stick towards C, dash when close); C stands still ----
  const hunt = setInterval(() => {
    const me = body('bot_B'), c = body('bot_C');
    if (!me || !c || !me.alive || !c.alive) return;
    const dx = c.x - me.x, dy = c.y - me.y, d = Math.hypot(dx, dy) || 1;
    B.send({ t: 'stick', x: dx / d, y: dy / d });
    if (d < 2.4 && me.dashReady) B.send({ t: 'dash' });
  }, 50);
  await waitFor(() => bumper() && bumper().phase === 'result', 20000, 'B wins');
  clearInterval(hunt);
  const r = bumper() && bumper().result;
  check('collisions and dashes were broadcast to the display', disp.bumps.length > 0 && disp.dashes.includes('bot_B'));
  check('C was shoved out, B is the winner', r && r.winner === 'bot_B' && disp.outs.includes('bot_C'));
  check('ranking is winner, last out, first out', r && JSON.stringify(r.ranking) === JSON.stringify(['bot_B', 'bot_C', 'bot_A']));
  check('champion crown goes to B', disp.state.game.champion === 'bot_B');
  await waitFor(() => B.results.length && C.results.length && A.results.length, 1000, 'phone results');
  check('phones got their placement', B.results.at(-1).outcome === 'win' && C.results.at(-1).rank === 2 && A.results.at(-1).rank === 3 && A.results.at(-1).total === 3);

  // ---- 4. back to the lobby, everyone launched out of the zone ----
  await waitFor(() => disp.mode() === 'lobby', 3000, 'lobby');
  await sleep(1200);
  check('result -> lobby', disp.mode() === 'lobby');
  check('all participants launched out of the zone towards the middle', ['bot_A', 'bot_B', 'bot_C'].every((pid) => disp.player(pid).pos.x > zone.x1));
  check('no game restarts by itself', disp.mode() === 'lobby');

  // ---- 5. host start uses the zone people stand in; a disconnect eliminates; skip ends with no winner ----
  await Promise.all([walkTo(disp, A, zone.x0 + 1), walkTo(disp, B, zone.x0 + 2.5)]);
  disp.cmd('start');
  await waitFor(() => disp.mode() === 'bumper', 2000, 'host start');
  check('host start picks bumper when people stand in its zone (no join window)', disp.mode() === 'bumper' && bumper().bodies.length === 2);
  await waitFor(() => bumper() && bumper().phase === 'play', 3000, 'play');
  A.close();
  await waitFor(() => bumper() && bumper().phase === 'result', 3000, 'A left');
  check('a disconnect eliminates that player and ends the game when one is left', bumper().result && bumper().result.winner === 'bot_B');
  await waitFor(() => disp.mode() === 'lobby', 3000, 'lobby');
  await sleep(300);
  const D = bot(PORT, 'D', { behavior: 'manual' });
  await sleep(1000);
  await Promise.all([walkTo(disp, B, zone.x0 + 1), walkTo(disp, D, zone.x0 + 2.5), walkTo(disp, C, zone.x0 + 3.5)]);
  disp.cmd('start');
  await waitFor(() => bumper() && bumper().phase === 'play', 4000, 'play');
  disp.cmd('skip');
  await waitFor(() => bumper() && bumper().phase === 'result', 2000, 'skip');
  check('skip ends the round with no winner', bumper().result && bumper().result.winner == null);
  disp.cmd('stop');
  await waitFor(() => disp.mode() === 'lobby', 2000, 'stop');
  check('stop returns to the lobby', disp.mode() === 'lobby' && B.screen === 'lobby');

  for (const b of [B, C, D]) b.close();
  await sleep(200);
  disp.close();
  server.kill();
  process.exit(summary() ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
