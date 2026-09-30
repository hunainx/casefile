/**
 * Seeded pseudo-random numbers for the fake corpus (sfc32, seeded through splitmix32).
 * The same seed gives the same sequence on every machine, so the same seed gives the same files.
 * Never Math.random, never the clock.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    let s = seed >>> 0;
    const next = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i++) this.u32();
  }

  /** A uniform unsigned 32-bit integer. */
  u32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** A uniform float in [0, 1). */
  next(): number {
    return this.u32() / 4294967296;
  }

  /** A uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from an empty list");
    return items[Math.floor(this.next() * items.length)]!;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** A child generator: independent sequence, still fully determined by this one. */
  fork(): Rng {
    return new Rng(this.u32());
  }

  /** Fills a buffer with pseudo-random bytes. */
  fill(buf: Buffer): Buffer {
    for (let i = 0; i + 4 <= buf.length; i += 4) buf.writeUInt32LE(this.u32(), i);
    for (let i = buf.length - (buf.length % 4); i < buf.length; i++) buf[i] = this.u32() & 0xff;
    return buf;
  }
}
