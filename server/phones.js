// Decides what each phone shows and pushes it only when it changes.
const { players, bus } = require('./state');
const { send } = require('./net');
const games = require('./games');

function phoneScreen(p) {
  const a = games.active();
  return (a && a.phoneScreen(p)) || { screen: 'lobby' };
}

function pushPhoneScreens() {
  for (const p of players.values()) {
    if (!p.connected) continue;
    const s = phoneScreen(p);
    const key = JSON.stringify(s);
    if (p.screen === key) continue;
    p.screen = key;
    send(p.ws, { t: 'game', ...s });
  }
}
bus.on('phones:push', pushPhoneScreens);

module.exports = { phoneScreen, pushPhoneScreens };
