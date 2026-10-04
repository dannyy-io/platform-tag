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
    vx: me.vx, vy: me.vy,
    onGround: me.onGround,
    standingOn: me.standingOn,
    frozenSteps: me.frozenSteps,
  };
  // 2. ...then replay every input the server hasn't got to yet, each on the same tick as before.
  //    (Remembering where we were before the last one, for smooth drawing.)
  predictedPrev = { x: predicted.x, y: predicted.y };
  for (const input of pendingInputs) {
    predictedPrev = { x: predicted.x, y: predicted.y };
    Physics.stepPlayer(predicted, input, map, input.tick);
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
    if (!a) { result[id] = b; continue; } // just joined: nothing to blend from yet
    result[id] = {
      ...b, // color, "it" and "frozen" from the newer update
      x: a.x + (b.x - a.x) * amount,
      y: a.y + (b.y - a.y) * amount,
    };
  }
  for (const id in result) rideAlong(result, id);
  return result;
}

// Moving platforms are drawn at the current tick, but other players are drawn a little in the
// past, so someone riding an elevator would look sunk into it or floating above it.
// If the newest update says they're riding one, draw them on top of where it is now instead,
// moved sideways by however far it has gone since the tick they were last at.
function rideAlong(result, id) {
  const newest = players[id];
  if (!newest || !newest.onGround || !map) return;
  const platform = map.platforms[newest.standingOn];
  if (!platform || platform.type !== "moving") return;
  const now = Physics.platformPosition(platform, drawTick());
  const then = Physics.platformPosition(platform, newest.tick);
  result[id] = { ...result[id], x: newest.x + (now.x - then.x), y: now.y - playerSize };
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

// ===== Platforms: each type has its own look =====
function drawPlatform(p, tick) {
  const { x, y } = Physics.platformPosition(p, tick);
  const w = p.width, h = p.height;

  if (p.type === "solid") {
    ctx.fillStyle = "#6b4f3a"; // brown block
    ctx.fillRect(x, y, w, h);
  } else if (p.type === "ice") {
    ctx.fillStyle = "#bfeaf5"; // pale blue
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#ffffff"; // shiny white top edge
    ctx.fillRect(x, y, w, 3);
    ctx.strokeStyle = "#ffffff"; // a few diagonal glints
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let gx = x + 20; gx + 10 < x + w; gx += 60) {
      ctx.moveTo(gx, y + h - 3);
      ctx.lineTo(gx + 10, y + 5);
    }
    ctx.stroke();
  } else if (p.type === "jumppad") {
    ctx.fillStyle = "#f28c28"; // orange
    ctx.fillRect(x, y, w, h);
    // Upward arrows above it, bobbing up and down so it catches the eye
    const bob = Math.sin(performance.now() / 150) * 3;
    ctx.fillStyle = "#f2c12e";
    for (let ax = x + 15; ax <= x + w - 15; ax += 30) {
      ctx.beginPath();
      ctx.moveTo(ax - 8, y - 6 + bob);
      ctx.lineTo(ax, y - 16 + bob);
      ctx.lineTo(ax + 8, y - 6 + bob);
      ctx.fill();
    }
  } else if (p.type === "moving") {
    ctx.fillStyle = "#7d4fc4"; // purple
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#b796ea"; // lighter stripe on top
    ctx.fillRect(x, y, w, 4);
  } else {
    ctx.fillStyle = "#3a7d44"; // plain green platform
    ctx.fillRect(x, y, w, h);
  }
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
  if (walking) a.walkPhase += Math.abs(vx) * (1000 / Physics.STEP_MS) * dt * (2 * Math.PI / 40);
  a.walkAmount = approach(a.walkAmount, walking ? 1 : 0, 12, dt);

  // The eyes look a little toward where we're moving, and back to the middle when we stop.
  a.eyeX = approach(a.eyeX, walking || !p.onGround ? Math.sign(vx) * 2.5 : 0, 10, dt);

  // Squash and stretch. squash > 0 = wider and shorter, squash < 0 = taller and thinner.
  // Landing (or bouncing off a jump pad) squashes us for a moment. Going up stretches us taller,
  // and falling spreads us a little wider, more the faster we're going. It all eases smoothly.
  const landed = p.onGround && !a.wasOnGround;
  const bounced = a.lastVy > 2 && vy < -5;
  // (Landing gives the spring below a push, so the squash grows quickly but smoothly.)
  if (landed || bounced) a.squashSpeed = LANDING_SQUASH_PUSH;
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
  ctx.strokeStyle = "rgba(90, 50, 140, 0.35)";
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
  ctx.save();
  ctx.translate(-camera.x, -camera.y);

  const tick = drawTick();
  for (const p of map.platforms) if (p.type === "moving") drawTrack(p); // tracks go behind everything
  for (const p of map.platforms) drawPlatform(p, tick);

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

    // Labels stack upward above the character: "you" first, then "IT" above that.
    ctx.textAlign = "center";
    let labelY = p.y - 8;
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
    // A little character in the winner's color, since players don't have names
    ctx.save();
    ctx.translate(centerX + ctx.measureText(text).width / 2 + 3, 36);
    ctx.scale(0.8, 0.8);
    drawCharacter(0, 0, w.color, STILL_POSE, false);
    ctx.restore();
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
