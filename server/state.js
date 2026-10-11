// Shared mutable state plus an event bus so modules can talk without requiring each other in circles.
//
// Bus events:
//   'motion'      (player, msg, receivedAt)   raw orientation/acceleration sample, after classification
//   'shake'       (player)                    shake gesture detected
//   'player:leave'(player)                    phone disconnected
//   'player:kick' (pid)                       launch this avatar out of the game zone
//   'zone:ready'  (gameId, pids)              enough people stood in a zone long enough
//   'phones:push'                             something changed, re-send each phone its screen
const EventEmitter = require('events');

module.exports = {
  players: new Map(),   // pid -> player (see players.js newPlayer)
  displays: new Set(),  // WebSocket connections of PC displays
  game: {
    mode: 'lobby',          // 'lobby' | a game id from config.GAMES
    champion: null,         // pid wearing the crown (last winner)
    message: '',            // one-line status for the display
    participants: new Set() // pids currently inside a running game (frozen in the lobby physics)
  },
  bus: new EventEmitter(),
};
