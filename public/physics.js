// ===== Shared physics =====
// This ONE file is used by both the server (Node.js) and the browser.
// The server loads it with require("./public/physics.js"); the browser loads it with a <script> tag.
// Because both run the exact same code with the exact same numbers, the browser can guess
// where our player will be, and the guess matches what the server works out later.
//
// If you change anything in here, both sides change together. That's the whole point!

(function (exports) {
  // ===== Fixed time step =====
  // Physics always moves forward in steps of exactly this many milliseconds (60 steps per second),
  // on the server AND in the browser. One input from the browser = one step.
  const STEP_MS = 1000 / 60;

  // ===== Tweakable constants (try changing these!) =====
  const GRAVITY = 0.5;        // how much downward speed is added every physics step
  const JUMP_STRENGTH = 11;   // upward speed given when you jump
  const MOVE_SPEED = 4;       // pixels moved left/right per physics step

  const WORLD_WIDTH = 800;  // must match the canvas width in index.html
  const PLAYER_SIZE = 30;

  // Platforms are just rectangles. The first one is the floor.
  const PLATFORMS = [
    { x: 0,   y: 420, width: 800, height: 30 },
    { x: 150, y: 340, width: 120, height: 15 },
    { x: 330, y: 270, width: 120, height: 15 },
    { x: 520, y: 200, width: 120, height: 15 },
    { x: 340, y: 130, width: 100, height: 15 },
  ];

  // ===== Move one player one step =====
  // player: { x, y, vx, vy, onGround, frozenSteps }  (this object gets changed)
  // input:  { left, right, jump }  (true/false for each key)
  //
  // frozenSteps counts how many more steps the player is frozen for (after getting tagged).
  // It's counted in steps, not seconds, so the browser can predict exactly when the freeze ends.
  function stepPlayer(player, input) {
    const frozen = player.frozenSteps > 0;
    if (frozen) player.frozenSteps--;

    // 1. Left/right movement based on held keys (a frozen player's keys do nothing)
    player.vx = 0;
    if (!frozen && input.left)  player.vx = -MOVE_SPEED;
    if (!frozen && input.right) player.vx = MOVE_SPEED;

    // 2. Jump, but only if standing on something
    if (!frozen && input.jump && player.onGround) {
      player.vy = -JUMP_STRENGTH; // negative y means "up" on a canvas
    }

    // 3. Gravity: always pull downward a little more each step
    player.vy += GRAVITY;

    // 4. Move horizontally, keeping the player inside the world
    player.x += player.vx;
    player.x = Math.max(0, Math.min(WORLD_WIDTH - PLAYER_SIZE, player.x));

    // 5. Move vertically, then check for landing on platforms
    const previousBottom = player.y + PLAYER_SIZE; // where their feet were before moving
    player.y += player.vy;
    player.onGround = false;

    for (const p of PLATFORMS) {
      const overlapsHorizontally = player.x + PLAYER_SIZE > p.x && player.x < p.x + p.width;
      const feetNow = player.y + PLAYER_SIZE;
      // Land only if falling AND their feet were above the platform top last step
      // but are at or below it now (they "crossed" the top edge this step).
      if (overlapsHorizontally && player.vy >= 0 && previousBottom <= p.y && feetNow >= p.y) {
        player.y = p.y - PLAYER_SIZE; // snap feet onto the platform
        player.vy = 0;                // stop falling
        player.onGround = true;
      }
    }
  }

  exports.STEP_MS = STEP_MS;
  exports.WORLD_WIDTH = WORLD_WIDTH;
  exports.PLAYER_SIZE = PLAYER_SIZE;
  exports.PLATFORMS = PLATFORMS;
  exports.stepPlayer = stepPlayer;

  // In Node, "module" exists and we fill in module.exports.
  // In the browser it doesn't, so everything goes on window.Physics instead.
})(typeof module !== "undefined" ? module.exports : (window.Physics = {}));
