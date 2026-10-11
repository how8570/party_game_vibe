// Small helpers for talking to sockets. Keeps JSON encoding and readyState checks out of the game code.
const os = require('os');
const { displays } = require('./state');

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastDisplays(obj) {
  const s = JSON.stringify(obj);
  for (const d of displays) if (d.readyState === d.OPEN) d.send(s);
}

// One line in the display's event log.
function event(p, kind, detail) {
  broadcastDisplays({ t: 'event', pid: p ? p.pid : null, num: p ? p.num : null, kind, detail: detail || '' });
}

module.exports = { lanAddresses, send, broadcastDisplays, event };
