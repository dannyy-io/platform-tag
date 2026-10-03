// The browser's only jobs now: tell the server which keys are held,
// and draw whatever the server says the world looks like.
// All the physics (gravity, jumping, platforms) happens on the server.

// ===== Setup =====
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d"); // the "pen" we draw with

// ===== Multiplayer =====
// Open a live connection to the server we were loaded from.
const socket = io();

// Filled in by the server when we join.
let myId = null;
let platforms = [];
let playerSize = 30;

// Every player's position and color, from the server's latest update:
// { "abc123": { x, y, color }, ... }
let players = {};

// When we join, the server tells us our id and what the level looks like.
socket.on("init", (data) => {
  myId = data.id;
  platforms = data.platforms;
  playerSize = data.playerSize;
});

// 30 times per second, the server sends where everyone is. We just keep the newest copy.
socket.on("state", (state) => { players = state; });

// ===== Keyboard input =====
// Which of our three actions are being held right now.
const input = { left: false, right: false, jump: false };

// Which keyboard key controls which action.
const keyToAction = { ArrowLeft: "left", ArrowRight: "right", Space: "jump" };

function setKey(code, held) {
  const action = keyToAction[code];
  if (!action) return;
  // Only tell the server when something actually changes.
  // (Holding a key makes the browser repeat "keydown" over and over — we ignore those.)
  if (input[action] === held) return;
  input[action] = held;
  socket.emit("input", input);
}

window.addEventListener("keydown", (e) => {
  setKey(e.code, true);
  // Stop arrow keys / space from scrolling the page
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(e.code)) e.preventDefault();
});
window.addEventListener("keyup", (e) => { setKey(e.code, false); });

// If the window loses focus we'd never see the "keyup", so let go of everything.
window.addEventListener("blur", () => {
  for (const code in keyToAction) setKey(code, false);
});

// ===== Draw: paint whatever the server last told us =====
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height); // wipe last frame

  ctx.fillStyle = "#3a7d44"; // green platforms
  for (const p of platforms) ctx.fillRect(p.x, p.y, p.width, p.height);

  for (const id in players) {
    const p = players[id];
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, p.y, playerSize, playerSize);

    // Put a "you" label above our own square
    if (id === myId) {
      ctx.fillStyle = "#000";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("you", p.x + playerSize / 2, p.y - 6);
    }
  }

  requestAnimationFrame(draw); // ask the browser to call us again next frame
}

draw(); // start drawing!
