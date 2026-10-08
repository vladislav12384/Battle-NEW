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
  | 'impact'
  | 'slap'
  | 'thump'
  | 'opticCharge'
  | 'optic'
  | 'opticFloor'
  | 'sizzle'
  | 'card'
  | 'ricochet'
  | 'calc'
  | 'opticSuper'
  | 'ignite'
  | 'burn'
  | 'pointBlank'
  | 'geneSplice'
  | 'cyclone'
  | 'megaStart'
  | 'beamHum'
  | 'megaEnd'
  | 'meteor';

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
      case 'slap':
        // Knuckles on a face: a dry, sharp crack.
        this.hiss('bandpass', 3200 + Math.random() * 800, 1.6, 0.35 * k, 0.045);
        this.tone('triangle', 420, 180, 0.15 * k, 0.06);
        break;
      case 'thump':
        // Into the body: a deep, padded thud.
        this.tone('sine', 95 + Math.random() * 15, 45, 0.55 * k, 0.18);
        this.hiss('lowpass', 500, 0.7, 0.3 * k, 0.12, 150);
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
      case 'opticCharge':
        // The visor powers up: a thin rising whine.
        this.tone('sine', 520, 2100, 0.07 * k, 0.26);
        this.tone('triangle', 1040, 3600, 0.03 * k, 0.24, 0.03);
        this.hiss('bandpass', 3000, 3, 0.05 * k, 0.24, 7000);
        break;
      case 'optic':
        // Eye beam: a hard, bright zap with a punch under it.
        this.tone('sawtooth', 2200, 240, 0.16 * k, 0.2);
        this.tone('square', 1100, 140, 0.08 * k, 0.16);
        this.tone('sine', 150, 50, 0.45 * k, 0.22);
        this.hiss('highpass', 3500, 0.6, 0.22 * k, 0.12, 9000);
        break;
      case 'opticFloor':
        // Beam into the floor: zap, blast, debris.
        this.tone('sawtooth', 1900, 200, 0.14 * k, 0.18);
        this.tone('sine', 90, 30, 0.85 * k, 0.5);
        this.hiss('lowpass', 3200, 0.6, 0.5 * k, 0.45, 160);
        this.hiss('bandpass', 1800, 0.8, 0.18 * k, 0.6, 400);
        break;
      case 'card':
        // A card flips open: a bright shimmer and a low swell.
        this.tone('sine', 660, 1320, 0.12, 0.35);
        this.tone('sine', 990, 1980, 0.08, 0.4, 0.08);
        this.tone('triangle', 1320, 2640, 0.06, 0.5, 0.16);
        this.tone('sine', 110, 220, 0.25, 0.6);
        this.hiss('highpass', 6000, 0.5, 0.08, 0.6, 12000);
        break;
      case 'sizzle':
        // A scorched surface hissing.
        this.hiss('highpass', 4200, 0.7, 0.16 * k, 0.4, 2400);
        this.tone('triangle', 700, 300, 0.05 * k, 0.12);
        break;
      case 'ricochet': {
        // A beam glancing off stone: a bright zing that drops away, a crack under it.
        // Intensity above 1 raises the pitch (later bounces sing higher).
        const up = Math.max(1, intensity);
        this.tone('sine', 3400 * up, 900 * up, 0.12, 0.22);
        this.tone('triangle', 1900 * up, 600, 0.07, 0.18, 0.01);
        this.hiss('bandpass', 5200, 2.2, 0.16, 0.08, 2600);
        this.tone('sine', 160, 60, 0.3, 0.12);
        break;
      }
      case 'calc':
        // The visor computes the shot: a quick run of targeting beeps, a lock tone.
        for (let i = 0; i < 5; i++) this.tone('square', 1800 + i * 260, 1800 + i * 260, 0.035, 0.035, i * 0.045);
        this.tone('sine', 2600, 2600, 0.07, 0.16, 0.25);
        this.tone('sine', 3900, 3900, 0.04, 0.14, 0.27);
        break;
      case 'opticSuper':
        // Full-power beam: the zap with a roar of fire behind it.
        this.tone('sawtooth', 2600, 180, 0.2 * k, 0.32);
        this.tone('square', 1200, 90, 0.1 * k, 0.28);
        this.tone('sine', 120, 35, 0.8 * k, 0.5);
        this.hiss('highpass', 3000, 0.5, 0.3 * k, 0.2, 9000);
        this.hiss('lowpass', 1800, 0.6, 0.35 * k, 0.6, 300);
        break;
      case 'ignite':
        // Fire catches: a breathy whoomp and crackle.
        this.hiss('lowpass', 900, 0.6, 0.55 * k, 0.45, 2600);
        this.tone('sine', 90, 50, 0.4 * k, 0.3);
        this.hiss('bandpass', 3800, 3, 0.14 * k, 0.3, 1800);
        break;
      case 'burn':
        // Crackling flames.
        this.hiss('bandpass', 2600 + Math.random() * 2000, 4, 0.1 * k, 0.05);
        this.hiss('bandpass', 1200 + Math.random() * 900, 3, 0.07 * k, 0.07);
        break;
      case 'pointBlank':
        // A beam fired into a face: a fat zap and a deep blast.
        this.tone('sawtooth', 1500, 120, 0.2 * k, 0.24);
        this.tone('sine', 75, 28, 0.95 * k, 0.5);
        this.hiss('lowpass', 4200, 0.5, 0.55 * k, 0.35, 220);
        this.hiss('highpass', 5000, 0.6, 0.2 * k, 0.1);
        break;
      case 'geneSplice':
        // Rising uppercut wrapped in energy: an upward whoosh and shimmer.
        this.hiss('bandpass', 500, 1, 0.22 * k, 0.32, 3600);
        this.tone('sawtooth', 220, 1300, 0.08 * k, 0.28);
        this.tone('sine', 880, 2600, 0.06 * k, 0.3, 0.05);
        break;
      case 'megaStart':
        // The held beam comes on: a deep crack and a roar that keeps going.
        this.tone('sawtooth', 1800, 140, 0.2 * k, 0.35);
        this.tone('sine', 70, 30, 0.9 * k, 0.6);
        this.hiss('lowpass', 2600, 0.6, 0.5 * k, 0.5, 400);
        this.hiss('highpass', 4000, 0.5, 0.2 * k, 0.15, 9000);
        break;
      case 'beamHum':
        // Sustained beam: a buzzing, crackling hum (retriggered every few ticks).
        this.tone('sawtooth', 110 + Math.random() * 6, 104, 0.07 * k, 0.12);
        this.tone('square', 220 + Math.random() * 10, 210, 0.025 * k, 0.1);
        this.hiss('bandpass', 1400 + Math.random() * 600, 1.2, 0.08 * k, 0.11);
        break;
      case 'megaEnd':
        // It sputters out.
        this.tone('sawtooth', 300, 60, 0.1 * k, 0.3);
        this.hiss('lowpass', 1600, 0.6, 0.18 * k, 0.35, 200);
        break;
      case 'meteor':
        // A dive into the floor: a crash and rubble.
        this.tone('sine', 60, 24, 1 * k, 0.55);
        this.hiss('lowpass', 3000, 0.5, 0.6 * k, 0.5, 160);
        this.hiss('bandpass', 900, 0.9, 0.3 * k, 0.4, 300);
        break;
      case 'cyclone':
        // A whirl: two fast passes of air.
        this.hiss('bandpass', 600, 1.4, 0.15 * k, 0.16, 2400);
        this.hiss('bandpass', 900, 1.4, 0.18 * k, 0.18, 3000);
        this.tone('sine', 160, 90, 0.08 * k, 0.3);
        break;
    }
  }
}
