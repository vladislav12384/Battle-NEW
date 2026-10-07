/** Tiny synthesized sound effects (no asset files needed for the prototype). */
export type Sfx =
  | 'whoosh'
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
  | 'dodge';

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
        this.hiss('bandpass', 600, 1.2, 0.12 * k, 0.16, 2200);
        break;
      case 'dodge':
        this.hiss('bandpass', 1400, 0.8, 0.1, 0.18, 400);
        break;
      case 'hitLight':
        this.tone('sine', 180, 60, 0.5 * k, 0.12);
        this.hiss('bandpass', 1800, 0.9, 0.35 * k, 0.07);
        break;
      case 'hitHeavy':
        this.tone('sine', 120, 35, 0.8 * k, 0.28);
        this.tone('square', 90, 40, 0.12 * k, 0.12);
        this.hiss('lowpass', 2500, 0.7, 0.5 * k, 0.18, 300);
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
