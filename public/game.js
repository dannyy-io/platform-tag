// The browser's jobs: send the server a numbered input every physics step, guess ("predict")
// where our own player is going using the same physics as the server (physics.js),
// fix that guess whenever the server answers, and draw everything.
// The server is still the boss: it decides where everyone really is, and runs the tag rules.

// ===== Interpolation =====
// Other players are drawn this many milliseconds in the past, smoothly blended
// between the two server updates on either side of that moment.
// (Our own player is always drawn at the newest position.)
const INTERP_DELAY_MS = 100;

// Press I to switch interpolation on and off, to compare.
let interpolationOn = true;

// ===== Prediction =====
// Our own player moves the moment we press a key, instead of waiting for the server.
// Press P to switch prediction on and off, to compare.
let predictionOn = true;

// ===== Setup =====
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d"); // the "pen" we draw with

// ===== Multiplayer =====
// Open a live connection to the server we were loaded from.
const socket = io();

// Filled in by the server when we join.
let myId = null;

// The map ({ width, height, platforms }) comes from the server when we join.
// null until then. The player size comes from physics.js, the same file the server uses.
let map = null;
const playerSize = Physics.PLAYER_SIZE;

// ===== Camera =====
// The map is much bigger than the canvas, so we only draw the part around our player.
// camera.x / camera.y is the map position shown at the canvas's top-left corner.
// null until we know where our player is, so the first frame can jump straight there.
let camera = null;
// How quickly the camera catches up with the player. Bigger = snappier, smaller = floatier.
// Each second, the camera closes all but about e^-CAMERA_SPEED of the distance (8 means 99.97%).
const CAMERA_SPEED = 8;

// Every player's position and color, from the server's latest update:
// { "abc123": { x, y, color, it, frozen }, ... }
let players = {};

// What the tag round is doing, from the server's latest update:
// { phase: "waiting" | "playing" | "results", timeLeft, winner: { id, color, itTime } | null }
let round = { phase: "waiting", timeLeft: 0, winner: null };

// ===== Prediction state =====
// Every input we send gets the next number: 1, 2, 3, ...
let inputSeq = 0;
// Inputs we've sent that the server hasn't run yet, oldest first: [{ seq, left, right, jump }, ...]
let pendingInputs = [];
// Where we think our own player is right now: { x, y, vx, vy, onGround, frozenSteps }.
// null until the first update from the server (we need its starting point).
let predicted = null;

// When we join, the server tells us our id and sends the map.
// (If we reconnect we get a new id and a new spawn spot, so start fresh.)
socket.on("init", (data) => {
  myId = data.id;
  map = data.map;
  inputSeq = 0;
  pendingInputs = [];
  predicted = null;
  camera = null;
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

  reconcile(state.players[myId]);
});

// ===== Reconciliation: fix our guess using the server's answer =====
// The server's position for us is a little old: it only includes inputs up to number "lastSeq".
// So we start from the server's position and quickly redo every input it hasn't run yet.
// If our guesses were right, we end up exactly where we already were, so nothing visibly changes.
function reconcile(me) {
  if (!me || !map) return;

  // The server has run these already, so we never need them again.
  pendingInputs = pendingInputs.filter((input) => input.seq > me.lastSeq);

  if (!predictionOn) return;

  // 1. Go back to where the server says we were...
  predicted = {
    x: me.x, y: me.y,
    vx: 0, vy: me.vy,
    onGround: me.onGround,
    frozenSteps: me.frozenSteps,
  };
  // 2. ...then replay every input the server hasn't got to yet.
  for (const input of pendingInputs) Physics.stepPlayer(predicted, input, map);
}

// ===== Fixed time step =====
// Physics runs in steps of exactly Physics.STEP_MS (60 per second), the same as the server,
// no matter how fast this screen redraws. We save up real time and spend it one step at a time.
let lastFrameTime = performance.now();
let unspentTime = 0;

function runPhysicsSteps() {
  const now = performance.now();
  unspentTime += now - lastFrameTime;
  lastFrameTime = now;

  // If the tab was hidden for a while, don't try to catch up hundreds of steps at once.
  // (The server kept us moving meanwhile; the next update will put us in the right place.)
  if (unspentTime > 250) unspentTime = Physics.STEP_MS;

  while (unspentTime >= Physics.STEP_MS) {
    physicsStep();
    unspentTime -= Physics.STEP_MS;
  }
}

// One step: number the keys we're holding, send them, and apply them to our own player right away.
function physicsStep() {
  if (myId === null) return; // not joined yet

  inputSeq++;
  const stepInput = { seq: inputSeq, left: input.left, right: input.right, jump: input.jump };
  socket.emit("input", stepInput);
  pendingInputs.push(stepInput);

  // Normally the server answers long before this fills up. This just stops it growing forever.
  if (pendingInputs.length > 120) pendingInputs.shift();

  if (predictionOn && predicted) Physics.stepPlayer(predicted, stepInput, map);
}

// Where every player should be drawn right now.
function playersToDraw() {
  const result = otherPlayersToDraw();

  // Our own player: with prediction, draw our guess (no waiting for the server).
  // Without it, draw the newest position the server sent.
  const mine = players[myId];
  if (mine && predictionOn && predicted) {
    result[myId] = { ...mine, x: predicted.x, y: predicted.y, frozen: predicted.frozenSteps > 0 };
  } else if (mine) {
    result[myId] = mine;
  }
  return result;
}

// Everyone except us: drawn a little in the past, blended between server updates (interpolation).
function otherPlayersToDraw() {
  if (!interpolationOn || snapshots.length === 0) return { ...players };

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
    if (id === myId) continue; // ours is handled in playersToDraw
    const a = before.players[id];
    const b = after.players[id];
    if (!a) { result[id] = b; continue; } // just joined: nothing to blend from yet
    result[id] = {
      ...b, // color, "it" and "frozen" from the newer update
      x: a.x + (b.x - a.x) * amount,
      y: a.y + (b.y - a.y) * amount,
    };
  }
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
// Several keys can do the same thing (A or the left arrow both move left).
const keyToAction = { ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right", Space: "jump" };

// Every key code currently held down.
const heldKeys = new Set();

// Just remember what's held. physicsStep() sends it to the server every step.
// An action is on while ANY of its keys is held, so letting go of A while still
// holding the left arrow keeps you moving left.
function setKey(code, held) {
  const action = keyToAction[code];
  if (!action) return;
  if (held) heldKeys.add(code);
  else heldKeys.delete(code);
  input[action] = [...heldKeys].some((k) => keyToAction[k] === action);
}

window.addEventListener("keydown", (e) => {
  // I toggles interpolation. (e.repeat is true for the repeats from holding the key down.)
  if (e.code === "KeyI" && !e.repeat) interpolationOn = !interpolationOn;
  // P toggles prediction. Turning it off forgets our guess; turning it back on
  // rebuilds it from the next server update.
  if (e.code === "KeyP" && !e.repeat) {
    predictionOn = !predictionOn;
    predicted = null;
  }
  setKey(e.code, true);
  // Stop arrow keys / space from scrolling the page
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(e.code)) e.preventDefault();
});
window.addEventListener("keyup", (e) => { setKey(e.code, false); });

// If the window loses focus we'd never see the "keyup", so let go of everything.
window.addEventListener("blur", () => {
  for (const code in keyToAction) setKey(code, false);
});

// ===== Camera: smoothly follow our own player =====
// dt is how many seconds passed since the last frame.
function updateCamera(me, dt) {
  // Where the camera wants to be: our player in the middle of the canvas...
  let targetX = me.x + playerSize / 2 - canvas.width / 2;
  let targetY = me.y + playerSize / 2 - canvas.height / 2;
  // ...but never showing past the map's edges.
  targetX = Math.max(0, Math.min(map.width - canvas.width, targetX));
  targetY = Math.max(0, Math.min(map.height - canvas.height, targetY));

  if (camera === null) {
    camera = { x: targetX, y: targetY }; // first frame: jump straight there
    return;
  }

  // Move part of the way toward the target each frame. The further behind it is, the faster
  // it moves, so it glides to a stop. Using dt keeps it the same speed at any frame rate.
  const amount = 1 - Math.exp(-CAMERA_SPEED * dt);
  camera.x += (targetX - camera.x) * amount;
  camera.y += (targetY - camera.y) * amount;
}

// ===== Draw: run any physics steps that are due, then paint the world =====
let lastDrawTime = performance.now();

function draw() {
  runPhysicsSteps();

  const now = performance.now();
  const dt = Math.min(0.1, (now - lastDrawTime) / 1000); // seconds (capped, in case the tab was hidden)
  lastDrawTime = now;

  ctx.clearRect(0, 0, canvas.width, canvas.height); // wipe last frame

  if (map) drawWorld(dt);

  drawRoundInfo();
  drawPing();

  requestAnimationFrame(draw); // ask the browser to call us again next frame
}

// Everything that lives on the map (platforms and players), drawn through the camera.
function drawWorld(dt) {
  const drawn = playersToDraw();
  if (drawn[myId]) updateCamera(drawn[myId], dt);
  if (camera === null) return; // we haven't appeared yet

  // Shift everything we draw from now on by the camera position. A platform at map x = 1000
  // with the camera at x = 900 lands at canvas x = 100. Rounding to whole pixels keeps
  // edges crisp instead of blurry while the camera glides.
  ctx.save();
  ctx.translate(-Math.round(camera.x), -Math.round(camera.y));

  for (const p of map.platforms) {
    ctx.fillStyle = p.type === "solid" ? "#6b4f3a" : "#3a7d44"; // brown solid blocks, green platforms
    ctx.fillRect(p.x, p.y, p.width, p.height);
  }

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

  // Back to normal canvas coordinates, so the timer and ping stay fixed on screen.
  ctx.restore();
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
  ctx.fillText("prediction: " + (predictionOn ? "ON" : "OFF") + " (press P)", 8, 50);
}

draw(); // start drawing!
