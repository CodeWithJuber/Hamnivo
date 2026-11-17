/**
 * What of an AI reply may be shown while the model is still writing it. Only whole sentences go
 * out, and only while everything written so far passes the deterministic checks that would hold
 * the reply back (claiming to be a person, saying a payment, refund or change went through):
 * once a sentence does not, nothing more goes out, and the full checks decide when the model is
 * done. A draft is never final: the published reply replaces it, and a withdrawn draft leaves
 * nothing behind. Citation markers ("[2]") are left out, since they are renumbered on
 * publication. Pure, so it is tested without a model.
 */

/** Where a sentence or a line ends: closing punctuation before a space, or a line break. */
const BOUNDARY = /[.!?…।؟۔](?=\s)|\n/g;
/** Knowledge `[2]` and memory `[M1]` markers: the published reply turns them into sources. */
const CITATION = / ?\[M?\d{1,2}\]/g;

export class SentenceGate {
  /** What the model wrote, all of it. */
  private written = '';
  /** How much of `written` has gone out. */
  private released = 0;
  private holding = false;

  /** `passes` reads everything that would have gone out so far, this sentence included. */
  constructor(private readonly passes: (text: string) => boolean) {}

  /** Whether something failed a check, so nothing more goes out. */
  get held(): boolean {
    return this.holding;
  }

  /** What has gone out so far, as shown. */
  get shown(): string {
    return clean(this.written.slice(0, this.released));
  }

  /** Adds what the model wrote; returns what may be shown now ('' when nothing). */
  push(delta: string): string {
    this.written += delta;
    if (this.holding) return '';
    let end = -1;
    for (const match of this.written.slice(this.released).matchAll(BOUNDARY)) {
      end = this.released + match.index + match[0].length;
    }
    return end < 0 ? '' : this.release(end);
  }

  /** The model is done: the rest, if it passes. */
  end(): string {
    if (this.holding || this.released >= this.written.length) return '';
    return this.release(this.written.length);
  }

  private release(end: number): string {
    const next = this.written.slice(0, end);
    if (!this.passes(clean(next))) {
      this.holding = true;
      return '';
    }
    const before = clean(this.written.slice(0, this.released));
    this.released = end;
    // What is new as shown: markers are taken out of the whole, so one split across two
    // pieces is never half shown.
    return clean(next).slice(before.length);
  }
}

const clean = (text: string) => text.replace(CITATION, '');
