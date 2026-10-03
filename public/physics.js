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

  const PLAYER_SIZE = 30;

  // The level isn't in here any more: it lives in maps/*.json. The server loads it and sends it
  // to each browser when they join, and both pass it to stepPlayer().
  // A map is { width, height, platforms: [{ x, y, width, height, type }, ...] }, where type is:
  //   "solid"    - blocks you from every side: floors, walls, ceilings, blocks
  //   "platform" - one-way: you can jump up through it from below and land on top

  // Is the player's square overlapping this rectangle? (Just touching an edge doesn't count.)
  function overlaps(player, p) {
    return player.x < p.x + p.width && player.x + PLAYER_SIZE > p.x &&
           player.y < p.y + p.height && player.y + PLAYER_SIZE > p.y;
  }

  // ===== Move one player one step =====
  // player: { x, y, vx, vy, onGround, frozenSteps }  (this object gets changed)
  // input:  { left, right, jump }  (true/false for each key)
  // map:    the map from maps/*.json (see above)
  //
  // frozenSteps counts how many more steps the player is frozen for (after getting tagged).
  // It's counted in steps, not seconds, so the browser can predict exactly when the freeze ends.
  function stepPlayer(player, input, map) {
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

    // 4. Move horizontally. If that pushed us into something solid, slide back out
    //    the side we came from. (One-way platforms never block sideways movement.)
    player.x += player.vx;
    for (const p of map.platforms) {
      if (p.type !== "solid" || !overlaps(player, p)) continue;
      if (player.vx > 0) player.x = p.x - PLAYER_SIZE; // walked into its left side
      if (player.vx < 0) player.x = p.x + p.width;     // walked into its right side
    }
    // Safety net in case a map forgets its walls: never leave the world.
    player.x = Math.max(0, Math.min(map.width - PLAYER_SIZE, player.x));

    // 5. Move vertically, then check for landing on things or bumping our head
    const previousBottom = player.y + PLAYER_SIZE; // where their feet were before moving
    const previousTop = player.y;                  // where their head was before moving
    player.y += player.vy;
    player.onGround = false;

    for (const p of map.platforms) {
      const overlapsHorizontally = player.x + PLAYER_SIZE > p.x && player.x < p.x + p.width;
      if (!overlapsHorizontally) continue;
      const feetNow = player.y + PLAYER_SIZE;
      const bottomOfP = p.y + p.height;
      // Land only if falling AND their feet were above the top last step
      // but are at or below it now (they "crossed" the top edge this step).
      // Both types work this way: you can stand on anything.
      if (player.vy >= 0 && previousBottom <= p.y && feetNow >= p.y) {
        player.y = p.y - PLAYER_SIZE; // snap feet onto the top
        player.vy = 0;                // stop falling
        player.onGround = true;
      }
      // Solid things also have a bottom: if our head crossed it while going up, we bonk.
      // (One-way platforms skip this, so you jump straight through them.)
      else if (p.type === "solid" && player.vy < 0 && previousTop >= bottomOfP && player.y < bottomOfP) {
        player.y = bottomOfP; // put our head just under it
        player.vy = 0;        // start falling
      }
    }
  }

  exports.STEP_MS = STEP_MS;
  exports.PLAYER_SIZE = PLAYER_SIZE;
  exports.overlaps = overlaps;
  exports.stepPlayer = stepPlayer;

  // In Node, "module" exists and we fill in module.exports.
  // In the browser it doesn't, so everything goes on window.Physics instead.
})(typeof module !== "undefined" ? module.exports : (window.Physics = {}));
