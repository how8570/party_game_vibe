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
    SPAWN: { ranges: [[5, 8.3], [11.7, 15]], y: 7 },   // newcomers drop in from the sky, either side of the tower top (which is the parkour entrance)
    KICK: { speed: 5, vy: 7 },        // how hard a loser gets launched out of a zone, towards the middle of the map
    EMOJI_MS: 2500, EMOJI_RATE_MS: 350,
  },

  // Game registry: each game owns a zone on the lobby ground. Stand inside with enough people and it starts.
  GAMES: [
    { id: 'quickdraw', name: '快槍手', min: 2, max: 2, zone: { x0: 15.4, x1: 19.6 }, holdMs: 1000, countdownMs: 0 },
    { id: 'bumper', name: '碰碰車', min: 2, max: 8, zone: { x0: 0.4, x1: 4.6 }, holdMs: 1000, countdownMs: 5000 },
    // the parkour entrance is the top of the tower: you have to climb to get there
    { id: 'parkour', name: '跑酷', min: 1, max: 8, zone: { x0: 8.8, x1: 11.2, y: 5.6 }, holdMs: 1000, countdownMs: 5000 },
  ],

  // Parkour: a side-scrolling course with the same physics as the lobby. Falling below FALL_Y sends you back to the
  // last checkpoint you passed; the clock keeps running. First across FINISH_X wins.
  PARKOUR: {
    READY_MS: FAST ? 300 : 3000,
    RESULT_MS: FAST ? 400 : 7000,
    TIME_LIMIT_S: 90,
    FALL_Y: -3,
    START_X: 2,
    FINISH_X: 58,
    CHECKPOINTS: [2, 14, 26, 47],   // x positions on the ground; the first is the start
    // Movement has no walk/run distinction, so every gap must be clearable at full speed by jumping at the edge:
    // airtime 0.87 s x 6.5 u/s = 5.6 units of reach on the flat. Pits are 4 wide. Raised platforms are optional.
    COURSE: {
      w: 62, h: 12, floor: false,
      platforms: [
        // ground segments (y = 0) with 4-wide pits between them
        { x: 0, y: 0, w: 9 },
        { x: 13, y: 0, w: 8 },
        { x: 25, y: 0, w: 7 },
        { x: 36, y: 0, w: 6 },
        { x: 46, y: 0, w: 16 },
        // raised platforms: scenery and an optional high road (one-way, never block the ground route)
        { x: 15.5, y: 1.7, w: 2.5 },
        { x: 18.5, y: 3.2, w: 2.5 },
        { x: 27.5, y: 1.7, w: 3 },
        { x: 39, y: 1.7, w: 2.5 },
        { x: 50, y: 1.7, w: 3 },
        { x: 53.5, y: 3.3, w: 3 },
      ],
    },
  },

  // Bumper (sumo). Arena units: ring radius 6, bodies radius 0.5.
  BUMPER: {
    RADIUS: 6, MIN_RADIUS: 2.2, BODY_R: 0.55,
    ACCEL: 30, DAMPING: 4, MAX_SPEED: 7,     // MAX_SPEED caps steering only; knock-back decays through DAMPING
    DASH_SPEED: 17, DASH_MS: 220, DASH_COOLDOWN_MS: 1400,
    // Collisions are inelastic, and "weight" grows with how fast you are driving into the contact, so the one who
    // charges wins the exchange smoothly: a standing target flies, equal head-on speeds bounce symmetrically,
    // and a dash is heavier still. mass = 1 + SPEED_MASS * approachSpeed, times DASH_MASS while dashing.
    RESTITUTION: 0.35,    // 0 = stick together, 1 = fully elastic
    SPEED_MASS: 0.35,     // extra mass per unit of approach speed (max steering speed 7 -> about 3.5x)
    DASH_MASS: 3,         // multiplier while dashing
    SHOVE: 8,             // extra push the victim gets when hit by a dash
    BUMP_BONUS: 0.8,      // small extra push for the lighter side on every hit, so slow nudges still move people
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
