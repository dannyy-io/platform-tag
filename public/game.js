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
// { "abc123": { x, y, color, it, frozen }, ... }
let players = {};

// What the tag round is doing, from the server's latest update:
// { phase: "waiting" | "playing" | "results", timeLeft, winner: { id, color, itTime } | null }
let round = { phase: "waiting", timeLeft: 0, winner: null };

// When we join, the server tells us our id and what the level looks like.
socket.on("init", (data) => {
  myId = data.id;
  platforms = data.platforms;
  playerSize = data.playerSize;
});

// 30 times per second, the server sends where everyone is and how the round is going.
// We just keep the newest copy. (All the tag rules run on the server.)
socket.on("state", (state) => {
  players = state.players;
  round = state.round;
});

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
    // Whoever is "it" is drawn in red. A frozen "it" is see-through until they can move.
    ctx.globalAlpha = p.frozen ? 0.5 : 1;
    ctx.fillStyle = p.it ? "red" : p.color;
    ctx.fillRect(p.x, p.y, playerSize, playerSize);
    ctx.globalAlpha = 1;

    // Labels stack upward above the square: "you" first, then "IT" above that.
    ctx.textAlign = "center";
    let labelY = p.y - 6;
    if (id === myId) {
      ctx.fillStyle = "#000";
      ctx.font = "12px sans-serif";
      ctx.fillText("you", p.x + playerSize / 2, labelY);
      labelY -= 14;
    }
    if (p.it) {
      ctx.fillStyle = "red";
      ctx.font = "bold 14px sans-serif";
      ctx.fillText("IT", p.x + playerSize / 2, labelY);
    }
  }

  drawRoundInfo();

  requestAnimationFrame(draw); // ask the browser to call us again next frame
}

// ===== Round info at the top of the screen: timer, waiting message, or winner =====
function drawRoundInfo() {
  ctx.textAlign = "center";
  ctx.fillStyle = "#000";
  ctx.font = "bold 20px sans-serif";
  const centerX = canvas.width / 2;

  if (round.phase === "waiting") {
    ctx.fillText("Waiting for another player...", centerX, 30);
  } else if (round.phase === "playing") {
    // Show time left as m:ss, e.g. 0:42
    const seconds = Math.ceil(round.timeLeft / 1000);
    const m = Math.floor(seconds / 60);
    const s = String(seconds % 60).padStart(2, "0");
    ctx.fillText(m + ":" + s, centerX, 30);
  } else if (round.phase === "results" && round.winner) {
    const w = round.winner;
    const itSeconds = (w.itTime / 1000).toFixed(1);
    const text = w.id === myId ? "You win!" : "Winner:";
    ctx.fillText(text, centerX - 20, 30);
    // A square in the winner's color, since players don't have names
    ctx.fillStyle = w.color;
    ctx.fillRect(centerX + ctx.measureText(text).width / 2 - 8, 12, 22, 22);
    ctx.fillStyle = "#000";
    ctx.font = "14px sans-serif";
    ctx.fillText("(only " + itSeconds + "s as IT) - next round soon", centerX, 54);
  }
}

draw(); // start drawing!
