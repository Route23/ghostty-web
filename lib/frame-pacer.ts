/**
 * dopamine (#914): the render loop, resting when there is nothing to draw.
 *
 * The loop used to ask for an animation frame on every frame, forever. Even
 * when a frame draws nothing, that keeps the display link ticking, the page's
 * process waking sixty times a second to ask the terminal whether anything
 * changed, and the app that hosts the view relaying every tick -- a few
 * percent of a core per idle terminal.
 *
 * After `idleAfter` frames in a row that drew nothing, the pacer stops asking
 * for animation frames and looks again every `pollMs` instead. (A few frames,
 * not many: a blinking cursor wakes it twice a second, and a pacer that takes
 * half a second to settle would never rest.) `wake()` puts
 * it back on the display's clock at once; everything that is known to change
 * what is on screen calls it (output, the cursor blinking, scrolling, a
 * selection, a hovered link, an option). The slow look is the net under that
 * list: something that forgets to wake the pacer shows up a tenth of a second
 * late, not never.
 */

export interface FramePacerClock {
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(handle: number): void;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  /** Whether the page is hidden (animation frames do not come while it is). */
  hidden(): boolean;
}

export interface FramePacerOptions {
  /** Frames in a row that drew nothing before the pacer rests. */
  idleAfter?: number;
  /** How often it looks again while resting, in milliseconds. */
  pollMs?: number;
}

export class FramePacer {
  private readonly idleAfter: number;
  private readonly pollMs: number;
  private idleFrames = 0;
  private animationFrame?: number;
  private timer?: number;
  private running = false;

  /**
   * @param frame Draws one frame and says whether anything was drawn.
   */
  constructor(
    private readonly frame: () => boolean,
    options: FramePacerOptions = {},
    private readonly clock: FramePacerClock = {
      requestAnimationFrame: (callback) => requestAnimationFrame(callback),
      cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
      setTimeout: (callback, ms) => window.setTimeout(callback, ms),
      clearTimeout: (handle) => window.clearTimeout(handle),
      hidden: () => typeof document !== 'undefined' && document.hidden === true,
    }
  ) {
    this.idleAfter = options.idleAfter ?? 3;
    this.pollMs = options.pollMs ?? 100;
  }

  /** Whether the pacer has stopped asking for animation frames. */
  get resting(): boolean {
    return this.timer !== undefined;
  }

  /** Draw a frame now and keep going. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.idleFrames = 0;
    this.tick();
  }

  /** Stop for good (until `start`). */
  stop(): void {
    this.running = false;
    if (this.animationFrame !== undefined) {
      this.clock.cancelAnimationFrame(this.animationFrame);
      this.animationFrame = undefined;
    }
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Something on screen may have changed: draw on the next animation frame. */
  wake(): void {
    this.idleFrames = 0;
    if (!this.running || this.timer === undefined) return;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.animationFrame = this.clock.requestAnimationFrame(this.tick);
  }

  private tick = (): void => {
    this.animationFrame = undefined;
    this.timer = undefined;
    if (!this.running) return;

    const drew = this.frame();
    // The frame may have stopped the pacer (the terminal was disposed).
    if (!this.running) return;

    this.idleFrames = drew ? 0 : this.idleFrames + 1;
    // A hidden page gets no animation frames, which is exactly the rest that
    // is wanted there: nobody can see it. The slow look would keep going --
    // the loop this replaced did nothing at all while hidden.
    if (this.idleFrames >= this.idleAfter && !this.clock.hidden()) {
      this.timer = this.clock.setTimeout(this.tick, this.pollMs);
    } else {
      this.animationFrame = this.clock.requestAnimationFrame(this.tick);
    }
  };
}
