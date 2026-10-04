"""Synthesizes every sound effect and both music loops for Platform Tag.
Everything is generated from scratch (no samples), so it's free to use anywhere.
"""
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt
import os

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), "out")
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(7)


# ---------- building blocks ----------
def t_axis(dur):
    return np.arange(int(SR * dur)) / SR


def phase_from_freq(freq):
    """freq can be a number or an array (pitch sweep); returns the oscillator phase."""
    if np.isscalar(freq):
        return None
    return 2 * np.pi * np.cumsum(freq) / SR


def osc(kind, freq, dur):
    t = t_axis(dur)
    if np.isscalar(freq):
        ph = 2 * np.pi * freq * t
    else:
        ph = phase_from_freq(freq)
    if kind == "sine":
        return np.sin(ph)
    if kind == "tri":
        return 2 / np.pi * np.arcsin(np.sin(ph))
    if kind == "square":  # softened square: less harsh, less aliasing
        return np.tanh(3.0 * np.sin(ph))
    if kind == "saw":     # few harmonics, soft saw
        return sum(np.sin(k * ph) / k for k in range(1, 7)) * 0.6
    raise ValueError(kind)


def sweep(f0, f1, dur, curve="exp"):
    n = int(SR * dur)
    if curve == "exp":
        return f0 * (f1 / f0) ** np.linspace(0, 1, n)
    return np.linspace(f0, f1, n)


def env(dur, a=0.005, d=0.05, s=0.0, r=0.05, hold=None):
    """ADSR envelope. hold = how long the sustain lasts (defaults to whatever's left)."""
    n = int(SR * dur)
    na, nd, nr = int(SR * a), int(SR * d), int(SR * r)
    nh = n - na - nd - nr if hold is None else int(SR * hold)
    nh = max(nh, 0)
    e = np.concatenate([
        np.linspace(0, 1, max(na, 1), endpoint=False),
        np.linspace(1, s, max(nd, 1), endpoint=False),
        np.full(nh, s),
        np.linspace(s, 0, max(nr, 1)),
    ])
    if len(e) < n:
        e = np.pad(e, (0, n - len(e)))
    return e[:n]


def expdecay(dur, tau):
    return np.exp(-t_axis(dur) / tau)


def noise(dur):
    return rng.uniform(-1, 1, int(SR * dur))


def lowpass(x, fc, order=2):
    return sosfilt(butter(order, fc, "low", fs=SR, output="sos"), x)


def highpass(x, fc, order=2):
    return sosfilt(butter(order, fc, "high", fs=SR, output="sos"), x)


def bandpass(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def mix(*parts):
    n = max(len(p) for p in parts)
    out = np.zeros(n)
    for p in parts:
        out[: len(p)] += p
    return out


def place(buf, sound, at):
    """Add a sound into buf starting at time `at` (seconds). Wraps around (for seamless loops)."""
    start = int(SR * at)
    idx = (start + np.arange(len(sound))) % len(buf)
    np.add.at(buf, idx, sound)


def fade_edges(x, in_ms=0.5, out_ms=4):
    """Tiny fades so nothing clicks, without softening the attack of short sounds."""
    x = x.copy()
    ni, no = int(SR * in_ms / 1000), int(SR * out_ms / 1000)
    if len(x) > ni + no:
        x[:ni] *= np.linspace(0, 1, ni)
        x[-no:] *= np.linspace(1, 0, no)
    return x


def note(name):
    """'A4' -> Hz"""
    names = {"C": -9, "C#": -8, "D": -7, "D#": -6, "E": -5, "F": -4, "F#": -3,
             "G": -2, "G#": -1, "A": 0, "A#": 1, "B": 2}
    pitch, octave = name[:-1], int(name[-1])
    return 440.0 * 2 ** ((names[pitch] + 12 * (octave - 4)) / 12)


def save(name, x, loud=0.2):
    """Balance by loudness (RMS of the audible part), not by peak, so sounds sit together
    at similar volumes. Then cap the peak so nothing clips."""
    x = np.asarray(x, dtype=np.float64)
    x = x - np.mean(x)
    m = np.max(np.abs(x))
    if m > 0:
        active = x[np.abs(x) > m * 0.01]
        x = x * (loud / np.sqrt(np.mean(active ** 2)))
        if np.max(np.abs(x)) > 0.95:
            x = x / np.max(np.abs(x)) * 0.95
    x = fade_edges(x)
    wavfile.write(os.path.join(OUT, name + ".wav"), SR, (x * 32767).astype(np.int16))
    print(f"{name:20s} {len(x)/SR:6.2f}s")


def tone(kind, f, dur, a=0.004, tau=None, d=0.05, s=0.0, r=0.04):
    x = osc(kind, f, dur)
    if tau is not None:
        return x * expdecay(dur, tau) * env(dur, a=a, d=0.001, s=1.0, r=r)
    return x * env(dur, a=a, d=d, s=s, r=r)


# ---------- UI ----------
def ui_click():
    d = 0.05
    body = tone("sine", 1900, d, a=0.001, tau=0.012)
    tick = highpass(noise(d), 3000) * expdecay(d, 0.004) * 0.4
    return mix(body, tick)


def ui_error():
    a = tone("square", 330, 0.12, a=0.004, d=0.05, s=0.6, r=0.03)
    b = tone("square", 220, 0.2, a=0.004, d=0.08, s=0.5, r=0.06)
    out = np.zeros(int(SR * 0.34))
    place(out, lowpass(a, 2500), 0.0)
    place(out, lowpass(b, 2000), 0.13)
    return out


# ---------- movement ----------
def jump():
    d = 0.17
    f = sweep(260, 720, d)
    x = osc("square", f, d) * env(d, a=0.003, d=0.12, s=0.15, r=0.04)
    return lowpass(x, 3500)


def land():
    d = 0.16
    thump = osc("sine", sweep(140, 55, d), d) * expdecay(d, 0.05)
    dust = lowpass(noise(d), 900) * expdecay(d, 0.03) * 0.7
    return mix(thump, dust)


def step():
    d = 0.06
    x = bandpass(noise(d), 300, 1800) * expdecay(d, 0.012)
    knock = osc("sine", sweep(220, 140, d), d) * expdecay(d, 0.015) * 0.6
    return mix(x, knock)


def step_ice():
    d = 0.09
    glass = mix(tone("sine", 2600, d, a=0.001, tau=0.02),
                tone("sine", 3900, d, a=0.001, tau=0.015) * 0.5)
    scrape = highpass(noise(d), 4000) * expdecay(d, 0.02) * 0.6
    return mix(glass, scrape)


def jumppad():
    d = 0.45
    t = t_axis(d)
    base = sweep(170, 620, d)
    wobble = 1 + 0.08 * np.sin(2 * np.pi * 18 * t) * np.exp(-t / 0.2)
    x = osc("tri", base * wobble, d) * env(d, a=0.003, d=0.3, s=0.2, r=0.1)
    spring = osc("sine", sweep(90, 60, 0.12), 0.12) * expdecay(0.12, 0.04)
    return mix(x, spring * 0.8)


def orb():
    out = np.zeros(int(SR * 0.45))
    for i, n in enumerate(["E6", "G#6", "B6", "E7"]):
        place(out, tone("sine", note(n), 0.3, a=0.002, tau=0.09) * (1 - i * 0.12), i * 0.045)
    whoosh = bandpass(noise(0.2), 1500, 6000) * env(0.2, a=0.05, d=0.1, s=0, r=0.05) * 0.25
    place(out, whoosh, 0)
    return out


# ---------- powerups ----------
def powerup_speed():
    out = np.zeros(int(SR * 0.45))
    for i, n in enumerate(["C5", "E5", "G5", "C6", "E6", "G6"]):
        place(out, lowpass(tone("square", note(n), 0.08, a=0.002, d=0.05, s=0.3, r=0.02), 5000), i * 0.04)
    zip_ = bandpass(noise(0.3), 2000, 8000) * env(0.3, a=0.02, d=0.25, s=0, r=0.03) * 0.3
    place(out, zip_, 0.05)
    return out


def powerup_jump():
    out = np.zeros(int(SR * 0.5))
    a = tone("tri", sweep(note("G4"), note("G5"), 0.18), 0.18, a=0.003, d=0.1, s=0.5, r=0.04)
    b = tone("tri", sweep(note("C5"), note("C6"), 0.25), 0.25, a=0.003, d=0.15, s=0.4, r=0.08)
    place(out, a, 0)
    place(out, b, 0.16)
    place(out, tone("sine", note("C7"), 0.25, a=0.002, tau=0.07) * 0.3, 0.2)
    return out


# ---------- tag ----------
def tag_freeze():
    d = 0.8
    out = np.zeros(int(SR * d))
    # icy crackle burst
    crack = highpass(noise(0.25), 2500) * expdecay(0.25, 0.05)
    crack *= (rng.uniform(0, 1, len(crack)) > 0.85)  # sparse crackles
    place(out, crack * 1.2, 0)
    # glassy shimmer sliding down
    for f0, amp in [(3200, 0.5), (2400, 0.6), (1600, 0.7), (4100, 0.3)]:
        place(out, tone("sine", sweep(f0, f0 * 0.6, 0.7), 0.7, a=0.005, tau=0.22) * amp, 0.02)
    # low "thunk" of being frozen solid
    place(out, osc("sine", sweep(180, 80, 0.2), 0.2) * expdecay(0.2, 0.06) * 0.9, 0)
    return out


def unfreeze():
    d = 0.4
    out = np.zeros(int(SR * d))
    for i, f in enumerate([1500, 2100, 2900]):
        place(out, tone("sine", sweep(f, f * 1.4, 0.2), 0.2, a=0.003, tau=0.07) * 0.6, i * 0.05)
    place(out, highpass(noise(0.15), 3500) * expdecay(0.15, 0.03) * 0.3, 0)
    return out


def tag_whiff():
    d = 0.22
    n = noise(d)
    x = np.zeros_like(n)
    # sweep a bandpass upward by filtering chunks
    chunks = 11
    size = len(n) // chunks
    for i in range(chunks):
        lo = 500 + i * 220
        seg = bandpass(n, lo, lo * 2.2)[i * size:(i + 1) * size]
        x[i * size:(i + 1) * size] = seg
    return x * env(d, a=0.04, d=0.15, s=0, r=0.03)


def you_are_it():
    out = np.zeros(int(SR * 0.7))
    for i, f in enumerate([880, 660, 880, 660]):
        place(out, lowpass(tone("square", f, 0.13, a=0.003, d=0.05, s=0.6, r=0.02), 4000), i * 0.15)
    return out


# ---------- round flow ----------
def countdown_tick():
    return lowpass(tone("square", 660, 0.14, a=0.002, d=0.08, s=0.3, r=0.03), 3500)


def countdown_go():
    d = 0.5
    a = tone("square", 1320, d, a=0.002, d=0.2, s=0.5, r=0.15)
    b = tone("sine", 660, d, a=0.002, d=0.2, s=0.5, r=0.15) * 0.6
    return lowpass(mix(a, b), 5000)


def round_ending_tick():
    d = 0.07
    wood = mix(tone("sine", 1050, d, a=0.001, tau=0.015), tone("sine", 2300, d, a=0.001, tau=0.008) * 0.4)
    return wood


def round_end():
    d = 0.9
    out = np.zeros(int(SR * d))
    # referee-style whistle with a trill
    t = t_axis(0.6)
    f = 2400 * (1 + 0.03 * np.sin(2 * np.pi * 28 * t))
    whistle = osc("sine", f, 0.6) * env(0.6, a=0.01, d=0.05, s=0.8, r=0.08)
    breath = bandpass(noise(0.6), 2000, 3200) * env(0.6, a=0.01, d=0.05, s=0.8, r=0.08) * 0.25
    place(out, whistle + breath, 0)
    return out


def win():
    out = np.zeros(int(SR * 1.8))
    seq = ["C5", "E5", "G5", "C6"]
    for i, n in enumerate(seq):
        place(out, lowpass(tone("square", note(n), 0.14, a=0.003, d=0.06, s=0.5, r=0.03), 4500) * 0.7, i * 0.11)
    # final chord
    for n in ["C5", "E5", "G5", "C6", "E6"]:
        place(out, tone("tri", note(n), 1.2, a=0.005, d=0.3, s=0.5, r=0.5) * 0.45, 0.46)
    sparkle = np.zeros(int(SR * 0.8))
    for i in range(8):
        place(sparkle, tone("sine", note(["C7", "G6", "E7", "C7"][i % 4]), 0.15, a=0.001, tau=0.04) * 0.25, i * 0.07)
    place(out, sparkle, 0.5)
    return out


def lose():
    out = np.zeros(int(SR * 2.0))
    notes = [("D4", 0.32), ("C#4", 0.32), ("C4", 0.32)]
    at = 0.0
    for n, d in notes:
        place(out, lowpass(tone("saw", note(n), d, a=0.02, d=0.1, s=0.7, r=0.06), 1600), at)
        at += d + 0.04
    # long sad note with wobble
    d = 0.9
    t = t_axis(d)
    f = note("B3") * (1 + 0.025 * np.sin(2 * np.pi * 5.5 * t) * np.clip(t / 0.3, 0, 1))
    place(out, lowpass(osc("saw", f, d) * env(d, a=0.02, d=0.1, s=0.75, r=0.35), 1400), at)
    return out


def player_join():
    d = 0.1
    return tone("sine", sweep(480, 950, d), d, a=0.002, d=0.07, s=0, r=0.02)


# ---------- music ----------
def kick(d=0.25):
    return osc("sine", sweep(150, 45, d), d) * expdecay(d, 0.07)


def snare(d=0.18):
    return mix(bandpass(noise(d), 1500, 7000) * expdecay(d, 0.045) * 0.7,
               osc("sine", 190, d) * expdecay(d, 0.03) * 0.5)


def hat(d=0.04):
    return highpass(noise(d), 7000) * expdecay(d, 0.012)


def pluck(f, d=0.25, bright=3500):
    return lowpass(osc("square", f, d) * expdecay(d, 0.09) * env(d, a=0.003, d=0.001, s=1, r=0.03), bright)


def pad(freqs, d):
    x = sum(osc("tri", f, d) + 0.4 * osc("sine", f * 2.003, d) for f in freqs)
    return lowpass(x, 1800) * env(d, a=0.25, d=0.2, s=0.8, r=0.4)


def bass(f, d):
    return lowpass(osc("saw", f, d), 700) * env(d, a=0.005, d=0.1, s=0.6, r=0.04)


def music_game():
    bpm = 128
    beat = 60 / bpm
    bars = 8
    length = bars * 4 * beat
    out = np.zeros(int(SR * length))
    # I - V - vi - IV in C, twice
    chords = [["C4", "E4", "G4"], ["G3", "B3", "D4"], ["A3", "C4", "E4"], ["F3", "A3", "C4"]] * 2
    roots = ["C2", "G2", "A2", "F2"] * 2
    melody = [  # (beat offset within bar, note, beats)
        [(0, "E5", 1), (1, "G5", 0.5), (1.5, "E5", 0.5), (2, "D5", 1), (3, "C5", 1)],
        [(0, "D5", 1.5), (1.5, "B4", 0.5), (2, "D5", 1), (3, "G5", 1)],
        [(0, "C5", 1), (1, "E5", 0.5), (1.5, "A5", 0.5), (2, "G5", 1), (3, "E5", 1)],
        [(0, "F5", 1), (1, "E5", 1), (2, "C5", 1.5), (3.5, "D5", 0.5)],
        [(0, "E5", 1), (1, "G5", 0.5), (1.5, "C6", 0.5), (2, "B5", 1), (3, "G5", 1)],
        [(0, "A5", 1), (1, "G5", 0.5), (1.5, "D5", 0.5), (2, "B4", 1), (3, "D5", 1)],
        [(0, "C5", 0.5), (0.5, "E5", 0.5), (1, "A5", 1), (2, "G5", 0.5), (2.5, "E5", 0.5), (3, "C5", 1)],
        [(0, "F5", 1), (1, "A5", 1), (2, "G5", 1), (3, "E5", 1)],
    ]
    for b in range(bars):
        t0 = b * 4 * beat
        for k in range(4):
            place(out, kick() * 0.9, t0 + k * beat)
            if k in (1, 3):
                place(out, snare() * 0.45, t0 + k * beat)
            for h in range(2):
                place(out, hat() * (0.18 if h else 0.12), t0 + k * beat + h * beat / 2)
        # bass: root on eighths with an octave bounce
        root = note(roots[b])
        for e in range(8):
            f = root * (2 if e % 4 == 3 else 1)
            place(out, bass(f, beat / 2 * 0.9) * 0.45, t0 + e * beat / 2)
        # chord stabs on the off-beats
        for k in range(4):
            stab = sum(pluck(note(n), 0.18, 2500) for n in chords[b])
            place(out, stab * 0.12, t0 + k * beat + beat / 2)
        # lead
        for off, n, ln in melody[b]:
            d = ln * beat * 0.92
            lead = lowpass(osc("square", note(n), d), 3000) * env(d, a=0.005, d=0.08, s=0.55, r=0.05)
            place(out, lead * 0.16, t0 + off * beat)
    return out


def music_menu():
    bpm = 84
    beat = 60 / bpm
    bars = 8
    length = bars * 4 * beat
    out = np.zeros(int(SR * length))
    chords = [["F3", "A3", "C4", "E4"], ["C3", "E3", "G3", "B3"], ["D3", "F3", "A3", "C4"], ["A#2", "D3", "F3", "A3"]] * 2
    for b in range(bars):
        t0 = b * 4 * beat
        freqs = [note(n) for n in chords[b]]
        place(out, pad(freqs, 4 * beat * 1.05) * 0.18, t0)
        # gentle arpeggio, music-box style
        arp = freqs + [freqs[1] * 2, freqs[2] * 2]
        order = [0, 2, 1, 3, 4, 3, 2, 5]
        for i, idx in enumerate(order):
            f = arp[idx % len(arp)] * 2
            box = tone("sine", f, 0.6, a=0.002, tau=0.25) + 0.3 * tone("sine", f * 3, 0.6, a=0.002, tau=0.08)
            place(out, box * 0.22, t0 + i * beat / 2)
        # soft low root
        place(out, lowpass(osc("sine", freqs[0] / 2, 4 * beat), 300) * env(4 * beat, a=0.1, d=0.5, s=0.5, r=0.5) * 0.35, t0)
    return out


if __name__ == "__main__":
    sfx = [ui_click, ui_error, jump, land, step, step_ice, jumppad, orb,
           powerup_speed, powerup_jump, tag_freeze, unfreeze, tag_whiff, you_are_it,
           countdown_tick, countdown_go, round_ending_tick, round_end, win, lose, player_join]
    # How loud each one should sit (RMS). Frequent/background sounds are quieter.
    loudness = {"ui_click": 0.09, "step": 0.08, "step_ice": 0.07, "round_ending_tick": 0.09,
                "player_join": 0.1, "tag_whiff": 0.1, "ui_error": 0.15, "countdown_tick": 0.16,
                "jump": 0.15, "land": 0.17, "you_are_it": 0.2, "tag_freeze": 0.2,
                "win": 0.2, "lose": 0.2}
    for fn in sfx:
        save(fn.__name__, fn(), loud=loudness.get(fn.__name__, 0.18))
    # music: no edge fades, they loop
    for fn in [music_menu, music_game]:
        x = fn()
        x = x / np.max(np.abs(x)) * 0.8
        wavfile.write(os.path.join(OUT, fn.__name__ + ".wav"), SR, (x * 32767).astype(np.int16))
        print(f"{fn.__name__:20s} {len(x)/SR:6.2f}s (loop)")
