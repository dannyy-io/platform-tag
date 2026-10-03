// ===== Tweakable constants (try changing these!) =====
const GRAVITY = 0.5;        // how much downward speed is added every physics step
const JUMP_STRENGTH = 11;   // upward speed given when you jump
const MOVE_SPEED = 4;       // pixels moved left/right per physics step

// ===== Tag rules =====
const ROUND_LENGTH = 60 * 1000; // how long a round lasts (milliseconds)
const FREEZE_TIME = 1.5 * 1000; // how long a newly tagged "it" can't move or tag (milliseconds)
const RESULTS_TIME = 5 * 1000;  // how long the winner is shown before the next round (milliseconds)
const MIN_PLAYERS = 2;          // a round only runs with at least this many players

// How often the server updates the world and tells everyone about it.
const TICK_RATE = 30; // ticks per second
// The constants above were tuned for 60 steps per second, so each tick runs
// the physics twice. That keeps the game feeling exactly the same as before.
const STEPS_PER_TICK = 2;

const WORLD_WIDTH = 800;  // must match the canvas width in index.html
const PLAYER_SIZE = 30;

// A tiny web server. It sends the files in "public" to the browser,
// runs the game itself, and sends the results to every browser using Socket.IO.
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const PORT = 3000;

// Any file inside the "public" folder can be requested by the browser.
// Visiting http://localhost:3000/ serves public/index.html automatically.
app.use(express.static("public"));

// Socket.IO needs the raw HTTP server that Express runs on, so we create it ourselves.
const server = http.createServer(app);
const io = new Server(server);

// Platforms are just rectangles. The first one is the floor.
// They live on the server now, and each player is sent a copy when they join.
const platforms = [
  { x: 0,   y: 420, width: 800, height: 30 },
  { x: 150, y: 340, width: 120, height: 15 },
  { x: 330, y: 270, width: 120, height: 15 },
  { x: 520, y: 200, width: 120, height: 15 },
  { x: 340, y: 130, width: 100, height: 15 },
];

// Everyone currently connected, keyed by their socket id.
// Each player has a position (x, y), a velocity (vx, vy), and the keys they're holding.
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
    players[id].frozenUntil = 0;
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
  for (const id in players) players[id].frozenUntil = 0;
}

function isFrozen(player, now) {
  return now < player.frozenUntil;
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
  if (isFrozen(it, now)) return;

  for (const id in players) {
    if (id === it.id) continue;
    if (touching(it, players[id])) {
      round.itId = id;
      players[id].frozenUntil = now + FREEZE_TIME;
      break; // only one tag per tick
    }
  }
}

// ===== Physics: move one player one step, using the keys they're holding =====
function stepPlayer(player, frozen) {
  // 1. Left/right movement based on held keys (a frozen player's keys do nothing)
  player.vx = 0;
  if (!frozen && player.input.left)  player.vx = -MOVE_SPEED;
  if (!frozen && player.input.right) player.vx = MOVE_SPEED;

  // 2. Jump, but only if standing on something
  if (!frozen && player.input.jump && player.onGround) {
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

  for (const p of platforms) {
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

// This runs once for every browser that connects.
io.on("connection", (socket) => {
  // 1. Add the new player, holding no keys
  players[socket.id] = {
    id: socket.id,
    x: 50, y: 300,
    vx: 0, vy: 0,
    onGround: false,
    color: randomColor(),
    input: { left: false, right: false, jump: false },
    itTime: 0,       // milliseconds spent as "it" this round
    frozenUntil: 0,  // can't move or tag until this Date.now() time
    inRound: false,  // true if they were here when the round started (only they can win)
  };

  // 2. Tell the new player who they are and what the level looks like
  socket.emit("init", { id: socket.id, platforms, playerSize: PLAYER_SIZE });

  // 3. Whenever this player presses or releases a key, remember it.
  //    We only trust true/false values — anything else counts as "not held".
  socket.on("input", (input) => {
    const p = players[socket.id];
    if (!p || typeof input !== "object" || input === null) return;
    p.input.left  = input.left === true;
    p.input.right = input.right === true;
    p.input.jump  = input.jump === true;
  });

  // 4. When they close the tab, remove them. The next tick's state won't include them.
  socket.on("disconnect", () => {
    delete players[socket.id];
    // If "it" left mid-round, pick someone else to be "it".
    // (If too few players are left, updateRound stops the round on the next tick.)
    if (round.phase === "playing" && round.itId === socket.id && playerCount() > 0) {
      pickRandomIt();
    }
  });
});

// ===== Game loop: 30 times per second, move everyone, apply the tag rules, then tell everyone =====
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const elapsed = now - lastTick; // real time since the last tick, for counting "it" time
  lastTick = now;

  for (const id in players) {
    const frozen = isFrozen(players[id], now);
    for (let i = 0; i < STEPS_PER_TICK; i++) stepPlayer(players[id], frozen);
  }

  updateRound(now, elapsed);

  // Send only what browsers need to draw (not velocities, inputs, or timers).
  const state = {
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
      frozen: isFrozen(p, now),
    };
  }
  io.emit("state", state);
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Game running at http://localhost:${PORT}`);
});
