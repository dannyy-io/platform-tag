// The browser's jobs: send the server a numbered input every physics step, guess ("predict")
// where our own player is going using the same physics as the server (physics.js),
// fix that guess whenever the server answers, and draw everything.
// The server is still the boss: it decides where everyone really is, and runs the tag rules.

// ===== Visual effects (try changing these!) =====
// These are only for looks: they all happen in the browser and never touch the physics.
const SHAKE_STRENGTH = 4;        // how far (pixels) the screen jumps when you tag or get tagged
const SHAKE_DURATION = 0.25;     // how long the shake lasts, in seconds (it fades out)
const LAND_DUST_COUNT = 6;       // dust puffs when landing from a full-height fall (smaller falls make fewer)
const RUN_DUST_CHANCE = 0.3;     // chance (0 to 1) of a dust puff on each running footstep
const TAG_SPLASH_COUNT = 18;     // paint drops splashed in the tagged player's color
const JUMPPAD_BURST_COUNT = 10;  // sparks when someone bounces off a jump pad
const WIN_CONFETTI_COUNT = 40;   // confetti pieces that pop out of the winner when a round ends
const MAX_PARTICLES = 300;       // never keep more than this many at once, just in case
const SPLAT_LIFETIME = 4;        // seconds a landing paint splat takes to fade away completely
const TIMER_WARNING_SECONDS = 5; // the round timer turns red when this many seconds (or fewer) are left
const JUMPPAD_SQUISH_PUSH = 10;  // how hard a bounce squashes a jump pad's spring (bigger = deeper squash, bigger boing)
const MAX_SPLATS = 80;           // never keep more splats than this (the oldest go first)

// ===== Doodle style =====
// The world is drawn like a doodle on notebook paper, to match the characters.
const PAPER_COLOR = "#faf8f2";                 // off-white paper
const GRID_COLOR = "rgba(90, 140, 200, 0.12)"; // very faint blue notebook grid
const GRID_SIZE = 32;                          // pixels between grid lines
const INK = "#000";                            // outline color, the same as the characters'
const OUTLINE_WIDTH = 3;                       // outline thickness, the same as the characters'

// ===== Interpolation =====
// Other players are drawn this many milliseconds in the past, smoothly blended
// between the two server updates on either side of that moment.
// (Our own player is always drawn at the newest position.)
const INTERP_DELAY_MS = 100;

// Switched on and off with the checkbox on the start screen, to compare.
let interpolationOn = true;

// ===== Prediction =====
// Our own player moves the moment we press a key, instead of waiting for the server.
// Switched on and off with the checkbox on the start screen, to compare.
let predictionOn = true;

// ===== Setup =====
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d"); // the "pen" we draw with

// ===== Join screen =====
// We aren't in the game until we type a name and press Play (see index.html).
// The server checks the name and swaps in "Player" plus a number if it isn't allowed.
const joinScreen = document.getElementById("join-screen");
const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name-input");

// The name we joined with, or null before pressing Play.
let myName = null;

// Remember the last name typed in this browser, to save typing it again next time.
// (Browser storage can be switched off, so this is only a convenience.)
try { nameInput.value = localStorage.getItem("platform-tag-name") || ""; } catch (e) {}
nameInput.focus();

// The prediction and interpolation checkboxes. They start ticked; we read them when Play is pressed.
const predictionOption = document.getElementById("prediction-option");
const interpolationOption = document.getElementById("interpolation-option");

joinForm.addEventListener("submit", (e) => {
  e.preventDefault(); // don't reload the page
  myName = nameInput.value;
  try { localStorage.setItem("platform-tag-name", myName); } catch (e) {}
  predictionOn = predictionOption.checked;
  interpolationOn = interpolationOption.checked;
  nameInput.blur();
  joinScreen.classList.add("hidden");
  quitButton.classList.remove("hidden");
  if (socket.connected) socket.emit("join", myName);
  // (If we aren't connected yet, the "connect" handler below joins as soon as we are.)
});

// ===== Quit: back to the start screen =====
// The server takes our character out of the game, so it disappears for everyone.
// Pressing Play again joins as a brand new player (new spot, wins back to 0).
const quitButton = document.getElementById("quit-button");

quitButton.addEventListener("click", () => {
  socket.emit("leave");
  myName = null;  // so a reconnect doesn't join us again
  myId = null;    // stops sending inputs (see physicsStep)
  predicted = null;
  predictedPrev = null;
  pendingInputs = [];
  camera = null;
  mySpawns = null;
  for (const code in keyToAction) setKey(code, false); // let go of every key
  quitButton.classList.add("hidden");
  joinScreen.classList.remove("hidden");
  nameInput.focus();
});

// ===== Multiplayer =====
// Open a live connection to the server we were loaded from.
const socket = io();

// Whenever we (re)connect after pressing Play, join with our name. If the connection drops,
// Socket.IO reconnects by itself, but the server sees a brand new player who has to join again.
socket.on("connect", () => {
  if (myName !== null) socket.emit("join", myName);
});

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
// Inputs we've sent that the server hasn't run yet, oldest first: [{ seq, tick, left, right, jump }, ...]
let pendingInputs = [];
// Where we think our own player is right now: { x, y, vx, vy, onGround, standingOn, frozenSteps }.
// null until the first update from the server (we need its starting point).
let predicted = null;
// Where our player was one physics step before "predicted": { x, y }. We draw somewhere between
// the two (see smoothPredicted), so we glide smoothly even on screens faster than 60 frames a second.
let predictedPrev = null;

// ===== Ticks =====
// Moving platforms are positioned by tick number (see platformPosition in physics.js).
// The server counts ticks from the moment it started, and tells us when that was.
let serverStartTime = null;
// The tick our latest physics step ran on. It goes up by exactly 1 every step, so a platform
// we're riding moves smoothly, and every input we send is labelled with it.
let currentTick = null;
// If our count drifts this many ticks away from the server's clock (e.g. the tab was hidden),
// we jump straight to the right tick instead.
const TICK_RESYNC = 10;

// Which tick the server's clock is on, as far as we can tell.
function estimatedServerTick() {
  return Math.floor((Date.now() + serverTimeOffset - serverStartTime) / Physics.STEP_MS);
}

// When we join, the server tells us our id, sends the map, and says when it started.
// (If we reconnect we get a new id and a new spawn spot, so start fresh.)
socket.on("init", (data) => {
  myId = data.id;
  map = data.map;
  serverStartTime = data.startTime;
  currentTick = null;
  inputSeq = 0;
  pendingInputs = [];
  predicted = null;
  camera = null;
  mySpawns = null;
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
  noticeTag(players, round, state.players, state.round);
  noticeWin(round, state.players, state.round);
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

// How many times the server has respawned us, from its latest update. null until the first one.
let mySpawns = null;

// ===== Reconciliation: fix our guess using the server's answer =====
// The server's position for us is a little old: it only includes inputs up to number "lastSeq".
// So we start from the server's position and quickly redo every input it hasn't run yet.
// If our guesses were right, we end up exactly where we already were, so nothing visibly changes.
function reconcile(me) {
  if (!me || !map) return;

  // We were just respawned somewhere new (a new round started): jump the camera straight
  // there instead of sliding it across the whole map.
  if (mySpawns !== null && me.spawns !== mySpawns) camera = null;
  mySpawns = me.spawns;

  // The server has run these already, so we never need them again.
  pendingInputs = pendingInputs.filter((input) => input.seq > me.lastSeq);

  if (!predictionOn) return;

  const before = predicted; // our guess before this answer (null the first time)

  // 1. Go back to where the server says we were...
  predicted = {
    x: me.x, y: me.y,
    vx: me.vx, vy: me.vy,
    onGround: me.onGround,
    standingOn: me.standingOn,
    frozenSteps: me.frozenSteps,
  };
  // 2. ...then replay every input the server hasn't got to yet, each on the same tick as before.
  for (const input of pendingInputs) {
    Physics.stepPlayer(predicted, input, map, input.tick);
  }

  // 3. We're drawn partway between predictedPrev (one step ago) and predicted (see smoothPredicted).
  //    Move predictedPrev by however much the server's answer moved our guess: if we guessed right,
  //    that's nothing at all, so the smooth drawing carries on undisturbed.
  //    (It can't be rebuilt from the replay: with a fast connection the server has often run every
  //    input already, so there's nothing to replay. Then predictedPrev ended up equal to predicted,
  //    which drew us a step ahead until the next step, then back: a jitter every server update.)
  if (before && predictedPrev) {
    predictedPrev = {
      x: predictedPrev.x + (predicted.x - before.x),
      y: predictedPrev.y + (predicted.y - before.y),
    };
  } else {
    predictedPrev = { x: predicted.x, y: predicted.y };
  }
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
  if (myId === null || serverTimeOffset === null) return; // not joined yet, or no clock yet

  // Move on to the next tick, unless we've drifted from the server's clock.
  const serverTick = estimatedServerTick();
  if (currentTick === null || Math.abs(serverTick - currentTick) > TICK_RESYNC) currentTick = serverTick;
  else currentTick++;

  inputSeq++;
  const stepInput = { seq: inputSeq, tick: currentTick, left: input.left, right: input.right, jump: input.jump };
  socket.emit("input", stepInput);
  pendingInputs.push(stepInput);

  // Normally the server answers long before this fills up. This just stops it growing forever.
  if (pendingInputs.length > 120) pendingInputs.shift();

  if (predictionOn && predicted) {
    predictedPrev = { x: predicted.x, y: predicted.y };
    Physics.stepPlayer(predicted, stepInput, map, currentTick);
  }
}

// How far we are through the current physics step: 0 = it just ran, nearly 1 = the next is due.
function stepFraction() {
  return Math.min(1, Math.max(0, unspentTime / Physics.STEP_MS));
}

// Our predicted position only changes 60 times a second, but the screen may redraw more often
// (or at uneven moments). Drawing it straight away would make it move in uneven jerks.
// Instead we draw it partway between the last two steps, by how far we are through this step.
// That draws us at most one step (1/60 s) behind, but moving perfectly smoothly.
function smoothPredicted() {
  if (!predictedPrev) return { x: predicted.x, y: predicted.y };
  const t = stepFraction();
  return {
    x: predictedPrev.x + (predicted.x - predictedPrev.x) * t,
    y: predictedPrev.y + (predicted.y - predictedPrev.y) * t,
  };
}

// Where every player should be drawn right now.
function playersToDraw() {
  const result = otherPlayersToDraw();

  // Our own player: with prediction, draw our guess (no waiting for the server).
  // Without it, draw the newest position the server sent.
  const mine = players[myId];
  if (mine && predictionOn && predicted) {
    const { x, y } = smoothPredicted();
    result[myId] = {
      ...mine,
      x, y,
      vx: predicted.vx, vy: predicted.vy, onGround: predicted.onGround, // for the animations
      standingOn: predicted.standingOn, // for paint splats
      frozen: predicted.frozenSteps > 0,
    };
  } else if (mine) {
    result[myId] = mine;
  }
  return result;
}

// Everyone except us: drawn a little in the past, blended between server updates (interpolation).
function otherPlayersToDraw() {
  if (!interpolationOn || snapshots.length === 0) {
    const result = { ...players };
    delete result[myId]; // ours is handled in playersToDraw
    for (const id in result) rideAlong(result, id);
    return result;
  }

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
    // Just joined, or respawned somewhere new between the two updates: nothing to blend from,
    // so draw them straight at the new spot instead of sliding them across the map.
    if (!a || a.spawns !== b.spawns) { result[id] = b; rideAlong(result, id); continue; }
    result[id] = {
      ...b, // color, "it" and "frozen" from the newer update
      x: a.x + (b.x - a.x) * amount,
      y: a.y + (b.y - a.y) * amount,
    };
    rideAlong(result, id, a, b, amount);
  }
  return result;
}

// Moving platforms are drawn at the current tick, but other players are drawn a little in the
// past, so someone riding an elevator would look sunk into it or floating above it.
// If the newest update says they're riding one, draw them on top of where it is now instead.
//
// Where along the platform? We work out how far from the platform's left edge they were in the
// two updates we're blending between ("a" and "b"), blend THAT, and add it to where the platform
// is now. So walking along a moving platform glides smoothly like walking anywhere else.
// (Using only the newest update made their walking jump forward once per update: choppy.)
// If they weren't on this platform in both updates (they just landed), or interpolation is off,
// we can only go by the newest update.
function rideAlong(result, id, a, b, amount) {
  const newest = players[id];
  if (!newest || !newest.onGround || !map) return;
  const platform = map.platforms[newest.standingOn];
  if (!platform || platform.type !== "moving") return;
  const now = Physics.platformPosition(platform, drawTick());

  // How far from the platform's left edge someone was in an update (at the tick they were on).
  const along = (u) => u.x - Physics.platformPosition(platform, u.tick).x;
  const ridingIn = (u) => u && u.onGround && u.standingOn === newest.standingOn;

  let offset;
  if (ridingIn(a) && ridingIn(b)) offset = along(a) + (along(b) - along(a)) * amount;
  else offset = along(newest);
  result[id] = { ...result[id], x: now.x + offset, y: now.y - playerSize };
}

// The tick moving platforms are drawn at. Like our own player (see smoothPredicted), they're drawn
// partway between the last two ticks, so they glide smoothly and when we ride one we're drawn
// exactly on top of it. (platformPosition works fine with a tick like 1234.6.)
function drawTick() {
  return currentTick !== null ? currentTick - 1 + stepFraction() : estimatedServerTick();
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
  // On the start screen: let keys work normally there (typing a name, ticking the boxes).
  if (myName === null) return;
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

  ctx.fillStyle = PAPER_COLOR; // wipe last frame with a fresh sheet of paper
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (map) drawWorld(dt);

  drawRoundInfo();
  drawScoreboard();
  drawPing();

  requestAnimationFrame(draw); // ask the browser to call us again next frame
}

// ===== Platforms: each type has its own look =====
// Every platform is a white (or pale blue, for ice) rounded box with a thick black outline,
// like the characters. Special ones get one simple doodle on top to show what they do.
// index is the platform's place in map.platforms (used to find its paint splats).
function drawPlatform(p, index, tick) {
  const { x, y } = Physics.platformPosition(p, tick);
  const w = p.width, h = p.height;

  ctx.strokeStyle = INK;
  ctx.lineWidth = OUTLINE_WIDTH;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Jump pads: a little spring with a lid, standing on the pad.
  if (p.type === "jumppad") drawSpring(x, y, w, padSprings[index] ? padSprings[index].squish : 0);

  // The box: fill, then any paint splats on it, then the outline on top so it stays crisp.
  // (drawSplats draws its own shapes, which replaces the box's path, and save/restore doesn't
  // bring a path back. So the box is traced again for the outline.)
  const radius = Math.min(6, w / 2, h / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fillStyle = p.type === "ice" ? "#d6effa" : "#fff";
  ctx.fill();
  drawSplats(index, x, y);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.stroke();

  if (p.type === "ice") {
    // Two short white shine lines near the left end
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x + 10, y + h - 4); ctx.lineTo(x + 16, y + 4);
    ctx.moveTo(x + 20, y + h - 4); ctx.lineTo(x + 24, y + 6);
    ctx.stroke();
  } else if (p.type === "moving") {
    // Two arrowheads pointing both ways along its track: "<  >"
    const angle = Math.atan2(p.toY - p.y, p.toX - p.x);
    ctx.lineWidth = 2;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(x + w / 2 + side * w * 0.22, y + h / 2);
      ctx.rotate(angle + (side < 0 ? Math.PI : 0));
      ctx.beginPath();
      ctx.moveTo(-3, -4); ctx.lineTo(2, 0); ctx.lineTo(-3, 4);
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ===== Jump pad springs: squash down, then boing back up past their normal height =====
// How squashed each jump pad's spring is, keyed by its index in map.platforms:
// { squish, speed }. squish 0 = normal height, 1 = flat, below 0 = stretched taller.
const padSprings = {};

// Someone just bounced off the jump pad under (feetX, feetY): give its spring a push downward.
function kickPadSpring(feetX, feetY) {
  if (!map) return;
  map.platforms.forEach((p, i) => {
    if (p.type !== "jumppad") return;
    // Find the pad under their feet. (They've already flown up a little, so allow some room.)
    // Find the pad under them. Leave plenty of room: their square only needs to overlap the pad,
    // and other players are drawn a little in the past, so they may still look a bit above it.
    const margin = playerSize / 2;
    if (feetX < p.x - margin || feetX > p.x + p.width + margin) return;
    if (feetY < p.y - 80 || feetY > p.y + p.height + 10) return;
    const s = padSprings[i] || (padSprings[i] = { squish: 0, speed: 0 });
    // Start it partly squashed and still moving down, so it visibly sinks, then boings back up.
    s.squish = Math.max(s.squish, 0.3);
    s.speed = JUMPPAD_SQUISH_PUSH;
  });
}

// Move every spring forward by dt seconds. It's a bouncy spring (not much damping), so after
// squashing it shoots back up a little past normal and wobbles to a stop.
function updatePadSprings(dt) {
  const STIFFNESS = 300, DAMPING = 8;
  for (const i in padSprings) {
    const s = padSprings[i];
    for (let left = dt; left > 0; left -= 1 / 240) { // small sub-steps keep it stable
      const h = Math.min(left, 1 / 240);
      s.speed += (-s.squish * STIFFNESS - s.speed * DAMPING) * h;
      s.squish += s.speed * h;
    }
    s.squish = Math.max(-0.6, Math.min(0.8, s.squish)); // never flat or stretched too far
    if (Math.abs(s.squish) < 0.001 && Math.abs(s.speed) < 0.01) delete padSprings[i]; // at rest
  }
}

// A zigzag spring sitting on a jump pad whose top-left is (x, y), with a little lid on top.
// squish shrinks it (0 = normal, 1 = flat) or stretches it (below 0).
function drawSpring(x, y, w, squish) {
  const cx = x + w / 2, half = w * 0.22, height = 12 * (1 - squish), zigs = 4;
  ctx.beginPath();
  ctx.moveTo(cx, y);
  for (let i = 1; i <= zigs; i++) {
    const zy = y - (height * i) / (zigs + 1);
    ctx.lineTo(cx + (i % 2 === 0 ? -half : half), zy);
  }
  ctx.lineTo(cx, y - height);
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(cx - w * 0.32, y - height - 4, w * 0.64, 4, 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.stroke();
}

// ===== Paint splats: players leave a little blob of their color where they land =====
// Each one: { platform (index in map.platforms), dx (how far along the platform it is, so splats
// ride along on moving platforms), color, born (performance.now()), blob, drops }
// Splats always sit on the platform's top edge, since that's the only side you can land on.
const splats = [];

function addSplat(platformIndex, feetX, color) {
  const p = map && map.platforms[platformIndex];
  if (!p) return;
  const pos = Physics.platformPosition(p, drawTick());
  // A wobbly round blob: 9 points around a circle, each a random distance from the middle...
  const blob = [];
  for (let i = 0; i < 9; i++) blob.push(rand(0.7, 1.15));
  // ...plus two little droplets flicked off to the sides.
  const drops = [-1, 1].map((side) => ({ x: side * rand(10, 15), y: rand(-1, 3), r: rand(1.2, 2.2) }));
  if (splats.length >= MAX_SPLATS) splats.shift();
  splats.push({ platform: platformIndex, dx: feetX - pos.x, color, born: performance.now(), blob, drops });
}

// Draw the splats on one platform, clipped to the box that was just traced so they look painted on.
function drawSplats(index, x, y) {
  const now = performance.now();
  let clipped = false;
  for (const s of splats) {
    if (s.platform !== index) continue;
    const fade = 1 - (now - s.born) / 1000 / SPLAT_LIFETIME; // 1 = fresh, 0 = gone
    if (fade <= 0) continue;
    if (!clipped) { ctx.save(); ctx.clip(); clipped = true; }
    ctx.globalAlpha = 0.75 * fade;
    ctx.fillStyle = s.color;
    // A flattened blob, centered just below the platform's top edge
    const cx = x + s.dx, cy = y + 2;
    ctx.beginPath();
    s.blob.forEach((r, i) => {
      const a = (i / s.blob.length) * Math.PI * 2;
      const px = cx + Math.cos(a) * 9 * r, py = cy + Math.sin(a) * 4.5 * r;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fill();
    for (const d of s.drops) {
      ctx.beginPath();
      ctx.arc(cx + d.x, cy + d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (clipped) ctx.restore(); // also undoes the clip and the alpha
  // Forget splats that have faded away completely.
  while (splats.length && now - splats[0].born > SPLAT_LIFETIME * 1000) splats.shift();
}

// The faint notebook grid, drawn in map coordinates so it scrolls with the world.
// Only the lines that are on screen are drawn.
function drawGrid() {
  // (One extra square on every side, so a screen shake never shows a gap.)
  const left = Math.floor(camera.x / GRID_SIZE - 1) * GRID_SIZE;
  const top = Math.floor(camera.y / GRID_SIZE - 1) * GRID_SIZE;
  const right = camera.x + canvas.width + GRID_SIZE, bottom = camera.y + canvas.height + GRID_SIZE;
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = left; gx <= right; gx += GRID_SIZE) { ctx.moveTo(gx, top); ctx.lineTo(gx, bottom); }
  for (let gy = top; gy <= bottom; gy += GRID_SIZE) { ctx.moveTo(left, gy); ctx.lineTo(right, gy); }
  ctx.stroke();
}

// ===== Particles: dust, paint and sparks =====
// Little dots that fly out, slow down, fade away and disappear. Positions are in map pixels,
// speeds in pixels per second. They're only for looks, so each browser makes its own.
// Each one: { x, y, vx, vy, gravity, drag, size, grow, color, life, maxLife }
// Confetti pieces also have { confetti: true, angle, spin } and are drawn as tumbling paper strips.
const particles = [];

function addParticle(props) {
  if (particles.length >= MAX_PARTICLES) particles.shift(); // drop the oldest
  particles.push({ gravity: 0, drag: 0, grow: 0, angle: 0, spin: 0, ...props, maxLife: props.life });
}

// A random number between min and max.
function rand(min, max) {
  return min + Math.random() * (max - min);
}

// Soft grey puffs that drift out sideways along the ground, swell a little and fade.
// The harder we land (fallSpeed), the more puffs. A full jump lands at about 11.
function landingDust(x, y, fallSpeed) {
  const count = Math.max(2, Math.round(LAND_DUST_COUNT * Math.min(1, fallSpeed / 11)));
  for (let i = 0; i < count; i++) {
    const side = i % 2 === 0 ? -1 : 1; // half go left, half go right
    addParticle({
      x: x + side * rand(2, 8), y: y - rand(0, 3),
      vx: side * rand(25, 70), vy: -rand(5, 25),
      drag: 5, size: rand(2.5, 4), grow: 5,
      color: "rgba(120, 115, 105, 0.45)", life: rand(0.3, 0.5),
    });
  }
}

// A single small puff kicked up behind a running player (vx is which way they're running).
function runningDust(x, y, vx) {
  addParticle({
    x, y: y - rand(0, 2),
    vx: -Math.sign(vx) * rand(10, 30), vy: -rand(8, 20),
    drag: 4, size: rand(1.5, 2.5), grow: 4,
    color: "rgba(120, 115, 105, 0.4)", life: rand(0.25, 0.4),
  });
}

// Orange and yellow sparks shooting out from a jump pad, mostly sideways and down.
function jumpPadBurst(x, y) {
  for (let i = 0; i < JUMPPAD_BURST_COUNT; i++) {
    const angle = rand(-0.3, Math.PI + 0.3); // 0 = right, PI/2 = down, PI = left
    const speed = rand(60, 140);
    addParticle({
      x: x + rand(-8, 8), y,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed * 0.5,
      drag: 6, size: rand(1.5, 2.5),
      color: i % 2 === 0 ? "#f28c28" : "#f2c12e", life: rand(0.25, 0.4),
    });
  }
}

// Drops of paint in the tagged player's color, flying out in every direction and falling.
function tagSplash(x, y, color) {
  for (let i = 0; i < TAG_SPLASH_COUNT; i++) {
    const angle = rand(0, Math.PI * 2);
    const speed = rand(60, 180);
    addParticle({
      x, y,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 60, // a little upward kick
      gravity: 500, drag: 1.5, size: rand(1.5, 3.5), grow: -2,
      color, life: rand(0.4, 0.7),
    });
  }
}

// Bright paper confetti popping up out of the winner, then fluttering down.
const CONFETTI_COLORS = ["#ff5c5c", "#ffb84d", "#ffe14d", "#5cd65c", "#4db8ff", "#b366ff"];
function winConfetti(x, y) {
  for (let i = 0; i < WIN_CONFETTI_COUNT; i++) {
    const angle = rand(-Math.PI * 0.85, -Math.PI * 0.15); // upward, spread out to both sides
    const speed = rand(150, 320);
    addParticle({
      x: x + rand(-6, 6), y: y + rand(-6, 6),
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      gravity: 260, drag: 2.5, size: rand(2.5, 3.5),
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length], life: rand(1.2, 1.8),
      confetti: true, angle: rand(0, Math.PI * 2), spin: rand(-10, 10),
    });
  }
}

// Move every particle forward by dt seconds, and throw away the ones that have run out.
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i];
    q.life -= dt;
    if (q.life <= 0) { particles.splice(i, 1); continue; }
    const slow = Math.exp(-q.drag * dt); // drag slows it down the same way at any frame rate
    q.vx *= slow;
    q.vy = q.vy * slow + q.gravity * dt;
    q.x += q.vx * dt;
    q.y += q.vy * dt;
    q.size = Math.max(0.5, q.size + q.grow * dt);
    q.angle += q.spin * dt;
  }
}

function drawParticles() {
  for (const q of particles) {
    ctx.globalAlpha = Math.min(1, q.life / q.maxLife * 1.5); // fade out over the last part of its life
    ctx.fillStyle = q.color;
    if (q.confetti) {
      // A little strip of paper. Squeezing its width as it spins makes it look like it's flipping over.
      ctx.save();
      ctx.translate(q.x, q.y);
      ctx.rotate(q.angle);
      ctx.scale(Math.cos(q.angle * 1.7), 1);
      ctx.fillRect(-q.size, -q.size / 2, q.size * 2, q.size);
      ctx.restore();
      continue;
    }
    ctx.beginPath();
    ctx.arc(q.x, q.y, q.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ===== Winning: confetti =====
// When a round ends, confetti pops out of the winner.
function noticeWin(oldRound, newPlayers, newRound) {
  if (oldRound.phase !== "playing" || newRound.phase !== "results" || !newRound.winner) return;
  const id = newRound.winner.id;
  const winner = newPlayers[id];
  if (!winner) return; // they left just as the round ended
  // If we won, use where we're drawn (our prediction).
  const at = id === myId && predictionOn && predicted ? predicted : winner;
  winConfetti(at.x + playerSize / 2, at.y + playerSize / 2);
}

// ===== Tags: splash and shake =====
// The server doesn't announce tags, so we spot them ourselves: if "it" moves to someone else
// in the middle of a round, that's a tag. (A new round picking a new "it" isn't one.)
function noticeTag(oldPlayers, oldRound, newPlayers, newRound) {
  if (oldRound.phase !== "playing" || newRound.phase !== "playing") return;
  const oldIt = Object.keys(oldPlayers).find((id) => oldPlayers[id].it);
  const newIt = Object.keys(newPlayers).find((id) => newPlayers[id].it);
  if (!oldIt || !newIt || oldIt === newIt) return;

  // Splash where the tagged player is. If that's us, use where we're drawn (our prediction).
  const tagged = newPlayers[newIt];
  const at = newIt === myId && predictionOn && predicted ? predicted : tagged;
  tagSplash(at.x + playerSize / 2, at.y + playerSize / 2, tagged.color);

  // Only shake for tags we're part of: we got tagged, or we did the tagging.
  if (newIt === myId || oldIt === myId) shakeTimeLeft = SHAKE_DURATION;
}

// Seconds of screen shake left (0 = not shaking).
let shakeTimeLeft = 0;

// How far to nudge the camera this frame: a random jiggle that fades out as the shake ends.
function shakeOffset(dt) {
  if (shakeTimeLeft <= 0) return { x: 0, y: 0 };
  shakeTimeLeft = Math.max(0, shakeTimeLeft - dt);
  const strength = SHAKE_STRENGTH * (shakeTimeLeft / SHAKE_DURATION);
  return { x: rand(-strength, strength), y: rand(-strength, strength) };
}

// ===== Characters =====
// Players are round little characters (see art/character.png), drawn here with shapes.
// This is ONLY for looks: the physics still uses the same PLAYER_SIZE square as before,
// and all the animation below happens in the browser without touching the physics.

// How hard landing pushes the squash. Bigger = squashes wider on landing.
// (With the spring in animatePlayer, 3 adds roughly 7% extra width at the peak.)
const LANDING_SQUASH_PUSH = 3;

// Animation memory for each player, keyed by id:
// { walkPhase, walkAmount, squash, squashSpeed, eyeX, wasOnGround, lastVy }
const anims = {};

// Move each number part of the way toward where it's heading, the same way at any frame rate.
// Bigger rate = gets there faster.
function approach(value, target, rate, dt) {
  return value + (target - value) * (1 - Math.exp(-rate * dt));
}

// Advance one player's animation by dt seconds, and work out the pose to draw them in.
function animatePlayer(id, p, dt) {
  const vx = p.vx || 0, vy = p.vy || 0;
  let a = anims[id];
  if (!a) {
    a = anims[id] = {
      walkPhase: 0, walkAmount: 0, squash: 0, squashSpeed: 0, eyeX: 0, wasOnGround: p.onGround, lastVy: vy,
      ice: p.frozen ? 1 : 0,
    };
  }

  // The ice cube around a frozen player pops in when they're frozen and fades away when they thaw.
  a.ice = approach(a.ice, p.frozen ? 1 : 0, 14, dt);

  // Walking: the feet step faster the faster we move (one full left-right cycle every 40 pixels).
  // walkAmount fades from 0 (standing) to 1 (walking) so starting and stopping look smooth.
  const walking = p.onGround && Math.abs(vx) > 0.3;
  const stepBefore = Math.floor(a.walkPhase / Math.PI);
  if (walking) a.walkPhase += Math.abs(vx) * (1000 / Physics.STEP_MS) * dt * (2 * Math.PI / 40);
  // Each time a foot comes down (every half cycle), sometimes kick up a little dust behind us.
  if (walking && Math.floor(a.walkPhase / Math.PI) !== stepBefore && Math.random() < RUN_DUST_CHANCE) {
    runningDust(p.x + playerSize / 2 - Math.sign(vx) * 6, p.y + playerSize, vx);
  }
  a.walkAmount = approach(a.walkAmount, walking ? 1 : 0, 12, dt);

  // The eyes look a little toward where we're moving, and back to the middle when we stop.
  a.eyeX = approach(a.eyeX, walking || !p.onGround ? Math.sign(vx) * 2.5 : 0, 10, dt);

  // Squash and stretch. squash > 0 = wider and shorter, squash < 0 = taller and thinner.
  // Landing (or bouncing off a jump pad) squashes us for a moment. Going up stretches us taller,
  // and falling spreads us a little wider, more the faster we're going. It all eases smoothly.
  const landed = p.onGround && !a.wasOnGround;
  const bounced = a.lastVy > 2 && vy < -5;
  // Launched by a jump pad: suddenly going up much faster than a normal jump (11) ever can.
  // (We can't just use "bounced": walking onto a pad that's level with the floor launches you
  // without falling first.)
  const launchSpeed = -(Physics.JUMPPAD_STRENGTH + 11) / 2;
  const launched = vy < launchSpeed && a.lastVy >= launchSpeed;
  // (Landing gives the spring below a push, so the squash grows quickly but smoothly.)
  if (landed || bounced || launched) a.squashSpeed = LANDING_SQUASH_PUSH;

  // Puffs and sparks at the feet (see "Particles" below).
  const feetX = p.x + playerSize / 2, feetY = p.y + playerSize;
  if (landed) {
    landingDust(feetX, feetY, a.lastVy);
    addSplat(p.standingOn, feetX, p.color);
  }
  if (launched) {
    jumpPadBurst(feetX, feetY);
    kickPadSpring(feetX, feetY);
  }
  let target = 0;
  if (!p.onGround && vy < 0) target = -0.11 * Math.min(1, -vy / 11); // rising: taller
  if (!p.onGround && vy > 0) target = 0.08 * Math.min(1, vy / 11);   // falling: wider

  // squash follows its target like a spring instead of jumping straight there: it starts slowly,
  // speeds up, then eases in, so changing shape looks curved and natural.
  // Stiffer = gets there faster; more damping = less wobble. Damping of 2 * sqrt(stiffness)
  // settles as fast as possible without overshooting. (Small sub-steps keep it stable.)
  const SQUASH_STIFFNESS = 220, SQUASH_DAMPING = 30;
  for (let left = dt; left > 0; left -= 1 / 240) {
    const h = Math.min(left, 1 / 240);
    a.squashSpeed += ((target - a.squash) * SQUASH_STIFFNESS - a.squashSpeed * SQUASH_DAMPING) * h;
    a.squash += a.squashSpeed * h;
  }
  a.wasOnGround = p.onGround;
  a.lastVy = vy;

  // Standing still: a slow, slight up-and-down bob. Walking: a little hop with each step.
  const idleBob = Math.sin(performance.now() / 400) * 0.8 * (1 - a.walkAmount);
  const walkBob = Math.abs(Math.sin(a.walkPhase)) * 1.5 * a.walkAmount;

  return {
    tucked: !p.onGround,
    scaleX: 1 + a.squash,
    scaleY: 1 - a.squash,
    bodyLift: idleBob + walkBob,
    // Each foot lifts during its half of the step, and swings forward and back a little.
    leftFootLift: Math.max(0, Math.sin(a.walkPhase)) * 3 * a.walkAmount,
    rightFootLift: Math.max(0, -Math.sin(a.walkPhase)) * 3 * a.walkAmount,
    footSwing: Math.cos(a.walkPhase) * 1.5 * a.walkAmount,
    eyeX: a.eyeX,
    ice: a.ice,
  };
}

// A see-through ice cube around a character whose feet are at (x, bottom).
// amount goes from 0 (no ice) to 1 (fully frozen): the cube grows in and fades in with it.
function drawIceCube(x, bottom, amount) {
  if (amount < 0.01) return;
  ctx.save();
  ctx.translate(x, bottom);
  const grow = 0.6 + 0.4 * amount;
  ctx.scale(grow, grow);
  ctx.globalAlpha *= amount;

  // Just big enough to hold the character, arms and all (positions are from its feet, up is negative).
  const left = -21, top = -36, width = 42, height = 37;

  // The cube: pale blue, see-through, with a darker icy edge
  ctx.beginPath();
  ctx.roundRect(left, top, width, height, 5);
  ctx.fillStyle = "rgba(170, 225, 250, 0.45)";
  ctx.fill();
  ctx.strokeStyle = "rgba(70, 150, 200, 0.9)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // A lighter strip across the top, like the top face of the cube
  ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
  ctx.beginPath();
  ctx.roundRect(left + 3, top + 3, width - 6, 5, 2);
  ctx.fill();

  // Shiny glints: two diagonal streaks in the top-left corner and one bottom-right
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(left + 5, top + 18); ctx.lineTo(left + 12, top + 11);
  ctx.moveTo(left + 5, top + 25); ctx.lineTo(left + 9, top + 21);
  ctx.moveTo(left + width - 10, top + height - 5); ctx.lineTo(left + width - 5, top + height - 10);
  ctx.stroke();

  ctx.restore();
}

// The pose a character stands in when it isn't doing anything (used for the winner's icon).
const STILL_POSE = {
  tucked: false, scaleX: 1, scaleY: 1, bodyLift: 0,
  leftFootLift: 0, rightFootLift: 0, footSwing: 0, eyeX: 0, ice: 0,
};

// A filled ellipse with a thick black outline.
function blob(x, y, rx, ry, fill) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.stroke();
}

// Draw one character standing with its feet at (x, bottom). Positions below are in pixels from
// that point: negative y is up. Squash and stretch scale it from the feet, so it stays on the ground.
function drawCharacter(x, bottom, color, pose, isIt) {
  ctx.save();
  ctx.translate(x, bottom);
  ctx.scale(pose.scaleX, pose.scaleY);
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 3;

  // Walking: a big round body. Tucked: a slightly smaller ball, sitting lower.
  const radius = pose.tucked ? 11.5 : 13;
  const bodyY = (pose.tucked ? -12.5 : -16) - pose.bodyLift;

  // Whoever is "it" gets a soft, glowing red outline. It's drawn first so it sits behind
  // everything else (feet, body and arms all cover it).
  if (isIt) {
    ctx.save();
    ctx.shadowColor = "rgba(255, 0, 0, 0.6)";
    ctx.shadowBlur = 8;
    ctx.strokeStyle = "rgba(255, 0, 0, 0.55)";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, bodyY, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  if (!pose.tucked) {
    // Stubby feet, behind the bottom of the body
    blob(-6 + pose.footSwing, -3 - pose.leftFootLift, 4.5, 3, "#000");
    blob(6 - pose.footSwing, -3 - pose.rightFootLift, 4.5, 3, "#000");
  }

  // The body, filled with the player's color
  blob(0, bodyY, radius, radius, color);

  if (pose.tucked) {
    // Arms pressed flat against the sides, feet tucked in underneath
    blob(-radius + 1, bodyY + 1, 2.5, 4.5, color);
    blob(radius - 1, bodyY + 1, 2.5, 4.5, color);
    blob(-5, -1.5, 4, 2.5, "#000");
    blob(5, -1.5, 4, 2.5, "#000");
  } else {
    // Small curled arms sticking out of the sides
    blob(-radius - 1, bodyY + 4, 3.5, 4.5, color);
    blob(radius + 1, bodyY + 4, 3.5, 4.5, color);
  }

  // Two dot eyes, low on the face, looking a little toward where we're going
  // (a little closer together on the smaller tucked ball)
  ctx.fillStyle = "#000";
  const eyeGap = pose.tucked ? 4 : 4.5;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(pose.eyeX + side * eyeGap, bodyY + (pose.tucked ? 3.5 : 4), 2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// A faint dashed line showing the track a moving platform goes back and forth along.
function drawTrack(p) {
  ctx.strokeStyle = "rgba(0, 0, 0, 0.2)"; // light pencil
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(p.x + p.width / 2, p.y + p.height / 2);
  ctx.lineTo(p.toX + p.width / 2, p.toY + p.height / 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

// Everything that lives on the map (platforms and players), drawn through the camera.
function drawWorld(dt) {
  const drawn = playersToDraw();
  if (drawn[myId]) updateCamera(drawn[myId], dt);
  if (camera === null) return; // we haven't appeared yet

  // Shift everything we draw from now on by the camera position. A platform at map x = 1000
  // with the camera at x = 900 lands at canvas x = 100. (No rounding to whole pixels: the players
  // aren't rounded, so a rounded camera made them wobble back and forth by a pixel.)
  // A screen shake nudges the whole world, but not the timer and ping drawn after it.
  const shake = shakeOffset(dt);
  ctx.save();
  ctx.translate(-camera.x + shake.x, -camera.y + shake.y);

  const tick = drawTick();
  drawGrid();
  for (const p of map.platforms) if (p.type === "moving") drawTrack(p); // tracks go behind everything
  updatePadSprings(dt);
  map.platforms.forEach((p, i) => drawPlatform(p, i, tick));

  // Forget the animations of anyone who has left.
  for (const id in anims) if (!drawn[id]) delete anims[id];

  for (const id in drawn) {
    const p = drawn[id];
    // Each character stands on the bottom middle of its collision square.
    // A frozen "it" is see-through and stuck in an ice cube until they can move.
    const pose = animatePlayer(id, p, dt);
    ctx.globalAlpha = p.frozen ? 0.5 : 1;
    drawCharacter(p.x + playerSize / 2, p.y + playerSize, p.color, pose, p.it);
    ctx.globalAlpha = 1;
    drawIceCube(p.x + playerSize / 2, p.y + playerSize, pose.ice);

    // Labels stack upward above the character: their name first (ours in bold), then "IT" above that.
    // Each gets a white edge so it stays readable over platforms and outlines.
    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    let labelY = p.y - 8;
    ctx.font = (id === myId ? "bold " : "") + "12px sans-serif";
    outlinedText(p.name || "", p.x + playerSize / 2, labelY, "#000");
    labelY -= 14;
    if (p.it) {
      ctx.font = "bold 14px sans-serif";
      outlinedText("IT", p.x + playerSize / 2, labelY, "red");
    }
  }

  // Particles go on top of the players, so paint splashes over whoever got tagged.
  updateParticles(dt);
  drawParticles();

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
  } else if (round.phase === "starting") {
    // Enough players are here: count down to the first round. 5, 4, 3, 2, 1 (never 0).
    const startsIn = Math.max(1, Math.ceil(round.timeLeft / 1000));
    ctx.fillText("Game starting", centerX, 30);
    ctx.font = "bold 28px sans-serif";
    ctx.fillText(String(startsIn), centerX, 62);
  } else if (round.phase === "playing") {
    // Show time left as m:ss, e.g. 0:42
    const seconds = Math.ceil(round.timeLeft / 1000);
    const m = Math.floor(seconds / 60);
    const s = String(seconds % 60).padStart(2, "0");
    // The last few seconds turn red, to show time is nearly up.
    if (seconds <= TIMER_WARNING_SECONDS) ctx.fillStyle = "red";
    ctx.fillText(m + ":" + s, centerX, 30);
  } else if (round.phase === "results" && round.winner) {
    const w = round.winner;
    const itSeconds = (w.itTime / 1000).toFixed(1);
    const text = w.id === myId ? "You win!" : "Winner: " + w.name;
    ctx.fillText(text, centerX - 20, 30);
    // A little character in the winner's color next to it
    ctx.save();
    ctx.translate(centerX + ctx.measureText(text).width / 2 + 3, 36);
    ctx.scale(0.8, 0.8);
    drawCharacter(0, 0, w.color, STILL_POSE, false);
    ctx.restore();
    ctx.fillStyle = "#000";
    ctx.font = "14px sans-serif";
    // During the results, timeLeft is how long until the next round starts.
    const startsIn = Math.max(1, Math.ceil(round.timeLeft / 1000));
    ctx.fillText("(only " + itSeconds + "s as IT) - next round in " + startsIn + "...", centerX, 54);
  }
}

// Text with a white edge around it, in the current font and alignment.
function outlinedText(text, x, y, color) {
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 3;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// Shorten text with "..." until it fits in maxWidth pixels (in the current font).
function fitText(text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  while (text.length > 1 && ctx.measureText(text + "...").width > maxWidth) text = text.slice(0, -1);
  return text + "...";
}

// ===== Scoreboard in the top-right corner =====
// Everyone's name, how long they've been "it" this round, and how many rounds they've won.
// Whoever is winning this round (least time as "it") is on top. People who joined partway
// through can't win this round, so they go below everyone who can.
const SCOREBOARD_WIDTH = 210;
const SCOREBOARD_MAX_ROWS = 10;

function drawScoreboard() {
  const rows = Object.entries(players).map(([id, p]) => ({ id, ...p }));
  if (rows.length === 0) return;
  rows.sort((a, b) =>
    (b.inRound - a.inRound) ||   // can win this round first
    (a.itTime - b.itTime) ||     // then least time as "it"
    (b.wins - a.wins) ||         // then most wins
    a.name.localeCompare(b.name));
  const shown = rows.slice(0, SCOREBOARD_MAX_ROWS);

  const rowHeight = 18, padding = 8;
  const x = canvas.width - SCOREBOARD_WIDTH - 8, y = 8;
  const height = padding * 2 + rowHeight * (shown.length + 1);
  const itColumn = x + SCOREBOARD_WIDTH - 52;  // right edge of the "IT" column
  const winsColumn = x + SCOREBOARD_WIDTH - padding; // right edge of the "Wins" column

  // A white card with a thick black rounded outline, like the platforms
  ctx.beginPath();
  ctx.roundRect(x, y, SCOREBOARD_WIDTH, height, 8);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = OUTLINE_WIDTH;
  ctx.stroke();

  // Headings
  let rowY = y + padding + 13;
  ctx.font = "bold 12px sans-serif";
  ctx.fillStyle = "#777";
  ctx.textAlign = "left";
  ctx.fillText("Name", x + padding + 14, rowY);
  ctx.textAlign = "right";
  ctx.fillText("IT", itColumn, rowY);
  ctx.fillText("Wins", winsColumn, rowY);

  for (const r of shown) {
    rowY += rowHeight;
    // Their color as a little dot, their name (ours in bold), "it" in red
    ctx.beginPath();
    ctx.arc(x + padding + 5, rowY - 4, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = r.color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = (r.id === myId ? "bold " : "") + "12px sans-serif";
    ctx.fillStyle = r.it ? "red" : "#000";
    ctx.textAlign = "left";
    ctx.fillText(fitText(r.name, itColumn - 40 - (x + padding + 14)), x + padding + 14, rowY);
    ctx.textAlign = "right";
    ctx.fillText((r.itTime / 1000).toFixed(1) + "s", itColumn, rowY);
    ctx.fillText(String(r.wins), winsColumn, rowY);
  }
}

// ===== Ping in the top-left corner =====
// A small white card like the scoreboard: "Ping: 23 ms".
function drawPing() {
  const label = "Ping: ";
  const value = (pingMs === null ? "--" : pingMs) + " ms";
  ctx.font = "bold 12px sans-serif";
  const labelWidth = ctx.measureText(label).width;
  ctx.font = "12px sans-serif";
  const width = labelWidth + ctx.measureText(value).width + 20;

  ctx.beginPath();
  ctx.roundRect(8, 8, width, 26, 8);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = OUTLINE_WIDTH;
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.fillStyle = "#000";
  ctx.font = "bold 12px sans-serif";
  ctx.fillText(label, 18, 25);
  ctx.font = "12px sans-serif";
  ctx.fillText(value, 18 + labelWidth, 25);
}

draw(); // start drawing!
