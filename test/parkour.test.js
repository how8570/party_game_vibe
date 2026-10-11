// Parkour (跑酷) integration tests: host start, running/jumping through the course, pits and checkpoints, finish,
// ranking, kick-out, and the server bot's course heuristic.
const { sleep, startServer, display, bot, waitFor, makeChecker } = require('./harness');
const PORT = 18120, HTTPS_PORT = 18463;
const { check, summary } = makeChecker('parkour');

(async () => {
  const server = startServer(PORT, HTTPS_PORT);
  await sleep(800);
  const disp = display(PORT);
  await sleep(300);
  const pk = () => disp.state && disp.state.game.parkour;
  const body = (pid) => pk() && pk().bodies.find((b) => b.pid === pid);
  const events = [];
  disp.ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t && m.t.startsWith('parkour:')) events.push(m); });

  const A = bot(PORT, 'A', { behavior: 'manual' });
  const B = bot(PORT, 'B', { behavior: 'manual' });
  await sleep(1200);

  // ---- 1. host start with nobody on the tower: everyone connected runs ----
  disp.cmd = (cmd, extra) => disp.ws.send(JSON.stringify({ t: 'cmd', cmd, ...extra }));
  disp.cmd('start', { game: 'parkour' });
  await waitFor(() => disp.mode() === 'parkour', 2000, 'parkour start');
  check('host start (parkour) puts every connected player on the course', disp.mode() === 'parkour' && pk().bodies.length === 2);
  check('runners start at the start line on the ground', pk().bodies.every((b) => b.pos.x < 5 && b.pos.y === 0));
  check('phones show the parkour screen with the countdown', A.screen === 'parkour' && A.last.phase === 'ready');
  await waitFor(() => pk() && pk().phase === 'play', 3000, 'play');
  check('ready -> play, clock running', pk().phase === 'play');

  // ---- 2. B walks straight into the first pit: falls, respawns at the start ----
  B.send({ t: 'move', dir: 1 });
  await waitFor(() => body('bot_B') && body('bot_B').falls >= 1, 8000, 'B falls');
  B.send({ t: 'move', dir: 0 });
  const bb = body('bot_B');
  check('walking off the first ledge counts as a fall and respawns at the start checkpoint', bb && bb.falls >= 1 && bb.pos.x < 5 && events.some((e) => e.t === 'parkour:fall' && e.pid === 'bot_B'));

  // ---- 3. A runs the course with a simple jump heuristic (the same idea the server bot uses) ----
  const course = pk().course;
  const under = (x, y) => course.platforms.some((pl) => x >= pl.x && x <= pl.x + pl.w && Math.abs(pl.y - y) < 0.05);
  A.send({ t: 'move', dir: 1 });
  const runner = setInterval(() => {
    const me = body('bot_A');
    if (!me || me.finishedAt != null || !me.onGround) return;
    const stepUp = course.platforms.some((pl) => pl.x + pl.w > me.pos.x && pl.x < me.pos.x + 2.2 && pl.y > me.pos.y + 0.3 && pl.y <= me.pos.y + 2.6);
    const spikes = (course.hazards || []).some((h) => Math.abs(h.y - me.pos.y) < 0.05 && h.x + h.w > me.pos.x && h.x < me.pos.x + 1.4);
    if (!under(me.pos.x + 1.1, me.pos.y) || stepUp || spikes) A.send({ t: 'jump' });
  }, 40);
  await waitFor(() => body('bot_A') && body('bot_A').checkpoint >= 1, 20000, 'checkpoint 1');
  check('A reached the first checkpoint', body('bot_A').checkpoint >= 1 && events.some((e) => e.t === 'parkour:checkpoint' && e.pid === 'bot_A'));
  await waitFor(() => body('bot_A') && body('bot_A').finishedAt != null, 60000, 'A finishes');
  clearInterval(runner);
  A.send({ t: 'move', dir: 0 });
  const ab = body('bot_A');
  check('A crossed the finish line with a recorded time', ab && ab.finishedAt != null && ab.finishedAt > 1000 && events.some((e) => e.t === 'parkour:finish' && e.pid === 'bot_A' && e.place === 1), ab && `${(ab.finishedAt / 1000).toFixed(2)}s, falls ${ab.falls}`);
  await waitFor(() => A.last && A.last.screen === 'parkour' && A.last.finished, 1000, 'phone finished');
  check("A's phone shows its place and time", A.last.finished && A.last.place === 1 && A.last.time === ab.finishedAt);
  check('race keeps going for B', pk().phase === 'play' && body('bot_B').finishedAt == null);

  // ---- 4. skip ends it: ranking = finishers by time, then the rest by distance ----
  disp.cmd('skip');
  await waitFor(() => pk() && pk().phase === 'result', 2000, 'result');
  const r = pk().result;
  check('result: A first, B second by distance', r && r.winner === 'bot_A' && JSON.stringify(r.ranking) === JSON.stringify(['bot_A', 'bot_B']));
  check('champion crown to A', disp.state.game.champion === 'bot_A');
  await waitFor(() => A.results.length && B.results.length, 1000, 'phone results');
  const ra = A.results.at(-1), rb = B.results.at(-1);
  check('phones got win / rank screens', ra && rb && ra.outcome === 'win' && rb.rank === 2 && rb.time == null);
  await waitFor(() => disp.mode() === 'lobby', 3000, 'lobby');
  check('result -> lobby', disp.mode() === 'lobby');

  // ---- 5. the server bot can run the course on its own (at least to the first checkpoint) ----
  disp.cmd('addbot');
  await waitFor(() => disp.state.game.bots === 1, 2000, 'bot');
  A.close(); B.close();
  await sleep(500);
  disp.cmd('start', { game: 'parkour' });
  await waitFor(() => disp.mode() === 'parkour', 2000, 'bot parkour');
  const botPid = pk() && pk().bodies[0] && pk().bodies[0].pid;
  check('a server bot alone can be sent on the course by the host', disp.mode() === 'parkour' && pk().bodies.length === 1 && disp.player(botPid).isBot);
  await waitFor(() => body(botPid) && body(botPid).checkpoint >= 1, 25000, 'bot checkpoint');
  check('the bot runs and jumps past the first pits to checkpoint 1', body(botPid) && body(botPid).checkpoint >= 1, body(botPid) && `x=${body(botPid).pos.x.toFixed(1)} falls=${body(botPid).falls}`);
  disp.cmd('stop');
  await waitFor(() => disp.mode() === 'lobby', 2000, 'stop');
  disp.cmd('removebot');

  await sleep(300);
  disp.close();
  server.kill();
  process.exit(summary() ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
