/** Tiny synthesized sound effects (no asset files needed for the prototype). */
export type Sfx =
  | 'whoosh'
  | 'whooshHeavy'
  | 'miss'
  | 'exhausted'
  | 'boom'
  | 'hitLight'
  | 'hitHeavy'
  | 'block'
  | 'parry'
  | 'clash'
  | 'guardBreak'
  | 'burst'
  | 'land'
  | 'ko'
  | 'blast'
  | 'counter'
  | 'dodge'
  | 'tell'
  | 'tellHeavy'
  | 'perfect'
  | 'mash'
  | 'beat'
  | 'poise'
  | 'impact';

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  volume = 0.5;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  private env(gain: number, attack: number, decay: number, at: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    g.connect(this.master!);
    return g;
  }

  private tone(type: OscillatorType, f0: number, f1: number, gain: number, decay: number, delay = 0): void {
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + decay);
    o.connect(this.env(gain, 0.003, decay, t));
    o.start(t);
    o.stop(t + decay + 0.05);
  }

  private hiss(filter: BiquadFilterType, freq: number, q: number, gain: number, decay: number, sweepTo?: number): void {
    const c = this.ctx!;
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const bq = c.createBiquadFilter();
    bq.type = filter;
    bq.frequency.setValueAtTime(freq, t);
    if (sweepTo) bq.frequency.exponentialRampToValueAtTime(sweepTo, t + decay);
    bq.Q.value = q;
    src.connect(bq);
    bq.connect(this.env(gain, 0.004, decay, t));
    src.start(t, Math.random() * 0.5);
    src.stop(t + decay + 0.05);
  }

  play(s: Sfx, intensity = 1): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const k = Math.min(1.5, Math.max(0.3, intensity));
    switch (s) {
      case 'whoosh':
        this.hiss('bandpass', 700, 1.2, 0.1 * k, 0.14, 2400);
        break;
      case 'whooshHeavy':
        this.hiss('bandpass', 380, 1.0, 0.16 * k, 0.32, 1600);
        this.tone('sine', 140, 70, 0.08 * k, 0.25);
        break;
      case 'miss':
        // Air cut with nothing at the end of it.
        this.hiss('bandpass', 1600, 1.4, 0.09 * k, 0.22, 500);
        break;
      case 'exhausted':
        // Heavy breath: two filtered noise puffs.
        this.hiss('bandpass', 900, 0.7, 0.18, 0.35, 500);
        this.hiss('bandpass', 700, 0.7, 0.14, 0.45, 400);
        break;
      case 'boom':
        // Sub-bass thump under heavy impacts.
        this.tone('sine', 65, 28, 0.9 * k, 0.45);
        this.tone('triangle', 110, 40, 0.25 * k, 0.2);
        break;
      case 'dodge':
        this.hiss('bandpass', 1400, 0.8, 0.1, 0.18, 400);
        break;
      case 'tell':
        // A glint of steel: an enemy heavy blow is winding up at you.
        this.tone('sine', 1760, 1700, 0.12 * k, 0.18);
        this.tone('sine', 2637, 2600, 0.06 * k, 0.12);
        break;
      case 'tellHeavy':
        // Unblockable: lower, harsher warning.
        this.tone('sawtooth', 330, 300, 0.12 * k, 0.3);
        this.tone('sine', 880, 860, 0.12 * k, 0.3);
        break;
      case 'perfect':
        // Time bends: a rising shimmer.
        this.tone('sine', 500, 2400, 0.22, 0.35);
        this.tone('triangle', 1200, 3600, 0.08, 0.3, 0.04);
        this.hiss('highpass', 4000, 0.5, 0.15, 0.3, 9000);
        break;
      case 'mash':
        this.tone('square', 140, 110, 0.06, 0.06);
        break;
      case 'beat':
        // On-beat tick; pitch climbs with the rhythm level (intensity).
        this.tone('triangle', 900 * k, 880 * k, 0.1, 0.07);
        break;
      case 'poise':
        this.tone('square', 220, 160, 0.16, 0.18);
        this.hiss('bandpass', 2500, 1.2, 0.25, 0.12);
        break;
      case 'impact':
        // Anime impact frame: a sharp crack over the boom.
        this.hiss('highpass', 3000, 0.4, 0.5 * k, 0.09);
        this.tone('square', 60, 30, 0.35 * k, 0.25);
        break;
      case 'hitLight':
        // Thud + skin crack.
        this.tone('sine', 170 + Math.random() * 30, 55, 0.6 * k, 0.14);
        this.hiss('bandpass', 2200 + Math.random() * 600, 1.1, 0.4 * k, 0.05);
        this.hiss('lowpass', 900, 0.6, 0.25 * k, 0.1, 200);
        break;
      case 'hitHeavy':
        this.tone('sine', 110 + Math.random() * 20, 32, 0.95 * k, 0.32);
        this.tone('square', 85, 38, 0.14 * k, 0.14);
        this.hiss('bandpass', 1800, 0.8, 0.45 * k, 0.07);
        this.hiss('lowpass', 2600, 0.7, 0.55 * k, 0.24, 250);
        break;
      case 'counter':
        this.tone('triangle', 900, 300, 0.25, 0.15);
        break;
      case 'block':
        this.tone('triangle', 520, 380, 0.25 * k, 0.09);
        this.hiss('highpass', 3000, 0.7, 0.2 * k, 0.06);
        break;
      case 'parry':
        this.tone('sine', 2093, 2000, 0.35, 0.5);
        this.tone('sine', 3136, 3000, 0.2, 0.35);
        this.hiss('highpass', 5000, 0.5, 0.25, 0.08);
        break;
      case 'clash':
        this.tone('square', 1500, 700, 0.15, 0.25);
        this.tone('sine', 2600, 2400, 0.2, 0.3);
        this.hiss('bandpass', 4000, 1, 0.3, 0.15);
        break;
      case 'guardBreak':
        this.hiss('highpass', 2000, 0.4, 0.6, 0.45, 6000);
        this.tone('sawtooth', 300, 60, 0.25, 0.4);
        break;
      case 'burst':
        this.tone('sine', 80, 30, 0.9, 0.6);
        this.hiss('lowpass', 4000, 0.5, 0.6, 0.6, 200);
        break;
      case 'land':
        this.tone('sine', 90, 40, 0.3 * k, 0.1);
        break;
      case 'ko':
        this.tone('sine', 70, 25, 1, 1.0);
        this.hiss('lowpass', 1200, 0.5, 0.5, 0.8, 100);
        break;
      case 'blast':
        this.tone('sawtooth', 220, 880, 0.12, 0.25);
        this.hiss('bandpass', 2400, 2, 0.2, 0.25, 600);
        break;
    }
  }
}
