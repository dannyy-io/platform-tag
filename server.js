// ===== Testing: fake lag =====
// Pretend the network is slow. Every message the server receives, and every message
// it sends, waits this many milliseconds first. 0 means no fake lag.
// Try 100 or 200 to feel what a laggy connection is like.
const FAKE_LAG_MS = 0;

// ===== Physics =====
// Gravity, movement and collision live in public/physics.js, which the browser uses too.
// That way the browser's predictions and the server's answers are always calculated the same way.
const Physics = require("./public/physics.js");
const { STEP_MS, PLAYER_SIZE, stepPlayer, overlaps } = Physics;

// ===== Map =====
// The level is a JSON file listing every platform. We load it once when the server starts,
// and send it to each browser when they join (see "init" below).
const fs = require("fs");
const path = require("path");
const MAP_FILE = path.join(__dirname, "maps", "map1.json");
const MAP_TYPES = ["solid", "platform", "ice", "jumppad", "moving"];
const map = loadMap(MAP_FILE);

// ===== Ticks =====
// Moving platforms are positioned by tick number: physics steps (60 per second) counted
// since the server started. The browser is told START_TIME so it can count along.
const START_TIME = Date.now();
function currentTick() {
  return Math.floor((Date.now() - START_TIME) / STEP_MS);
}
// Each input says which tick the browser ran it on, and we run it on that same tick so moving
// platforms are where the browser thought they were. Inputs arrive a little late, so that tick
// is a little in the past. We only accept ticks within this window, so nobody can pick
// wherever they like for the platforms.
const MAX_TICKS_BEHIND = 120; // 2 seconds
const MAX_TICKS_AHEAD = 10;
function allowedTick(tick, nowTick) {
  return Math.max(nowTick - MAX_TICKS_BEHIND, Math.min(nowTick + MAX_TICKS_AHEAD, tick));
}

// Read a map file and check it makes sense, so a typo in the JSON gives a clear error
// when the server starts instead of weird physics later.
function loadMap(file) {
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  const isNumber = (n) => typeof n === "number" && Number.isFinite(n);
  if (!isNumber(m.width) || !isNumber(m.height) || !Array.isArray(m.platforms)) {
    throw new Error(file + ": a map needs a width, a height and a platforms list");
  }
  m.platforms.forEach((p, i) => {
    if (![p.x, p.y, p.width, p.height].every(isNumber) || p.width <= 0 || p.height <= 0) {
      throw new Error(file + ": platform " + i + " needs a number x, y, width and height (width and height above 0)");
    }
    if (!MAP_TYPES.includes(p.type)) {
      throw new Error(file + ": platform " + i + ' has type "' + p.type + '", it must be one of: ' + MAP_TYPES.join(", "));
    }
    if (p.type === "moving" && (![p.toX, p.toY, p.seconds].every(isNumber) || p.seconds <= 0)) {
      throw new Error(file + ": moving platform " + i + " needs a number toX, toY and seconds (seconds above 0)");
    }
  });
  // Jump orbs are optional: a list of { x, y } centers.
  if (m.orbs === undefined) m.orbs = [];
  if (!Array.isArray(m.orbs)) throw new Error(file + ": orbs must be a list");
  m.orbs.forEach((o, i) => {
    if (!o || !isNumber(o.x) || !isNumber(o.y)) throw new Error(file + ": orb " + i + " needs a number x and y");
  });
  console.log(`Loaded map "${m.name || file}" (${m.width}x${m.height}, ${m.platforms.length} platforms)`);
  return m;
}

// A random place to stand: on top of a random platform, at a random spot along it.
// We skip spots where the player would be stuck inside something solid (like the ceiling
// above the walls) and try again.
function randomSpawn() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const p = map.platforms[Math.floor(Math.random() * map.platforms.length)];
    if (p.width < PLAYER_SIZE) continue;
    if (p.type === "moving" || p.type === "jumppad") continue; // no spawning onto something that moves or launches you
    const spot = {
      x: p.x + Math.random() * (p.width - PLAYER_SIZE),
      y: p.y - PLAYER_SIZE,
    };
    const insideWorld = spot.x >= 0 && spot.y >= 0 && spot.x + PLAYER_SIZE <= map.width;
    const stuck = map.platforms.some((other) => other.type === "solid" && overlaps(spot, other));
    // A jump pad sitting on this platform right under our feet would launch us the moment we join.
    const onPad = map.platforms.some((other) => other.type === "jumppad" && overlaps({ x: spot.x, y: spot.y + 1 }, other));
    if (insideWorld && !stuck && !onPad) return spot;
  }
  return { x: map.width / 2, y: 0 }; // couldn't find anywhere (strange map): drop in from the top middle
}

// Players respawned at the start of a round try to land at least this far from each other,
// so "it" can't start right on top of someone.
const SPAWN_SPACING = 200;

// Like randomSpawn, but tries to keep away from the spots in "taken" ([{ x, y }, ...]).
// If it can't find one far enough from all of them, it settles for the last one it tried.
function randomSpawnAwayFrom(taken) {
  let spot;
  for (let attempt = 0; attempt < 30; attempt++) {
    spot = randomSpawn();
    if (taken.every((t) => Math.hypot(t.x - spot.x, t.y - spot.y) >= SPAWN_SPACING)) break;
  }
  return spot;
}

// Put a player at a spot, standing still. "spawns" counts how many times this has happened,
// so browsers can tell a respawn (snap straight there) from normal movement (glide there).
function placePlayer(p, spot) {
  p.x = spot.x;
  p.y = spot.y;
  p.vx = 0;
  p.vy = 0;
  p.onGround = false; // they land on the platform under them on their next step
  p.standingOn = -1;
  p.usedOrb = -1;
  p.spawns++;
}

// ===== Tag rules =====
const ROUND_LENGTH = 60 * 1000; // how long a round lasts (milliseconds)
const FREEZE_TIME = 1.5 * 1000; // how long a newly tagged "it" can't move or tag (milliseconds)
// The freeze is counted in that player's physics steps (90 steps = 1.5 seconds),
// so the browser can predict exactly which of its inputs will be frozen.
const FREEZE_STEPS = Math.round(FREEZE_TIME / STEP_MS);
const RESULTS_TIME = 5 * 1000;  // how long the winner is shown before the next round (milliseconds)
const START_COUNTDOWN = 5 * 1000; // once enough players are here, how long until the first round starts (milliseconds)
const MIN_PLAYERS = 2;          // a round only runs with at least this many players
// "it" has to press the tag key (Space) to tag someone. Touching alone isn't enough.
const TAG_WINDOW = 150;   // a press tags anyone "it" touches within this many milliseconds of it (forgives pressing a little early)
const TAG_COOLDOWN = 400; // after a press, further presses are ignored for this long (milliseconds), so mashing the key doesn't work

// ===== Powerups =====
// Pickups that appear on random platforms. Touch one to grab it (see updatePowerups).
// What each one does, and for how long, is in physics.js.
//   "speed" - move 25% faster
//   "jump"  - jump 30% higher
const POWERUP_TYPES = ["speed", "jump"];
const MAX_POWERUPS = 3;               // never more than this many on the map at once
const POWERUP_SPAWN_TIME = 10 * 1000; // a new one appears this often (milliseconds), while there's room
const POWERUP_SPACING = 400;          // new ones try to appear at least this far from other powerups and jump orbs
const POWERUP_SIZE = 28;              // width and height of the square you have to touch to grab one

// The powerups on the map right now: [{ id, type, x, y }, ...] where (x, y) is the center.
const powerups = [];
let nextPowerupId = 1;
// The types take turns (speed, jump, speed, ...) so both appear exactly as often.
// (Picking at random could give several of one type in a row.)
let nextPowerupType = 0;
let nextPowerupAt = Date.now() + POWERUP_SPAWN_TIME;

// A random spot floating just above a platform, away from other powerups and orbs if possible.
function powerupSpot() {
  const others = powerups.concat(map.orbs);
  let spot;
  for (let attempt = 0; attempt < 30; attempt++) {
    const s = randomSpawn(); // somewhere a player could stand (top-left of their square)
    spot = { x: s.x + PLAYER_SIZE / 2, y: s.y + PLAYER_SIZE / 2 - 6 };
    if (others.every((o) => Math.hypot(o.x - spot.x, o.y - spot.y) >= POWERUP_SPACING)) break;
  }
  return spot;
}

// Runs once per tick: spawn new powerups now and then, and give them to whoever touches them.
function updatePowerups(now) {
  if (powerups.length >= MAX_POWERUPS) nextPowerupAt = now + POWERUP_SPAWN_TIME; // full: start counting once one is taken
  else if (now >= nextPowerupAt) {
    const type = POWERUP_TYPES[nextPowerupType];
    nextPowerupType = (nextPowerupType + 1) % POWERUP_TYPES.length;
    powerups.push({ id: nextPowerupId++, type, ...powerupSpot() });
    nextPowerupAt = now + POWERUP_SPAWN_TIME;
  }

  for (let i = powerups.length - 1; i >= 0; i--) {
    const u = powerups[i];
    const box = { x: u.x - POWERUP_SIZE / 2, y: u.y - POWERUP_SIZE / 2, width: POWERUP_SIZE, height: POWERUP_SIZE };
    const taker = Object.values(players).find((p) => overlaps(p, box));
    if (!taker) continue;
    // Grabbing one you already have starts its 3 seconds over again.
    if (u.type === "speed") taker.speedSteps = Physics.POWERUP_STEPS;
    if (u.type === "jump") taker.jumpSteps = Physics.POWERUP_STEPS;
    powerups.splice(i, 1);
  }
}

// How often the server updates the world and tells everyone about it.
// (This is only a target: on Windows, Node's timers are rough and it's really about 21
// per second. That's fine, because how far physics moves depends on the real time that
// passed, not on how many ticks happened. See the game loop.)
const TICK_RATE = 30; // ticks per second

// ===== Input queue =====
// Every input the browser sends is one physics step. They wait in a queue and the
// server runs them in order. These limits stop a cheater from sending inputs faster
// than 60 per second to move faster than everyone else.
const MAX_STEP_CREDIT = 8;     // at most this many queued inputs can be caught up on in one tick
const MAX_QUEUED_INPUTS = 30;  // inputs beyond this (half a second's worth) are thrown away
// If a browser stops sending inputs (e.g. its tab is in the background), the server
// keeps moving that player with no keys held, so they don't hang in mid-air.
const IDLE_MS = 500;
const NO_KEYS = { left: false, right: false, jump: false, tag: false };

// A tiny web server. It sends the files in "public" to the browser,
// runs the game itself, and sends the results to every browser using Socket.IO.
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
// Hosting services (and Docker setups) often pick the port with a PORT environment variable.
const PORT = process.env.PORT || 3000;

// Any file inside the "public" folder can be requested by the browser.
// Visiting http://localhost:3000/ serves public/index.html automatically.
app.use(express.static("public"));

// Socket.IO needs the raw HTTP server that Express runs on, so we create it ourselves.
const server = http.createServer(app);
const io = new Server(server);

// Run fn after FAKE_LAG_MS, or right away if there's no fake lag.
// Every message going in or out of the server goes through this.
function withLag(fn) {
  if (FAKE_LAG_MS > 0) setTimeout(fn, FAKE_LAG_MS);
  else fn();
}

// Everyone currently connected, keyed by their socket id.
// Each player has a position (x, y), a velocity (vx, vy), and a queue of inputs waiting to run.
const players = {};

// ===== Names =====
// The browser sends the name its player typed, but we never trust it: anyone can send anything.
// A good name is 1-16 characters of letters, numbers, spaces and underscores, and isn't all spaces.
// Anything else (too long, odd symbols, not even text) gets "Player" plus a number instead.
// No two players can have the same name (ignoring capitals, so "Bob" and "bob" count as the same):
// joining with a name someone already has is turned down (see "join" below).
const MAX_NAME_LENGTH = 16;
let nextPlayerNumber = 1;

function checkName(raw) {
  const name = typeof raw === "string" ? raw.trim() : "";
  const ok = name.length >= 1 && name.length <= MAX_NAME_LENGTH && /^[A-Za-z0-9 _]+$/.test(name);
  if (ok) return name;
  // Skip any number someone has already typed as their own name (like "Player3").
  let fallback;
  do fallback = "Player" + nextPlayerNumber++; while (nameTaken(fallback));
  return fallback;
}

function nameTaken(name) {
  const lower = name.toLowerCase();
  return Object.values(players).some((p) => p.name.toLowerCase() === lower);
}

// Red is saved for "it", so normal players get any hue except the reds (roughly 0-30 and 330-360).
function randomColor() {
  return "hsl(" + Math.floor(30 + Math.random() * 300) + ", 80%, 55%)";
}

// ===== Round state =====
// phase is one of:
//   "waiting"  - fewer than MIN_PLAYERS connected, nothing happens
//   "starting" - enough players just arrived: counting down to the first round
//   "playing" - a round is running and someone is "it"
//   "results" - the round is over and the winner is being shown
const round = {
  phase: "waiting",
  itId: null,     // socket id of whoever is "it"
  endsAt: 0,      // when the current phase ends (a Date.now() time), for "starting", "playing" and "results"
  winner: null,   // { id, name, color, itTime } of the last round's winner, kept even if they leave
};

function playerCount() {
  return Object.keys(players).length;
}

function pickRandomIt() {
  const ids = Object.keys(players);
  round.itId = ids[Math.floor(Math.random() * ids.length)];
}

function startRound() {
  // Everyone starts the round with a clean slate, at a new random spot.
  const taken = [];
  for (const id in players) {
    const spot = randomSpawnAwayFrom(taken);
    taken.push(spot);
    placePlayer(players[id], spot);
    players[id].itTime = 0;
    players[id].frozenSteps = 0;
    players[id].speedSteps = 0; // nobody carries a powerup into a new round
    players[id].jumpSteps = 0;
    players[id].inRound = true;
  }
  round.phase = "playing";
  round.endsAt = Date.now() + ROUND_LENGTH;
  round.winner = null;
  pickRandomIt();
}

function endRound() {
  // Only players who were here when the round started can win.
  // (Someone who joined late has had less chance to be "it", so they'd win unfairly.)
  let candidates = Object.values(players).filter((p) => p.inRound);
  if (candidates.length === 0) candidates = Object.values(players);

  // The winner is whoever spent the least time as "it".
  let best = candidates[0];
  for (const p of candidates) {
    if (p.itTime < best.itTime) best = p;
  }

  unfreezeEveryone();
  round.phase = "results";
  round.endsAt = Date.now() + RESULTS_TIME;
  round.itId = null;
  best.wins++;
  round.winner = { id: best.id, name: best.name, color: best.color, itTime: best.itTime };
}

function stopRound() {
  unfreezeEveryone();
  round.phase = "waiting";
  round.itId = null;
  round.winner = null;
}

// Between rounds nobody is "it", so nobody should stay frozen.
function unfreezeEveryone() {
  for (const id in players) players[id].frozenSteps = 0;
}

function isFrozen(player) {
  return player.frozenSteps > 0;
}

// The player pressed the tag key. If they're "it" (and can move), they get TAG_WINDOW milliseconds
// to touch someone (see updateRound). Anyone else pressing it does nothing.
function pressTag(player, now) {
  if (round.phase !== "playing" || player.id !== round.itId || isFrozen(player)) return;
  if (now < player.tagCooldownUntil) return;
  player.tagCooldownUntil = now + TAG_COOLDOWN;
  player.tagUntil = now + TAG_WINDOW;
}

// Do two players' squares overlap?
function touching(a, b) {
  return a.x < b.x + PLAYER_SIZE && a.x + PLAYER_SIZE > b.x &&
         a.y < b.y + PLAYER_SIZE && a.y + PLAYER_SIZE > b.y;
}

// ===== Tag rules: runs once per tick, after everyone has moved =====
function updateRound(now, elapsed) {
  // Not enough players: stop whatever was going on and wait.
  if (playerCount() < MIN_PLAYERS) {
    if (round.phase !== "waiting") stopRound();
    return;
  }

  // Enough players have joined: count down, so nobody is caught off guard by the round starting.
  // (If someone leaves during the countdown, the check above sends us back to waiting.)
  if (round.phase === "waiting") {
    round.phase = "starting";
    round.endsAt = now + START_COUNTDOWN;
    return;
  }

  // Countdown finished: start the first round.
  if (round.phase === "starting") {
    if (now >= round.endsAt) startRound();
    return;
  }

  // Show the winner until the results time is up, then go again.
  if (round.phase === "results") {
    if (now >= round.endsAt) startRound();
    return;
  }

  // From here on, a round is being played.
  if (now >= round.endsAt) {
    endRound();
    return;
  }

  const it = players[round.itId];

  // Count how long this player has been "it".
  it.itTime += elapsed;

  // A frozen "it" can't tag anyone, so whoever just tagged them gets a head start.
  if (isFrozen(it)) return;

  // "it" only tags someone shortly after pressing the tag key (see pressTag).
  if (now > it.tagUntil) return;

  for (const id in players) {
    if (id === it.id) continue;
    if (touching(it, players[id])) {
      it.tagUntil = 0; // that press is used up
      round.itId = id;
      players[id].frozenSteps = FREEZE_STEPS;
      break; // only one tag per tick
    }
  }
}

// Add a player who has just joined (with a name we've already checked) somewhere random,
// with no inputs yet. Then tell them who they are, and send the map so they can draw it
// and run the same physics for prediction. startTime lets them count ticks like we do.
function addPlayer(socket, name) {
  const spawn = randomSpawn();
  players[socket.id] = {
    id: socket.id,
    name,
    x: spawn.x, y: spawn.y,
    vx: 0, vy: 0,
    onGround: false,
    standingOn: -1,          // index in map.platforms of what they're standing on (-1 = nothing)
    jumpHeld: false,         // was jump held on their last step (for jump orbs, see physics.js)
    usedOrb: -1,             // index in map.orbs of the orb they just jumped off (-1 = none)
    speedSteps: 0,           // physics steps left on their speed powerup (0 = none)
    jumpSteps: 0,            // physics steps left on their jump powerup (0 = none)
    tick: currentTick(),     // the tick their last physics step ran on
    color: randomColor(),
    inputQueue: [],          // inputs received but not run yet, oldest first
    lastQueuedSeq: 0,        // number of the newest input put in the queue
    lastSeq: 0,              // number of the newest input actually run (sent back to the browser)
    stepCredit: 0,           // how many queued inputs we're allowed to run right now
    lastInputAt: Date.now(), // when we last heard from this browser
    itTime: 0,       // milliseconds spent as "it" this round
    frozenSteps: 0,  // can't move or tag for this many more of their physics steps
    tagUntil: 0,          // as "it", they tag anyone they touch until this time (see pressTag)
    tagCooldownUntil: 0,  // tag key presses before this time are ignored
    inRound: false,  // true if they were here when the round started (only they can win)
    spawns: 0,       // how many times they've been put at a new spot (see placePlayer)
    wins: 0,         // rounds won since they joined
  };
  withLag(() => socket.emit("init", { id: socket.id, map, startTime: START_TIME }));
}

// This runs once for every browser that connects.
io.on("connection", (socket) => {
  // 1. Nobody is in the game until their browser sends "join" with the name they typed
  //    (from the start screen). Then we check the name and add them somewhere random,
  //    or send back "join-rejected" if someone already has that name.
  //    A second "join" from the same browser is ignored.
  socket.on("join", (rawName) => withLag(() => {
    if (players[socket.id] || !socket.connected) return; // already in, or left while lagging
    const name = checkName(rawName);
    if (nameTaken(name)) {
      withLag(() => socket.emit("join-rejected", "Name taken"));
      return;
    }
    addPlayer(socket, name);
  }));

  // 2. The browser sends one numbered input for every physics step: { seq, tick, left, right, jump, tag }.
  //    (tag is true on the one step after the tag key was pressed.)
  //    We queue them up and the game loop runs them in order.
  //    We only trust true/false values — anything else counts as "not held".
  //    The number must be a whole number bigger than the last one, or we ignore the input.
  //    (With fake lag they might have left by the time this runs, or not joined yet — the !p check covers that.)
  socket.on("input", (input) => withLag(() => {
    const p = players[socket.id];
    if (!p || typeof input !== "object" || input === null) return;
    if (!Number.isSafeInteger(input.seq) || input.seq <= p.lastQueuedSeq) return;
    p.lastInputAt = Date.now();
    if (p.inputQueue.length >= MAX_QUEUED_INPUTS) return; // far too many waiting: drop it
    p.lastQueuedSeq = input.seq;
    p.inputQueue.push({
      seq: input.seq,
      tick: Number.isSafeInteger(input.tick) ? input.tick : null, // null = "use the current tick"
      left: input.left === true,
      right: input.right === true,
      jump: input.jump === true,
      tag: input.tag === true,
    });
  }));

  // 3. Ping: the browser sends the time it sent the ping, and we send that same number straight back.
  //    The browser subtracts it from the time the reply arrives to get the round trip.
  //    With fake lag, the ping waits once on the way in and once on the way out.
  socket.on("ping-check", (sentAt) => withLag(() => {
    withLag(() => socket.emit("pong-check", sentAt));
  }));

  // 4. When they press Menu (back to the start screen) or close the tab, remove them.
  //    After that they can press Play again, which sends a fresh "join".
  socket.on("leave", () => withLag(() => removePlayer(socket.id)));
  socket.on("disconnect", () => removePlayer(socket.id));
});

// Take a player out of the game. The next tick's state won't include them, so they vanish
// from everyone's screen. (Their wins go with them: if they come back, they start again from 0.)
function removePlayer(id) {
  if (!players[id]) return; // never joined, or already gone
  delete players[id];
  // If "it" left mid-round, pick someone else to be "it".
  // (If too few players are left, updateRound stops the round on the next tick.)
  if (round.phase === "playing" && round.itId === id && playerCount() > 0) {
    pickRandomIt();
  }
}

// ===== Game loop: 30 times per second, run everyone's inputs, apply the tag rules, then tell everyone =====
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const elapsed = now - lastTick; // real time since the last tick, for counting "it" time
  lastTick = now;

  for (const id in players) {
    const p = players[id];

    // Earn one step of credit for every STEP_MS of real time that passed (60 per second,
    // exactly the rate the browser sends inputs). Counting real time matters: ticks don't
    // arrive on schedule, so a fixed amount per tick would fall behind the browser.
    // Saving a few up lets us catch up when several inputs arrive at once (networks
    // are bumpy), but only up to MAX_STEP_CREDIT.
    p.stepCredit = Math.min(p.stepCredit + elapsed / STEP_MS, MAX_STEP_CREDIT);

    // Run waiting inputs in order, one physics step each, and remember the newest one we ran.
    // Each runs on the tick the browser ran it on (if that's within the allowed window).
    const nowTick = currentTick();
    while (p.inputQueue.length > 0 && p.stepCredit >= 1) {
      const input = p.inputQueue.shift();
      p.tick = allowedTick(input.tick === null ? nowTick : input.tick, nowTick);
      if (input.tag) pressTag(p, now);
      stepPlayer(p, input, map, p.tick);
      p.lastSeq = input.seq;
      p.stepCredit--;
    }

    // Haven't heard from this browser in a while: keep them falling with no keys held.
    if (p.inputQueue.length === 0 && now - p.lastInputAt > IDLE_MS) {
      while (p.stepCredit >= 1) {
        p.tick = allowedTick(p.tick + 1, nowTick);
        stepPlayer(p, NO_KEYS, map, p.tick);
        p.stepCredit--;
      }
    }
  }

  updateRound(now, elapsed);
  updatePowerups(now);

  // Send what browsers need to draw, plus what your own browser needs to redo its
  // prediction: vx, vy, onGround, standingOn, frozenSteps, jumpHeld, usedOrb, and the number of the last input we ran.
  const state = {
    time: now, // when this update happened (server's clock), so browsers can line updates up in time
    players: {},
    round: {
      phase: round.phase,
      timeLeft: Math.max(0, round.endsAt - Date.now()), // milliseconds left in this phase
      winner: round.winner,
    },
    powerups: powerups.slice(), // [{ id, type, x, y }, ...] (a copy, in case fake lag sends it after the list changes)
  };
  for (const id in players) {
    const p = players[id];
    state.players[id] = {
      x: p.x, y: p.y, color: p.color,
      it: id === round.itId,
      frozen: isFrozen(p),
      vx: p.vx, vy: p.vy, onGround: p.onGround, standingOn: p.standingOn, frozenSteps: p.frozenSteps,
      jumpHeld: p.jumpHeld, usedOrb: p.usedOrb, // (usedOrb also tells browsers to flash the orb)
      speedSteps: p.speedSteps, jumpSteps: p.jumpSteps,
      tick: p.tick, // so browsers can draw riders on a moving platform where it is right now
      lastSeq: p.lastSeq,
      spawns: p.spawns, // changes when they respawn, so browsers snap to the new spot
      // For the name labels and the scoreboard:
      name: p.name, itTime: p.itTime, wins: p.wins, inRound: p.inRound,
    };
  }
  withLag(() => io.emit("state", state));
}, 1000 / TICK_RATE);

// "0.0.0.0" means "accept connections from any network", not just this computer.
// Inside Docker that matters: otherwise only the container itself could connect.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Game running at http://localhost:${PORT}`);
});
