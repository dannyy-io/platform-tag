// The browser's only jobs now: tell the server which keys are held,
// and draw whatever the server says the world looks like.
// All the physics (gravity, jumping, platforms) happens on the server.

// ===== Interpolation =====
// Other players are drawn this many milliseconds in the past, smoothly blended
// between the two server updates on either side of that moment.
// (Our own player is always drawn at the newest position.)
const INTERP_DELAY_MS = 100;

// Press I to switch interpolation on and off, to compare.
let interpolationOn = true;

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

// Recent updates from the server, oldest first: [{ time, players }, ...]
// Interpolation looks back through these to find where other players were.
const snapshots = [];

// The server's clock and ours don't match, so we keep track of the difference:
// server time ≈ Date.now() + serverTimeOffset.
// (It also includes how long updates take to reach us, which is exactly what we want:
// "server now" really means "the newest update we could have by now".)
let serverTimeOffset = null; // null until the first update arrives

// The moment in server time that other players are drawn at.
function renderTime() {
  return Date.now() + serverTimeOffset - INTERP_DELAY_MS;
}

// 30 times per second, the server sends where everyone is and how the round is going.
// (All the tag rules run on the server.)
socket.on("state", (state) => {
  players = state.players; // the newest copy, used for our own player
  round = state.round;

  // Update our guess of the clock difference. Each update arrives a little early or late,
  // so we only move the guess 10% of the way each time. That keeps it from jittering.
  const offset = state.time - Date.now();
  if (serverTimeOffset === null) serverTimeOffset = offset;
  else serverTimeOffset += (offset - serverTimeOffset) * 0.1;

  snapshots.push({ time: state.time, players: state.players });

  // Throw away updates we'll never need again. We keep exactly one update
  // older than the render time, since we blend from it toward the next one.
  while (snapshots.length > 2 && snapshots[1].time <= renderTime()) snapshots.shift();
});

// Where every player should be drawn right now.
function playersToDraw() {
  if (!interpolationOn || snapshots.length === 0) return players;

  const t = renderTime();

  // Find the two updates either side of time t: "before" and "after".
  // If t is past our newest update (e.g. a lag spike), we just use the newest one.
  let before = snapshots[0];
  let after = snapshots[0];
  for (const snap of snapshots) {
    after = snap;
    if (snap.time >= t) break;
    before = snap;
  }

  // How far t is from "before" to "after": 0 = exactly at before, 1 = exactly at after.
  const span = after.time - before.time;
  const amount = span > 0 ? Math.min(1, Math.max(0, (t - before.time) / span)) : 1;

  const result = {};
  for (const id in after.players) {
    if (id === myId) continue; // ours comes from the newest update, below
    const a = before.players[id];
    const b = after.players[id];
    if (!a) { result[id] = b; continue; } // just joined: nothing to blend from yet
    result[id] = {
      ...b, // color, "it" and "frozen" from the newer update
      x: a.x + (b.x - a.x) * amount,
      y: a.y + (b.y - a.y) * amount,
    };
  }
  // Our own player is never delayed: we want to see our keys take effect as soon as possible.
  if (players[myId]) result[myId] = players[myId];
  return result;
}

// ===== Ping =====
// Every second, send the server the current time. It sends the same number back,
// so (now - that number) is how long the round trip took.
let pingMs = null; // null until the first reply arrives

setInterval(() => {
  socket.emit("ping-check", Date.now());
}, 1000);

socket.on("pong-check", (sentAt) => {
  pingMs = Date.now() - sentAt;
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
  // I toggles interpolation. (e.repeat is true for the repeats from holding the key down.)
  if (e.code === "KeyI" && !e.repeat) interpolationOn = !interpolationOn;
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

  const drawn = playersToDraw();
  for (const id in drawn) {
    const p = drawn[id];
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
  drawPing();

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

// ===== Ping in the top-left corner =====
function drawPing() {
  ctx.textAlign = "left";
  ctx.fillStyle = "#000";
  ctx.font = "12px sans-serif";
  ctx.fillText("ping: " + (pingMs === null ? "--" : pingMs) + " ms", 8, 18);
  ctx.fillText("interpolation: " + (interpolationOn ? "ON" : "OFF") + " (press I)", 8, 34);
}

draw(); // start drawing!
