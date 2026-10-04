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

  // ===== Special platforms (try changing these too!) =====
  const JUMPPAD_STRENGTH = 18; // upward speed a jump pad launches you with (a normal jump is 11)
  // How slippery ice is, from 0 to 1. Every step on ice you keep this much of your old sideways
  // speed, and only move the rest of the way toward the speed your keys ask for.
  // 0 = just like normal ground, 0.96 = very slippery, 1 = you can never speed up or stop.
  const ICE_SLIPPERINESS = 0.96;
  // Jump orbs (like Geometry Dash): floating rings you can jump off in mid-air, by pressing
  // jump while touching one. It has to be a fresh press (holding jump from before doesn't count),
  // and each orb only works once until you've left it.
  const ORB_STRENGTH = 12;     // upward speed an orb gives you (a normal jump is 11)
  const ORB_RADIUS = 20;       // how close you need to be: you're touching it if your square is within this of its center

  // ===== Powerups (the server spawns them and decides who picks them up) =====
  // Picking one up sets a countdown of physics steps; while it's above 0 the boost is on.
  // Counted in steps, like the freeze, so the browser can predict exactly when it runs out.
  const POWERUP_STEPS = 3 * 60;     // how long a powerup lasts: 3 seconds
  const SPEED_BOOST = 1.25;         // speed powerup: move 25% faster
  const JUMP_BOOST = 1.3;           // jump powerup: jump 30% harder (normal jumps only, not orbs or jump pads)

  // The level isn't in here any more: it lives in maps/*.json. The server loads it and sends it
  // to each browser when they join, and both pass it to stepPlayer().
  // A map is { width, height, platforms: [{ x, y, width, height, type }, ...] }, where type is:
  //   "solid"    - blocks you from every side: floors, walls, ceilings, blocks
  //   "platform" - one-way: you can jump up through it from below and land on top
  //   "ice"      - a one-way platform you slide around on
  //   "jumppad"  - a one-way platform that launches you upward as soon as you land on it
  //   "moving"   - a one-way platform that goes from (x, y) to (toX, toY) and back again,
  //                taking "seconds" for the whole trip. It carries whoever stands on it.
  // A map can also have jump orbs: orbs: [{ x, y }, ...] (their centers). They aren't platforms:
  // you pass straight through them.

  // ===== Where is a platform at a given tick? =====
  // A tick is one physics step, counted 60 per second since the server started.
  // A moving platform's position depends ONLY on the tick number, which is a whole number,
  // so the server and the browser always work out exactly the same answer.
  // Platforms that don't move are just where the map says.
  function platformPosition(p, tick) {
    if (p.type !== "moving") return { x: p.x, y: p.y };
    const period = Math.max(2, Math.round(p.seconds * 1000 / STEP_MS)); // ticks for there and back
    const phase = ((tick % period) + period) % period; // how far into the trip we are: 0 to period-1
    const half = period / 2;
    // "along" goes 0 -> 1 at a steady speed (there), then 1 -> 0 (back).
    const along = phase < half ? phase / half : (period - phase) / half;
    return { x: p.x + (p.toX - p.x) * along, y: p.y + (p.toY - p.y) * along };
  }

  // Is the player's square overlapping this rectangle? (Just touching an edge doesn't count.)
  function overlaps(player, p) {
    return player.x < p.x + p.width && player.x + PLAYER_SIZE > p.x &&
           player.y < p.y + p.height && player.y + PLAYER_SIZE > p.y;
  }

  // Is the player's square touching a jump orb? (The closest point of the square to the orb's
  // center is within ORB_RADIUS of it.)
  function touchingOrb(player, orb) {
    const nearestX = Math.max(player.x, Math.min(orb.x, player.x + PLAYER_SIZE));
    const nearestY = Math.max(player.y, Math.min(orb.y, player.y + PLAYER_SIZE));
    return (orb.x - nearestX) ** 2 + (orb.y - nearestY) ** 2 <= ORB_RADIUS * ORB_RADIUS;
  }

  // ===== Move one player one step =====
  // player: { x, y, vx, vy, onGround, standingOn, frozenSteps, jumpHeld, usedOrb }  (this object gets changed)
  // input:  { left, right, jump }  (true/false for each key)
  // map:    the map from maps/*.json (see above)
  // tick:   which tick this step happens on (only moving platforms care)
  //
  // standingOn is the index in map.platforms of what we're standing on, or -1 if nothing.
  // frozenSteps counts how many more steps the player is frozen for (after getting tagged).
  // It's counted in steps, not seconds, so the browser can predict exactly when the freeze ends.
  // jumpHeld is whether jump was held last step (so we can tell a fresh press for orbs), and
  // usedOrb is the index in map.orbs of the orb we last jumped off, until we stop touching it (-1 = none).
  // speedSteps and jumpSteps count down how many more steps the speed and jump powerups last.
  function stepPlayer(player, input, map, tick) {
    const frozen = player.frozenSteps > 0;
    if (frozen) player.frozenSteps--;
    const moveSpeed = player.speedSteps > 0 ? MOVE_SPEED * SPEED_BOOST : MOVE_SPEED;
    const jumpStrength = player.jumpSteps > 0 ? JUMP_STRENGTH * JUMP_BOOST : JUMP_STRENGTH;
    if (player.speedSteps > 0) player.speedSteps--;
    if (player.jumpSteps > 0) player.jumpSteps--;
    const jumpPressed = !frozen && input.jump && !player.jumpHeld;
    player.jumpHeld = input.jump;

    // What we were standing on at the end of the last step (undefined if nothing).
    const ground = player.onGround ? map.platforms[player.standingOn] : undefined;

    // 1. Left/right movement based on held keys (a frozen player's keys do nothing)
    let wantedVx = 0;
    if (!frozen && input.left)  wantedVx = -moveSpeed;
    if (!frozen && input.right) wantedVx = moveSpeed;
    if (ground && ground.type === "ice") {
      // On ice we only drift part of the way toward the speed we want each step,
      // so getting going and stopping both take a while.
      player.vx = player.vx * ICE_SLIPPERINESS + wantedVx * (1 - ICE_SLIPPERINESS);
      if (Math.abs(player.vx) < 0.01) player.vx = 0; // close enough to stopped
    } else {
      player.vx = wantedVx; // everywhere else (including in the air) speed changes instantly
    }

    // 2a. Jump orbs: pressing jump while touching one launches us, even in mid-air.
    //     An orb we just used doesn't work again until we've stopped touching it.
    const orbs = map.orbs || [];
    if (player.usedOrb >= 0 && !(orbs[player.usedOrb] && touchingOrb(player, orbs[player.usedOrb]))) {
      player.usedOrb = -1;
    }
    if (jumpPressed) {
      for (let i = 0; i < orbs.length; i++) {
        if (i === player.usedOrb || !touchingOrb(player, orbs[i])) continue;
        player.vy = -ORB_STRENGTH;
        player.onGround = false; // (so the normal jump below doesn't also happen)
        player.usedOrb = i;
        break;
      }
    }

    // 2b. Jump, but only if standing on something
    if (!frozen && input.jump && player.onGround) {
      player.vy = -jumpStrength; // negative y means "up" on a canvas
    }

    // 3. Gravity: always pull downward a little more each step
    player.vy += GRAVITY;

    // 4. Riding a moving platform: it carries us as far as it moved since the last tick.
    //    We stay exactly on its top, whether it went up or down.
    let carryX = 0;
    if (ground && ground.type === "moving") {
      const before = platformPosition(ground, tick - 1);
      const now = platformPosition(ground, tick);
      carryX = now.x - before.x;
      player.y = now.y - PLAYER_SIZE;
    }

    // 5. Move horizontally (our own speed plus any carrying). If that pushed us into something
    //    solid, slide back out the side we came from. (Only solids block sideways movement.)
    const moveX = player.vx + carryX;
    player.x += moveX;
    for (const p of map.platforms) {
      if (p.type !== "solid" || !overlaps(player, p)) continue;
      if (moveX > 0) player.x = p.x - PLAYER_SIZE; // went into its left side
      if (moveX < 0) player.x = p.x + p.width;     // went into its right side
      player.vx = 0;                               // hitting a wall ends any slide
    }
    // Safety net in case a map forgets its walls: never leave the world.
    player.x = Math.max(0, Math.min(map.width - PLAYER_SIZE, player.x));

    // 6. Move vertically, then check for landing on things or bumping our head
    const previousBottom = player.y + PLAYER_SIZE; // where their feet were before moving
    const previousTop = player.y;                  // where their head was before moving
    player.y += player.vy;
    player.onGround = false;
    player.standingOn = -1;
    let landedOn = Infinity; // the top (y) of what we've landed on so far this step

    for (let i = 0; i < map.platforms.length; i++) {
      const p = map.platforms[i];
      const pos = platformPosition(p, tick);
      const overlapsHorizontally = player.x + PLAYER_SIZE > pos.x && player.x < pos.x + p.width;
      if (!overlapsHorizontally) continue;
      const feetNow = player.y + PLAYER_SIZE;
      // Our feet must have started above the top. A moving platform's top shifts during the
      // step, so we use whichever of last tick's and this tick's tops is lower. (That way a
      // platform rising up into our feet still catches us.) For still platforms both are p.y.
      const lowestTop = Math.max(pos.y, platformPosition(p, tick - 1).y);

      // Land only if falling AND their feet were above the top last step
      // but are at or below it now (they "crossed" the top edge this step).
      // Every type works this way: you can stand on anything.
      if (player.vy >= 0 && previousBottom <= lowestTop && feetNow >= pos.y) {
        // Two things can be level under our feet (like a jump pad sitting on the floor).
        // Then the special one wins: a plain platform never replaces what we already landed on.
        const plain = p.type === "solid" || p.type === "platform";
        if (pos.y === landedOn && plain) continue;

        player.y = pos.y - PLAYER_SIZE; // snap feet onto the top
        player.vy = 0;                  // stop falling
        player.onGround = true;
        player.standingOn = i;
        landedOn = pos.y;

        if (p.type === "jumppad") {
          // Boing! Launch straight back up. Since we're now going up, nothing else
          // will catch us this step.
          player.vy = -JUMPPAD_STRENGTH;
          player.onGround = false;
          player.standingOn = -1;
        }
      }
      // Solid things also have a bottom: if our head crossed it while going up, we bonk.
      // (Every other type skips this, so you jump straight through them.)
      else if (p.type === "solid" && player.vy < 0 && previousTop >= p.y + p.height && player.y < p.y + p.height) {
        player.y = p.y + p.height; // put our head just under it
        player.vy = 0;             // start falling
      }
    }
  }

  exports.STEP_MS = STEP_MS;
  exports.PLAYER_SIZE = PLAYER_SIZE;
  exports.JUMPPAD_STRENGTH = JUMPPAD_STRENGTH;
  exports.ICE_SLIPPERINESS = ICE_SLIPPERINESS;
  exports.ORB_RADIUS = ORB_RADIUS;
  exports.POWERUP_STEPS = POWERUP_STEPS;
  exports.overlaps = overlaps;
  exports.platformPosition = platformPosition;
  exports.stepPlayer = stepPlayer;

  // In Node, "module" exists and we fill in module.exports.
  // In the browser it doesn't, so everything goes on window.Physics instead.
})(typeof module !== "undefined" ? module.exports : (window.Physics = {}));
