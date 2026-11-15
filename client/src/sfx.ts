// Tiny synthesized sound effects (no audio files). Everything is generated with WebAudio.
let ctx: AudioContext | null = null;
let muted = localStorage.getItem('bribot.muted') === '1';

export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  localStorage.setItem('bribot.muted', m ? '1' : '0');
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', gain = 0.07, slideTo?: number) {
  if (muted) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + start;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  } catch {
    /* audio is a nice-to-have */
  }
}

export const sfx = {
  /** someone else posted a chat message */
  pop: () => tone(520, 0, 0.09, 'sine', 0.05, 760),
  /** a new round starts */
  round: () => [392, 523, 659].forEach((f, i) => tone(f, i * 0.09, 0.16, 'triangle', 0.06)),
  /** an anonymous bribe just arrived */
  whisper: () => {
    tone(1320, 0, 0.12, 'sine', 0.06);
    tone(1760, 0.1, 0.22, 'sine', 0.06);
  },
  /** money landed in your wallet */
  coin: () => {
    tone(988, 0, 0.08, 'square', 0.04);
    tone(1319, 0.07, 0.3, 'square', 0.04);
  },
  /** voting begins */
  vote: () => [0, 0.16, 0.32].forEach((s) => tone(150, s, 0.14, 'sawtooth', 0.07, 70)),
  /** a player was voted out */
  out: () => tone(330, 0, 0.5, 'sawtooth', 0.06, 80),
  /** you caught the bot */
  win: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.11, i === 4 ? 0.6 : 0.18, 'triangle', 0.08)),
  /** the bot fooled you */
  lose: () => {
    [392, 349, 311, 262].forEach((f, i) => tone(f, i * 0.2, 0.3, 'sawtooth', 0.06));
    tone(60, 0.8, 0.9, 'square', 0.07, 40);
  },
};
