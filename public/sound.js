// ===== Sound =====
// Loads every sound in public/sounds/ and plays it with the Web Audio API.
// Only the browser uses this file: the server never makes a sound.
//
// Every sound name (the file is sounds/<name>.wav, or .mp3 for the two music tracks):
//   music_menu, music_game, ui_click, ui_error, jump, land, step, step_ice, jumppad, orb,
//   powerup_speed, powerup_jump, tag_freeze, unfreeze, tag_whiff, you_are_it, countdown_tick,
//   countdown_go, round_ending_tick, round_end, win, lose, player_join
//
// How the sound travels (each box is a Web Audio "node", and sound flows left to right):
//
//   effect:  [file] -> [voice volume] -> [left/right pan] -> [Effects volume] --+
//                                                                             +--> [mute] -> speakers
//   music:   [file] -> [crossfade volume] ------------------> [Music volume] --+
//
// Use it from game.js like this:
//   Sound.play("jump")                                    // at full volume, in the middle
//   Sound.play("land", { volume: 0.5, x: 1200, y: 300 })  // quieter, from that spot on the map
//   Sound.playMusic("music_game")                         // crossfade to this track

(function (exports) {
  // ===== Tweakable constants (try changing these!) =====
  // Hearing sounds from somewhere on the map ("positional" sounds):
  const HEARING_RANGE = 900;     // world units: anything further away than this is silent
  const FULL_VOLUME_RANGE = 150; // world units: anything closer than this is at full volume
  const FALLOFF_POWER = 2;       // how the volume drops in between: 1 = steady straight line,
                                 // 2 = drops quickly at first then tails off (sounds more natural)
  const PAN_DISTANCE = 600;      // world units to one side of us where a sound is panned all the way
  const MAX_PAN = 0.8;           // how far "all the way" is (1 = only one ear, which sounds odd)

  const PITCH_VARIATION = 0.05;  // each play is up to 5% higher or lower, so repeats don't sound robotic
  const MAX_VOICES = 4;          // at most this many copies of the same sound at once (the oldest stops)

  // Music
  const MUSIC_FADE_SECONDS = 1;  // how long the crossfade between the two tracks takes
  const MUSIC_TRACK_VOLUME = { music_menu: 0.8, music_game: 0.45 }; // the game music is kept quiet
  // MP3 files get a few milliseconds of silence added at the start and end when they're made,
  // which would leave a gap every time the music loops. We skip it (see loopPoints).
  const LOOP_SILENCE_LEVEL = 0.001; // samples quieter than this (full volume is 1) count as silence
  const LOOP_MAX_TRIM = 0.1;        // never trim more than this many seconds from either end

  const SOUND_NAMES = [
    "music_menu", "music_game", "ui_click", "ui_error", "jump", "land", "step", "step_ice", "jumppad", "orb",
    "powerup_speed", "powerup_jump", "tag_freeze", "unfreeze", "tag_whiff", "you_are_it", "countdown_tick",
    "countdown_go", "round_ending_tick", "round_end", "win", "lose", "player_join",
  ];

  // ===== Settings (the sound panel) =====
  // Remembered in this browser. (Browser storage can be switched off, so it's only a convenience.)
  const SETTINGS_KEY = "platform-tag-sound";
  const settings = { music: 0.7, effects: 0.8, muted: false }; // volumes go from 0 to 1
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (saved && typeof saved === "object") {
      if (typeof saved.music === "number") settings.music = clamp(saved.music, 0, 1);
      if (typeof saved.effects === "number") settings.effects = clamp(saved.effects, 0, 1);
      if (typeof saved.muted === "boolean") settings.muted = saved.muted;
    }
  } catch (e) {}

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  // ===== Setup =====
  // The AudioContext is the whole sound system: it owns the clock, the nodes and the speakers.
  // Very old browsers don't have one; then every function below quietly does nothing.
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const ctx = AudioContextClass ? new AudioContextClass() : null;

  let masterGain, musicGain, effectsGain;
  if (ctx) {
    masterGain = ctx.createGain();   // the mute button
    musicGain = ctx.createGain();    // the Music slider
    effectsGain = ctx.createGain();  // the Effects slider
    musicGain.connect(masterGain);
    effectsGain.connect(masterGain);
    masterGain.connect(ctx.destination); // the speakers
    applySettings(true);
  }

  // A slider's position (0 to 1) as a gain. Our ears hear loudness on a curve, so a straight
  // line would do almost everything in the top part of the slider. Squaring it spreads it out.
  function sliderToGain(value) {
    return value * value;
  }

  // Set the three volumes from the settings. Normally they glide there over a few milliseconds
  // (jumping a gain instantly makes a little click); "instant" is for the very first time.
  function applySettings(instant) {
    if (!ctx) return;
    const set = (param, value) => {
      if (instant) param.value = value;
      else param.setTargetAtTime(value, ctx.currentTime, 0.02);
    };
    set(masterGain.gain, settings.muted ? 0 : 1);
    set(musicGain.gain, sliderToGain(settings.music));
    set(effectsGain.gain, sliderToGain(settings.effects));
  }

  // ===== Loading =====
  // Every sound is downloaded and decoded into raw samples (an AudioBuffer) once, up front,
  // so playing it later is instant. A missing or broken file is just skipped: playing it does nothing.
  const buffers = {}; // name -> AudioBuffer
  const loopInfo = {}; // music name -> { start, end } in seconds (see loopPoints)

  if (ctx) {
    for (const name of SOUND_NAMES) {
      const file = "sounds/" + name + (name.startsWith("music_") ? ".mp3" : ".wav");
      fetch(file)
        .then((res) => { if (!res.ok) throw new Error(file + ": " + res.status); return res.arrayBuffer(); })
        .then((data) => ctx.decodeAudioData(data))
        .then((buffer) => {
          buffers[name] = buffer;
          if (name.startsWith("music_")) loopInfo[name] = loopPoints(buffer);
          if (name === wantedMusic) playMusic(name); // it was asked for before it finished loading
        })
        .catch(() => {}); // skip it silently
    }
  }

  // Where the sound really starts and ends inside a music file, skipping the silence MP3 adds
  // to each end. We look for the first and last sample that's louder than LOOP_SILENCE_LEVEL
  // (in any channel), but never trim more than LOOP_MAX_TRIM, in case the music starts softly.
  function loopPoints(buffer) {
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const loud = (i) => channels.some((samples) => Math.abs(samples[i]) > LOOP_SILENCE_LEVEL);
    const maxTrim = Math.floor(LOOP_MAX_TRIM * buffer.sampleRate);

    let start = 0;
    while (start < maxTrim && !loud(start)) start++;
    let end = buffer.length;
    while (buffer.length - end < maxTrim && end > start + 1 && !loud(end - 1)) end--;
    return { start: start / buffer.sampleRate, end: end / buffer.sampleRate };
  }

  // ===== Unlocking =====
  // Browsers won't let a page make any sound until the player has clicked or pressed a key,
  // so the AudioContext starts out "suspended". The first click or key press anywhere (pressing
  // Play counts too) wakes it up. Until then, play() does nothing (instead of saving every
  // sound up and blasting them all at once).
  let unlocked = false;

  function unlock() {
    if (!ctx) return;
    unlocked = true;
    if (ctx.state !== "running") ctx.resume().catch(() => {});
    if (wantedMusic) playMusic(wantedMusic);
  }

  // Keep listening until it has really started (some keys, like Escape, don't count).
  const GESTURES = ["pointerdown", "keydown", "touchend"];
  if (ctx) {
    for (const type of GESTURES) window.addEventListener(type, unlock, true);
    ctx.addEventListener("statechange", () => {
      if (ctx.state === "running") for (const type of GESTURES) window.removeEventListener(type, unlock, true);
    });
  }

  // ===== Where we're listening from =====
  // game.js tells us where our own player is every frame (world units). null = not in the game,
  // so positional sounds play as if they were right next to us.
  let listener = null;

  function setListener(x, y) {
    listener = x === null || x === undefined ? null : { x, y };
  }

  // ===== Sound effects =====
  // The copies of each sound playing right now, oldest first: name -> [{ source, gain }, ...]
  const voices = {};

  // Play a sound effect. options (all optional):
  //   volume: 0 to 1 (default 1), on top of the Effects slider
  //   x, y:   where on the map it happens. It gets quieter the further it is from our player,
  //           is silent past HEARING_RANGE, and comes from the left or right speaker.
  function play(name, options = {}) {
    if (!ctx || !unlocked) return;
    const buffer = buffers[name];
    if (!buffer) return; // missing, broken, or still loading

    let volume = options.volume === undefined ? 1 : options.volume;
    let pan = 0;
    if (options.x !== undefined && options.y !== undefined && listener) {
      const dx = options.x - listener.x, dy = options.y - listener.y;
      const distance = Math.hypot(dx, dy);
      if (distance >= HEARING_RANGE) return; // too far away to hear
      volume *= distanceVolume(distance);
      pan = clamp(dx / PAN_DISTANCE, -1, 1) * MAX_PAN; // negative = to our left
    }
    if (volume <= 0.001) return;

    // Too many copies already? Stop the oldest to make room.
    const playing = voices[name] || (voices[name] = []);
    while (playing.length >= MAX_VOICES) stopVoice(playing.shift());

    // Build this sound's own little chain: file -> volume -> pan -> Effects slider.
    // (Nodes are cheap and meant to be used once, then thrown away.)
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // Playing it slightly faster or slower also makes it slightly higher or lower.
    source.playbackRate.value = 1 + (Math.random() * 2 - 1) * PITCH_VARIATION;

    const gain = ctx.createGain();
    gain.gain.value = volume;
    source.connect(gain);

    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      gain.connect(panner);
      panner.connect(effectsGain);
    } else {
      gain.connect(effectsGain); // (very old Safari: no panning, but still plays)
    }

    const voice = { source, gain };
    playing.push(voice);
    source.onended = () => {
      const i = playing.indexOf(voice);
      if (i >= 0) playing.splice(i, 1);
      gain.disconnect();
    };
    source.start();
  }

  // How loud a sound is at this distance: 1 up to FULL_VOLUME_RANGE, falling to 0 at HEARING_RANGE.
  function distanceVolume(distance) {
    const t = clamp((distance - FULL_VOLUME_RANGE) / (HEARING_RANGE - FULL_VOLUME_RANGE), 0, 1);
    return Math.pow(1 - t, FALLOFF_POWER);
  }

  // Stop a sound early, with a very quick fade so it doesn't click.
  function stopVoice(voice) {
    const now = ctx.currentTime;
    voice.gain.gain.setTargetAtTime(0, now, 0.01);
    voice.source.stop(now + 0.05);
  }

  // ===== Music =====
  // One track loops at a time. Switching fades the old one out while the new one fades in.
  let wantedMusic = null;  // the track that should be playing (even if it can't start yet)
  let currentMusic = null; // the track actually playing: { name, source, gain }

  function playMusic(name) {
    wantedMusic = name;
    if (currentMusic && currentMusic.name === name) return; // already on
    if (!ctx || !unlocked || !buffers[name]) return; // starts as soon as we're unlocked and it's loaded

    const now = ctx.currentTime;
    if (currentMusic) fadeOutMusic(currentMusic, now);

    const buffer = buffers[name];
    const loop = loopInfo[name];
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    // Loop only the part between the silences, so it goes round with no gap.
    source.loopStart = loop.start;
    source.loopEnd = loop.end;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(MUSIC_TRACK_VOLUME[name] || 0.6, now + MUSIC_FADE_SECONDS);
    source.connect(gain);
    gain.connect(musicGain);
    source.start(now, loop.start); // start where the sound starts, too

    currentMusic = { name, source, gain };
  }

  function fadeOutMusic(music, now) {
    const g = music.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now); // start the fade from wherever it is now (maybe mid fade-in)
    g.linearRampToValueAtTime(0, now + MUSIC_FADE_SECONDS);
    music.source.stop(now + MUSIC_FADE_SECONDS + 0.05);
    music.source.onended = () => music.gain.disconnect();
  }

  // ===== Changing the settings =====
  function setMusicVolume(value) { settings.music = clamp(value, 0, 1); applySettings(); saveSettings(); }
  function setEffectsVolume(value) { settings.effects = clamp(value, 0, 1); applySettings(); saveSettings(); }
  function setMuted(muted) { settings.muted = !!muted; applySettings(); saveSettings(); }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  exports.HEARING_RANGE = HEARING_RANGE;
  exports.settings = settings; // read only: change it with the set... functions
  exports.unlock = unlock;
  exports.setListener = setListener;
  exports.play = play;
  exports.playMusic = playMusic;
  exports.setMusicVolume = setMusicVolume;
  exports.setEffectsVolume = setEffectsVolume;
  exports.setMuted = setMuted;
})(window.Sound = {});
