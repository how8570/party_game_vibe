// All tunables in one place. Game designers edit this file; nothing here touches the network.
const FAST = !!process.env.GAME_FAST; // shorter timings for automated tests

module.exports = {
  FAST,
  HTTPS_PORT: Number(process.env.HTTPS_PORT || 8443), // phones (sensors need a secure context)
  HTTP_PORT: Number(process.env.PORT || 8080),        // PC display, no cert warning
  HOST_OVERRIDE: process.env.HOST || null,            // which LAN IP goes into the QR code

  COLORS: ['#ff5252', '#40c4ff', '#69f0ae', '#ffd740', '#e040fb', '#ff6e40', '#18ffff', '#b2ff59', '#ff80ab', '#8c9eff', '#ccff90', '#ffab40'],

  // Raw sensor classification (lobby input viewer, shake detection)
  INPUT: {
    TILT_RANGE_DEG: 40,   // this many degrees of tilt = full deflection (1.0)
    TILT_DEADZONE: 0.25,  // below this normalized magnitude counts as CENTER
    SHAKE_THRESHOLD: 16,  // m/s^2 of linear acceleration (gravity removed)
    SHAKE_COOLDOWN_MS: 600,
    GESTURE_SHOW_MS: 700,
  },

  // Lobby platformer. World units, y up, pos = feet position.
  WORLD: {
    W: 20, H: 9,
    GRAVITY: 30, JUMP: 13, ACCEL: 48, MAX_SPEED: 6.5, FRICTION: 14, AIR_FRICTION: 2, // max jump height = JUMP^2 / (2*GRAVITY) = 2.8
    COYOTE_MS: 120, JUMP_BUFFER_MS: 150,
    PLATFORMS: [                      // a tower in the middle; the game zones at both ends stay under open sky
      { x: 0, y: 0, w: 20 },          // ground
      { x: 5.4, y: 1.7, w: 2.8 },     // each step is at most ~1.7 units above the one below it
      { x: 11.8, y: 1.7, w: 2.8 },
      { x: 8.6, y: 2.4, w: 2.8 },
      { x: 6.4, y: 4.0, w: 2.4 },
      { x: 11.2, y: 4.0, w: 2.4 },
      { x: 8.8, y: 5.6, w: 2.4 },
    ],
    SPAWN: { x0: 6, x1: 14, y: 7 },   // newcomers drop in from the sky, between the game zones
    KICK: { speed: 5, vy: 7 },        // how hard a loser gets launched out of a zone, towards the middle of the map
    EMOJI_MS: 2500, EMOJI_RATE_MS: 350,
  },

  // Game registry: each game owns a zone on the lobby ground. Stand inside with enough people and it starts.
  GAMES: [
    { id: 'quickdraw', name: '快槍手', min: 2, max: 2, zone: { x0: 15.4, x1: 19.6 }, holdMs: 1000, countdownMs: 0 },
    { id: 'bumper', name: '碰碰車', min: 2, max: 8, zone: { x0: 0.4, x1: 4.6 }, holdMs: 1000, countdownMs: 5000 },
  ],

  // Bumper (sumo). Arena units: ring radius 6, bodies radius 0.5.
  BUMPER: {
    RADIUS: 6, MIN_RADIUS: 2.2, BODY_R: 0.55,
    ACCEL: 30, DAMPING: 3.5, MAX_SPEED: 7,   // MAX_SPEED caps steering only; knock-back decays through DAMPING
    DASH_SPEED: 18, DASH_MS: 220, DASH_COOLDOWN_MS: 1400,
    BOUNCE: 1.5,          // 1.0 = fully elastic exchange along the collision normal; >1 = extra bounce
    BUMP_BONUS: 3,        // every collision adds at least this much separation speed, so even slow bumps shove
    SHOVE: 20,            // extra push a dashing body gives the one it hits
    READY_MS: FAST ? 300 : 3000,
    SHRINK_AFTER_S: 15, SHRINK_S: 30, TIME_LIMIT_S: 75,
    RESULT_MS: FAST ? 400 : 6000,
  },

  // Quick Draw. beta = pitch: +90 upright (top up), 0 flat, -90 top pointing at the floor.
  QD: {
    INTRO_MS: FAST ? 300 : 3500,
    HOLSTER_BETA: -55,         // phone hanging at your side counts as holstered below this pitch
    RAISED_BETA: -30,          // above this pitch the gun is "drawn"
    HOLSTER_HOLD_MS: FAST ? 100 : 600,
    HOLSTER_TIMEOUT_MS: FAST ? 3000 : 30000,
    WAIT_MIN_MS: FAST ? 300 : 2000,
    WAIT_MAX_MS: FAST ? 800 : 6000,
    FIRE_TIMEOUT_MS: FAST ? 800 : 3000,
    RESOLVE_GRACE_MS: 150,     // after the first shot, wait this long for a possibly-earlier shot from the other phone
    RESULT_MS: FAST ? 400 : 5000,
  },
};
