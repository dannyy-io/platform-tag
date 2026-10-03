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
const map = loadMap(MAP_FILE);

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
    if (p.type !== "solid" && p.type !== "platform") {
      throw new Error(file + ": platform " + i + ' has type "' + p.type + '", it must be "solid" or "platform"');
    }
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
    const spot = {
      x: p.x + Math.random() * (p.width - PLAYER_SIZE),
      y: p.y - PLAYER_SIZE,
    };
    const insideWorld = spot.x >= 0 && spot.y >= 0 && spot.x + PLAYER_SIZE <= map.width;
    const stuck = map.platforms.some((other) => other.type === "solid" && overlaps(spot, other));
    if (insideWorld && !stuck) return spot;
  }
  return { x: map.width / 2, y: 0 }; // couldn't find anywhere (strange map): drop in from the top middle
}

// ===== Tag rules =====
const ROUND_LENGTH = 60 * 1000; // how long a round lasts (milliseconds)
const FREEZE_TIME = 1.5 * 1000; // how long a newly tagged "it" can't move or tag (milliseconds)
// The freeze is counted in that player's physics steps (90 steps = 1.5 seconds),
// so the browser can predict exactly which of its inputs will be frozen.
const FREEZE_STEPS = Math.round(FREEZE_TIME / STEP_MS);
const RESULTS_TIME = 5 * 1000;  // how long the winner is shown before the next round (milliseconds)
const MIN_PLAYERS = 2;          // a round only runs with at least this many players

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
const NO_KEYS = { left: false, right: false, jump: false };

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

// Red is saved for "it", so normal players get any hue except the reds (roughly 0-30 and 330-360).
function randomColor() {
  return "hsl(" + Math.floor(30 + Math.random() * 300) + ", 80%, 55%)";
}

// ===== Round state =====
// phase is one of:
//   "waiting" - fewer than MIN_PLAYERS connected, nothing happens
//   "playing" - a round is running and someone is "it"
//   "results" - the round is over and the winner is being shown
const round = {
  phase: "waiting",
  itId: null,     // socket id of whoever is "it"
  endsAt: 0,      // when the current phase ends (a Date.now() time), for "playing" and "results"
  winner: null,   // { id, color, itTime } of the last round's winner, kept even if they leave
};

function playerCount() {
  return Object.keys(players).length;
}

function pickRandomIt() {
  const ids = Object.keys(players);
  round.itId = ids[Math.floor(Math.random() * ids.length)];
}

function startRound() {
  // Everyone starts the round with a clean slate.
  for (const id in players) {
    players[id].itTime = 0;
    players[id].frozenSteps = 0;
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
  round.winner = { id: best.id, color: best.color, itTime: best.itTime };
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

  // Enough players have joined: start the first round.
  if (round.phase === "waiting") {
    startRound();
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

  for (const id in players) {
    if (id === it.id) continue;
    if (touching(it, players[id])) {
      round.itId = id;
      players[id].frozenSteps = FREEZE_STEPS;
      break; // only one tag per tick
    }
  }
}

// This runs once for every browser that connects.
io.on("connection", (socket) => {
  // 1. Add the new player somewhere random, with no inputs yet
  const spawn = randomSpawn();
  players[socket.id] = {
    id: socket.id,
    x: spawn.x, y: spawn.y,
    vx: 0, vy: 0,
    onGround: false,
    color: randomColor(),
    inputQueue: [],          // inputs received but not run yet, oldest first
    lastQueuedSeq: 0,        // number of the newest input put in the queue
    lastSeq: 0,              // number of the newest input actually run (sent back to the browser)
    stepCredit: 0,           // how many queued inputs we're allowed to run right now
    lastInputAt: Date.now(), // when we last heard from this browser
    itTime: 0,       // milliseconds spent as "it" this round
    frozenSteps: 0,  // can't move or tag for this many more of their physics steps
    inRound: false,  // true if they were here when the round started (only they can win)
  };

  // 2. Tell the new player who they are, and send the map so they can draw it
  //    and run the same physics for prediction.
  withLag(() => socket.emit("init", { id: socket.id, map }));

  // 3. The browser sends one numbered input for every physics step: { seq, left, right, jump }.
  //    We queue them up and the game loop runs them in order.
  //    We only trust true/false values — anything else counts as "not held".
  //    The number must be a whole number bigger than the last one, or we ignore the input.
  //    (With fake lag they might have left by the time this runs — the !p check covers that.)
  socket.on("input", (input) => withLag(() => {
    const p = players[socket.id];
    if (!p || typeof input !== "object" || input === null) return;
    if (!Number.isSafeInteger(input.seq) || input.seq <= p.lastQueuedSeq) return;
    p.lastInputAt = Date.now();
    if (p.inputQueue.length >= MAX_QUEUED_INPUTS) return; // far too many waiting: drop it
    p.lastQueuedSeq = input.seq;
    p.inputQueue.push({
      seq: input.seq,
      left: input.left === true,
      right: input.right === true,
      jump: input.jump === true,
    });
  }));

  // 4. Ping: the browser sends the time it sent the ping, and we send that same number straight back.
  //    The browser subtracts it from the time the reply arrives to get the round trip.
  //    With fake lag, the ping waits once on the way in and once on the way out.
  socket.on("ping-check", (sentAt) => withLag(() => {
    withLag(() => socket.emit("pong-check", sentAt));
  }));

  // 5. When they close the tab, remove them. The next tick's state won't include them.
  socket.on("disconnect", () => {
    delete players[socket.id];
    // If "it" left mid-round, pick someone else to be "it".
    // (If too few players are left, updateRound stops the round on the next tick.)
    if (round.phase === "playing" && round.itId === socket.id && playerCount() > 0) {
      pickRandomIt();
    }
  });
});

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
    while (p.inputQueue.length > 0 && p.stepCredit >= 1) {
      const input = p.inputQueue.shift();
      stepPlayer(p, input, map);
      p.lastSeq = input.seq;
      p.stepCredit--;
    }

    // Haven't heard from this browser in a while: keep them falling with no keys held.
    if (p.inputQueue.length === 0 && now - p.lastInputAt > IDLE_MS) {
      while (p.stepCredit >= 1) {
        stepPlayer(p, NO_KEYS, map);
        p.stepCredit--;
      }
    }
  }

  updateRound(now, elapsed);

  // Send what browsers need to draw, plus what your own browser needs to redo its
  // prediction: vy, onGround, frozenSteps, and the number of the last input we ran.
  const state = {
    time: now, // when this update happened (server's clock), so browsers can line updates up in time
    players: {},
    round: {
      phase: round.phase,
      timeLeft: Math.max(0, round.endsAt - Date.now()), // milliseconds left in this phase
      winner: round.winner,
    },
  };
  for (const id in players) {
    const p = players[id];
    state.players[id] = {
      x: p.x, y: p.y, color: p.color,
      it: id === round.itId,
      frozen: isFrozen(p),
      vy: p.vy, onGround: p.onGround, frozenSteps: p.frozenSteps,
      lastSeq: p.lastSeq,
    };
  }
  withLag(() => io.emit("state", state));
}, 1000 / TICK_RATE);

// "0.0.0.0" means "accept connections from any network", not just this computer.
// Inside Docker that matters: otherwise only the container itself could connect.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Game running at http://localhost:${PORT}`);
});
