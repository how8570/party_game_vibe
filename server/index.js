// Entry point: HTTP/HTTPS static hosting, WebSocket routing, 30 Hz state broadcast to displays.
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const config = require('./config');
const { players, displays, game } = require('./state');
const { lanAddresses, send, broadcastDisplays } = require('./net');
const { loadOrCreateCert } = require('./tls');
const P = require('./players');
const lobby = require('./lobby');
const games = require('./games');
const phones = require('./phones');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CERT_DIR = path.join(ROOT, 'certs');

const lan = lanAddresses();
const HOST = config.HOST_OVERRIDE || (lan[0] ? lan[0].address : 'localhost');
const JOIN_URL = `https://${HOST}:${config.HTTPS_PORT}/c`;
const tls = loadOrCreateCert(CERT_DIR, lan);

// ---------- state broadcast ----------
function snapshot() {
  return {
    t: 'state',
    joinUrl: JOIN_URL,
    world: lobby.publicWorld(),
    players: [...players.values()].sort((a, b) => a.num - b.num).map(P.publicPlayer),
    game: {
      mode: game.mode, message: game.message, champion: game.champion,
      games: lobby.publicGames(),
      ...games.publicState(),
    },
  };
}
setInterval(() => { if (displays.size) broadcastDisplays(snapshot()); }, 1000 / 30);

// ---------- WebSocket roles ----------
function handleController(ws, hello) {
  const p = P.join(ws, hello);
  send(ws, { t: 'game', ...phones.phoneScreen(p) });
  p.screen = JSON.stringify(phones.phoneScreen(p));

  ws.on('message', (raw) => {
    const receivedAt = Date.now();
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    switch (m.t) {
      case 'motion': P.classifyMotion(p, m, receivedAt); break;
      case 'pong': P.onPong(p, m); break;
      case 'shot': games.onShot(p, m, receivedAt); break;
      case 'emoji': lobby.onEmoji(p, m); break;
      case 'jump': lobby.wantJump(p); break;
      case 'move': lobby.onMove(p, m); break;
      case 'btn': P.onButton(p, m); break;
      case 'calib': p.neutral = null; break;
      case 'name': p.name = String(m.name || '').slice(0, 16) || p.name; break;
      default: games.onMessage(p, m, receivedAt);
    }
  });
  ws.on('close', () => { if (P.leave(p, ws)) phones.pushPhoneScreens(); });
}

function handleDisplay(ws) {
  displays.add(ws);
  send(ws, snapshot());
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t !== 'cmd') return;
    switch (m.cmd) {
      case 'start': games.hostStart(); break;
      case 'stop': games.stop(); break;
      case 'skip': games.skip(); break;
      case 'reset': P.forgetDisconnected(); break;
    }
  });
  ws.on('close', () => displays.delete(ws));
}

function onConnection(ws) {
  ws.once('message', (raw) => {
    let hello; try { hello = JSON.parse(raw); } catch (e) { return ws.close(); }
    if (hello.t !== 'hello') return ws.close();
    if (hello.role === 'controller') handleController(ws, hello);
    else if (hello.role === 'display') handleDisplay(ws);
    else ws.close();
  });
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
    return res.end(JSON.stringify({ joinUrl: JOIN_URL, host: HOST, port: config.HTTPS_PORT, httpPort: config.HTTP_PORT }));
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
new WebSocketServer({ server: httpsServer }).on('connection', onConnection);
new WebSocketServer({ server: httpServer }).on('connection', onConnection);

httpServer.listen(config.HTTP_PORT, '0.0.0.0');
httpsServer.listen(config.HTTPS_PORT, '0.0.0.0', async () => {
  console.log('');
  console.log(`  Display (open on this PC):  http://localhost:${config.HTTP_PORT}/`);
  console.log(`  Controller (open on phone): ${JOIN_URL}`);
  if (lan.length > 1) {
    console.log(`  Other interfaces: ${lan.map((l) => `${l.name}=${l.address}`).join(', ')}  (override with HOST=...)`);
  }
  console.log(`  TLS cert: ${tls.source}${config.FAST ? '   [GAME_FAST timings]' : ''}`);
  console.log('');
  console.log(await QRCode.toString(JOIN_URL, { type: 'terminal', small: true }));
});
