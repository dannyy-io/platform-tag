// ===== Tweakable constants (try changing these!) =====
const GRAVITY = 0.5;        // how much downward speed is added every physics step
const JUMP_STRENGTH = 11;   // upward speed given when you jump
const MOVE_SPEED = 4;       // pixels moved left/right per physics step

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

function randomColor() {
  return "hsl(" + Math.floor(Math.random() * 360) + ", 80%, 55%)";
}

// ===== Physics: move one player one step, using the keys they're holding =====
function stepPlayer(player) {
  // 1. Left/right movement based on held keys
  player.vx = 0;
  if (player.input.left)  player.vx = -MOVE_SPEED;
  if (player.input.right) player.vx = MOVE_SPEED;

  // 2. Jump, but only if standing on something
  if (player.input.jump && player.onGround) {
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
  });
});

// ===== Game loop: 30 times per second, move everyone, then tell everyone =====
setInterval(() => {
  for (const id in players) {
    for (let i = 0; i < STEPS_PER_TICK; i++) stepPlayer(players[id]);
  }

  // Send only what browsers need to draw (not velocities or inputs).
  const state = {};
  for (const id in players) {
    const p = players[id];
    state[id] = { x: p.x, y: p.y, color: p.color };
  }
  io.emit("state", state);
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Game running at http://localhost:${PORT}`);
});
