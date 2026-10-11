// Quick Draw: two players holster their phones, a random wait, a gunshot, fastest draw wins. False start loses.
//
// Game module contract (see games/index.js):
//   id, start(pids), stop(), skip(), hostStart(), onShot(p, m, receivedAt), phoneScreen(p) -> screen | null, publicState()
const { QD } = require('../config');
const { players, game, bus } = require('../state');
const { send, broadcastDisplays, event } = require('../net');
const { connectedPlayers, toServerTime } = require('../players');
const lobby = require('../lobby');

const ID = 'quickdraw';
const REASON_TEXT = { shot: '先開槍', falsestart: '對手搶跑', timeout: '沒人開槍', left: '對手離線', holster: '沒就位' };

let duel = null;
let round = 0;

const randBetween = (a, b) => a + Math.random() * (b - a);
const isDuelist = (pid) => !!duel && (pid === duel.a || pid === duel.b);
const otherDuelist = (pid) => (pid === duel.a ? duel.b : duel.a);
const running = () => game.mode === ID && !!duel;

// ---------- lifecycle ----------
function start(pids) {
  if (game.mode !== 'lobby' || pids.length < 2) return false;
  const [a, b] = pids;
  game.mode = ID;
  game.message = '';
  game.participants = new Set([a, b]);
  round++;
  duel = {
    a, b, round,
    phase: 'intro', phaseAt: Date.now(),
    fireAt: null,
    holster: { [a]: { since: null, ok: false }, [b]: { since: null, ok: false } },
    shots: {},           // pid -> reaction ms (server time - fireAt)
    misfires: {},        // pid -> count
    resolveAt: null,
    result: null,
  };
  event(players.get(a), 'duel', `第 ${round} 回合：${players.get(a).name} vs ${players.get(b).name}`);
  bus.emit('phones:push');
  return true;
}

// Host pressed start: whoever is standing in the zone, otherwise the first two connected players. Champion takes side A.
function hostStart() {
  const zone = lobby.zoneOccupants(ID);
  const ps = zone.length >= 2 ? zone : connectedPlayers();
  if (ps.length < 2) { game.message = '需要至少兩位玩家'; return false; }
  const a = ps.find((p) => p.pid === game.champion) || ps[0];
  const b = ps.find((p) => p !== a);
  return start([a.pid, b.pid]);
}

function stop() {
  if (game.mode !== ID) return;
  game.mode = 'lobby';
  game.message = '';
  game.participants = new Set();
  duel = null;
  bus.emit('phones:push');
  broadcastDisplays({ t: 'event', kind: 'game', detail: '回到大廳' });
}

function skip() {
  if (running() && duel.phase !== 'result') finishDuel({ winner: null, loser: null, reason: 'timeout' });
}

// Result shown long enough: back to the lobby. The loser gets launched out of the zone so the champion's slot opens up.
function endDuel() {
  if (duel && duel.result) {
    if (duel.result.loser) bus.emit('player:kick', duel.result.loser);
    else if (!duel.result.winner) bus.emit('player:kick', duel.b); // draw: challenger steps out, try again
  }
  game.mode = 'lobby';
  game.participants = new Set();
  duel = null;
  bus.emit('phones:push');
}

function setPhase(phase) {
  duel.phase = phase; duel.phaseAt = Date.now();
  if (phase === 'fire') {
    duel.fireAt = duel.phaseAt;
    broadcastDisplays({ t: 'fire', at: duel.fireAt });
  }
  bus.emit('phones:push');
}

function finishDuel(result) {
  if (!duel || duel.phase === 'result') return;
  duel.result = result;
  if (result.winner) {
    const w = players.get(result.winner);
    w.wins++;
    game.champion = result.winner;
    event(w, 'duel', `${w.name} 獲勝（${REASON_TEXT[result.reason] || result.reason}）`);
  } else {
    event(players.get(duel.a), 'duel', `平手（${REASON_TEXT[result.reason] || result.reason}）`);
  }
  setPhase('result');
}

// ---------- inputs ----------
function onMotion(p, m, receivedAt) {
  if (!running() || !isDuelist(p.pid)) return;
  const beta = m.beta;
  if (duel.phase === 'intro' || duel.phase === 'holster') {
    const h = duel.holster[p.pid];
    if (beta < QD.HOLSTER_BETA) {
      if (h.since == null) h.since = receivedAt;
      const ok = receivedAt - h.since >= QD.HOLSTER_HOLD_MS;
      if (ok !== h.ok) { h.ok = ok; send(p.ws, { t: 'holster', ok }); }
    } else {
      h.since = null;
      if (h.ok) { h.ok = false; send(p.ws, { t: 'holster', ok: false }); }
    }
  } else if (duel.phase === 'wait') {
    if (beta > QD.RAISED_BETA) {
      finishDuel({ winner: otherDuelist(p.pid), loser: p.pid, reason: 'falsestart', by: 'raise' });
    }
  }
}
bus.on('motion', onMotion);

function onShot(p, m, receivedAt) {
  if (!running() || !isDuelist(p.pid)) return;
  const ts = toServerTime(p, m.ts, receivedAt);
  const beta = typeof m.beta === 'number' ? m.beta : p.orient.beta;
  if (duel.phase === 'wait' || duel.phase === 'holster') {
    finishDuel({ winner: otherDuelist(p.pid), loser: p.pid, reason: 'falsestart', by: 'press' });
    return;
  }
  if (duel.phase === 'result') {
    // Late shot after the duel was decided: record it so the loser's reaction time shows too.
    if (duel.result && duel.result.reason === 'shot' && duel.shots[p.pid] == null && ts >= duel.fireAt && beta >= QD.RAISED_BETA) {
      duel.shots[p.pid] = Math.max(0, Math.round(ts - duel.fireAt));
      duel.result.reactions = { [duel.a]: duel.shots[duel.a], [duel.b]: duel.shots[duel.b] };
      bus.emit('phones:push');
    }
    return;
  }
  if (duel.phase !== 'fire') return;
  if (ts < duel.fireAt) {
    finishDuel({ winner: otherDuelist(p.pid), loser: p.pid, reason: 'falsestart', by: 'press' });
    return;
  }
  if (beta < QD.RAISED_BETA) {
    duel.misfires[p.pid] = (duel.misfires[p.pid] || 0) + 1;
    send(p.ws, { t: 'misfire' });
    return;
  }
  if (duel.shots[p.pid] != null) return; // already shot
  duel.shots[p.pid] = Math.max(0, Math.round(ts - duel.fireAt));
  if (!duel.resolveAt) duel.resolveAt = receivedAt + QD.RESOLVE_GRACE_MS;
  if (duel.shots[duel.a] != null && duel.shots[duel.b] != null) resolveShots();
}

function resolveShots() {
  const ra = duel.shots[duel.a], rb = duel.shots[duel.b];
  let winner, loser;
  if (ra != null && (rb == null || ra <= rb)) { winner = duel.a; loser = duel.b; } else { winner = duel.b; loser = duel.a; }
  finishDuel({ winner, loser, reason: 'shot', reactions: { [duel.a]: ra, [duel.b]: rb } });
}

bus.on('player:leave', (p) => {
  if (running() && isDuelist(p.pid) && duel.phase !== 'result') {
    finishDuel({ winner: otherDuelist(p.pid), loser: null, reason: 'left' });
  }
});

// ---------- clock ----------
function tick() {
  if (!running()) return;
  const now = Date.now();
  const elapsed = now - duel.phaseAt;
  switch (duel.phase) {
    case 'intro':
      if (elapsed >= QD.INTRO_MS) setPhase('holster');
      break;
    case 'holster':
      if (duel.holster[duel.a].ok && duel.holster[duel.b].ok) {
        setPhase('wait');
        duel.fireAt = now + randBetween(QD.WAIT_MIN_MS, QD.WAIT_MAX_MS);
      } else if (elapsed >= QD.HOLSTER_TIMEOUT_MS) {
        const okA = duel.holster[duel.a].ok, okB = duel.holster[duel.b].ok;
        if (okA !== okB) finishDuel({ winner: okA ? duel.a : duel.b, loser: okA ? duel.b : duel.a, reason: 'holster' });
        else finishDuel({ winner: null, loser: null, reason: 'holster' });
      }
      break;
    case 'wait':
      if (now >= duel.fireAt) setPhase('fire');
      break;
    case 'fire':
      if (duel.resolveAt && now >= duel.resolveAt) resolveShots();
      else if (elapsed >= QD.FIRE_TIMEOUT_MS) finishDuel({ winner: null, loser: null, reason: 'timeout' });
      break;
    case 'result':
      if (elapsed >= QD.RESULT_MS) endDuel();
      break;
  }
}
setInterval(tick, 25);

// ---------- views ----------
function publicDuel() {
  if (!duel) return null;
  const pub = (pid) => {
    const p = players.get(pid);
    return { pid, num: p.num, name: p.name, color: p.color, wins: p.wins, connected: p.connected, holstered: duel.holster[pid].ok, reaction: duel.shots[pid] != null ? duel.shots[pid] : null, misfires: duel.misfires[pid] || 0 };
  };
  return {
    round: duel.round, phase: duel.phase, phaseAt: duel.phaseAt,
    fireAt: duel.phase === 'fire' || duel.phase === 'result' ? duel.fireAt : null, // never leak fireAt before it happens
    a: pub(duel.a), b: pub(duel.b),
    result: duel.result,
    phaseMs: { intro: QD.INTRO_MS, result: QD.RESULT_MS, fireTimeout: QD.FIRE_TIMEOUT_MS },
  };
}

function publicState() { return { round, duel: game.mode === ID ? publicDuel() : null }; }

// What a phone should show; null when this game is not running.
function phoneScreen(p) {
  if (!running()) return null;
  if (!isDuelist(p.pid)) {
    return { screen: 'spectate', game: '快槍手', a: players.get(duel.a).name, b: players.get(duel.b).name, phase: duel.phase };
  }
  const opp = players.get(otherDuelist(p.pid));
  const base = { opponent: opp.name, opponentColor: opp.color, round: duel.round };
  switch (duel.phase) {
    case 'intro': return { screen: 'intro', ...base };
    case 'holster': return { screen: 'holster', ...base, ok: duel.holster[p.pid].ok };
    case 'wait': return { screen: 'wait', ...base };
    case 'fire': return { screen: 'fire', ...base };
    case 'result': {
      const r = duel.result;
      const outcome = !r.winner ? 'draw' : r.winner === p.pid ? 'win' : 'lose';
      return {
        screen: 'result', ...base, outcome, reason: r.reason, by: r.by || null,
        myReaction: duel.shots[p.pid] != null ? duel.shots[p.pid] : null,
        theirReaction: duel.shots[opp.pid] != null ? duel.shots[opp.pid] : null,
        wins: p.wins,
      };
    }
  }
  return null;
}

module.exports = { id: ID, start, stop, skip, hostStart, onShot, phoneScreen, publicState };
