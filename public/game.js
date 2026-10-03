// ===== Tweakable constants (try changing these!) =====
const GRAVITY = 0.5;        // how much downward speed is added every frame
const JUMP_STRENGTH = 11;   // upward speed given when you jump
const MOVE_SPEED = 4;       // pixels moved left/right per frame

// ===== Setup =====
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d"); // the "pen" we draw with

// The player: position (x, y), size, and velocity (vx, vy = speed per frame)
const player = { x: 50, y: 300, width: 30, height: 30, vx: 0, vy: 0, onGround: false };

// Platforms are just rectangles. The first one is the floor.
const platforms = [
  { x: 0,   y: 420, width: 800, height: 30 },
  { x: 150, y: 340, width: 120, height: 15 },
  { x: 330, y: 270, width: 120, height: 15 },
  { x: 520, y: 200, width: 120, height: 15 },
  { x: 340, y: 130, width: 100, height: 15 },
];

// ===== Multiplayer =====
// Open a live connection to the server we were loaded from.
const socket = io();

// The other players, keyed by id: { "abc123": { id, x, y, color }, ... }
const otherPlayers = {};
let myColor = "#e63946"; // red until the server gives us our color

// The server tells us who's already here (this list includes us too).
socket.on("currentPlayers", (players) => {
  for (const id in players) {
    if (id === socket.id) myColor = players[id].color;
    else otherPlayers[id] = players[id];
  }
});

// Someone new joined after us.
socket.on("newPlayer", (p) => { otherPlayers[p.id] = p; });

// Someone else moved.
socket.on("playerMoved", (data) => {
  const p = otherPlayers[data.id];
  if (p) { p.x = data.x; p.y = data.y; }
});

// Someone left.
socket.on("playerLeft", (id) => { delete otherPlayers[id]; });

// ===== Keyboard input =====
// We remember which keys are currently held down.
const keys = {};
window.addEventListener("keydown", (e) => {
  keys[e.code] = true;
  // Stop arrow keys / space from scrolling the page
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(e.code)) e.preventDefault();
});
window.addEventListener("keyup", (e) => { keys[e.code] = false; });

// ===== Update: move things and apply the rules of physics =====
function update() {
  // 1. Left/right movement based on held keys
  player.vx = 0;
  if (keys["ArrowLeft"])  player.vx = -MOVE_SPEED;
  if (keys["ArrowRight"]) player.vx = MOVE_SPEED;

  // 2. Jump, but only if standing on something
  if (keys["Space"] && player.onGround) {
    player.vy = -JUMP_STRENGTH; // negative y means "up" on a canvas
  }

  // 3. Gravity: always pull downward a little more each frame
  player.vy += GRAVITY;

  // 4. Move horizontally, keeping the player inside the screen
  player.x += player.vx;
  player.x = Math.max(0, Math.min(canvas.width - player.width, player.x));

  // 5. Move vertically, then check for landing on platforms
  const previousBottom = player.y + player.height; // where our feet were before moving
  player.y += player.vy;
  player.onGround = false;

  for (const p of platforms) {
    const overlapsHorizontally = player.x + player.width > p.x && player.x < p.x + p.width;
    const feetNow = player.y + player.height;
    // Land only if falling AND our feet were above the platform top last frame
    // but are at or below it now (we "crossed" the top edge this frame).
    if (overlapsHorizontally && player.vy >= 0 && previousBottom <= p.y && feetNow >= p.y) {
      player.y = p.y - player.height; // snap feet onto the platform
      player.vy = 0;                  // stop falling
      player.onGround = true;
    }
  }
}

// ===== Draw: paint the current state onto the canvas =====
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height); // wipe last frame

  ctx.fillStyle = "#3a7d44"; // green platforms
  for (const p of platforms) ctx.fillRect(p.x, p.y, p.width, p.height);

  // Other players: same size squares, in their own colors
  for (const id in otherPlayers) {
    const p = otherPlayers[id];
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, player.width, player.height);
  }

  // Me, with a "you" label above my head
  ctx.fillStyle = myColor;
  ctx.fillRect(player.x, player.y, player.width, player.height);
  ctx.fillStyle = "#000";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("you", player.x + player.width / 2, player.y - 6);
}

// ===== Game loop: update, draw, repeat (about 60 times per second) =====
function gameLoop() {
  update();
  socket.emit("move", { x: player.x, y: player.y }); // tell the server where I am
  draw();
  requestAnimationFrame(gameLoop); // ask the browser to call us again next frame
}

gameLoop(); // start the game!
