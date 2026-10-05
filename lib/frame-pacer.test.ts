import { describe, expect, test } from 'bun:test';
import { FramePacer, type FramePacerClock } from './frame-pacer';

/** A clock the test turns by hand. */
class Clock implements FramePacerClock {
  private next = 1;
  frames = new Map<number, () => void>();
  timers = new Map<number, { callback: () => void; ms: number }>();
  requestAnimationFrame(callback: () => void): number {
    this.frames.set(this.next, callback);
    return this.next++;
  }
  cancelAnimationFrame(handle: number): void {
    this.frames.delete(handle);
  }
  setTimeout(callback: () => void, ms: number): number {
    this.timers.set(this.next, { callback, ms });
    return this.next++;
  }
  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }
  /** Run the animation frame that is waiting. */
  frame(): void {
    expect(this.frames.size).toBe(1);
    const [[handle, callback]] = [...this.frames];
    this.frames.delete(handle);
    callback();
  }
  /** Let the timer that is waiting go off. */
  timeout(): void {
    expect(this.timers.size).toBe(1);
    const [[handle, { callback }]] = [...this.timers];
    this.timers.delete(handle);
    callback();
  }
  get waiting(): string {
    return `${this.frames.size} frame(s), ${this.timers.size} timer(s)`;
  }
}

function pacer(draws: () => boolean) {
  const clock = new Clock();
  let frames = 0;
  const p = new FramePacer(
    () => {
      frames++;
      return draws();
    },
    { idleAfter: 3, pollMs: 100 },
    clock
  );
  return { clock, p, count: () => frames };
}

describe('FramePacer', () => {
  test('stays on the display clock while frames draw', () => {
    const { clock, p, count } = pacer(() => true);
    p.start();
    for (let i = 0; i < 10; i++) clock.frame();
    expect(count()).toBe(11);
    expect(p.resting).toBe(false);
    expect(clock.waiting).toBe('1 frame(s), 0 timer(s)');
  });

  test('rests after enough frames that drew nothing, and looks again slowly', () => {
    const { clock, p, count } = pacer(() => false);
    p.start(); // 1
    clock.frame(); // 2
    expect(p.resting).toBe(false);
    clock.frame(); // 3: the third in a row
    expect(p.resting).toBe(true);
    expect(clock.waiting).toBe('0 frame(s), 1 timer(s)');
    expect([...clock.timers.values()][0].ms).toBe(100);

    // Still nothing: it keeps to the slow look.
    clock.timeout();
    clock.timeout();
    expect(count()).toBe(5);
    expect(clock.waiting).toBe('0 frame(s), 1 timer(s)');
  });

  test('a frame that draws puts it back on the display clock', () => {
    let draw = false;
    const { clock, p } = pacer(() => draw);
    p.start();
    clock.frame();
    clock.frame();
    expect(p.resting).toBe(true);

    // The slow look finds something (nobody woke it): back to frames.
    draw = true;
    clock.timeout();
    expect(p.resting).toBe(false);
    expect(clock.waiting).toBe('1 frame(s), 0 timer(s)');

    // And the count of idle frames starts over.
    draw = false;
    clock.frame();
    clock.frame();
    expect(p.resting).toBe(false);
    clock.frame();
    expect(p.resting).toBe(true);
  });

  test('wake draws on the next animation frame, without waiting for the slow look', () => {
    const { clock, p, count } = pacer(() => false);
    p.start();
    clock.frame();
    clock.frame();
    expect(p.resting).toBe(true);

    p.wake();
    expect(p.resting).toBe(false);
    expect(clock.waiting).toBe('1 frame(s), 0 timer(s)');
    const before = count();
    clock.frame();
    expect(count()).toBe(before + 1);

    // Waking twice, or while already on the display clock, asks for one frame.
    p.wake();
    p.wake();
    expect(clock.waiting).toBe('1 frame(s), 0 timer(s)');
  });

  test('wake while frames are running only starts the idle count over', () => {
    const { clock, p } = pacer(() => false);
    p.start(); // 1 idle
    clock.frame(); // 2 idle
    p.wake(); // back to 0
    clock.frame(); // 1
    clock.frame(); // 2
    expect(p.resting).toBe(false);
    clock.frame(); // 3
    expect(p.resting).toBe(true);
  });

  test('stop cancels whatever is waiting, and a frame can stop it', () => {
    const { clock, p } = pacer(() => true);
    p.start();
    p.stop();
    expect(clock.waiting).toBe('0 frame(s), 0 timer(s)');
    p.wake();
    expect(clock.waiting).toBe('0 frame(s), 0 timer(s)');

    // Resting, then stopped.
    const idle = pacer(() => false);
    idle.p.start();
    idle.clock.frame();
    idle.clock.frame();
    idle.p.stop();
    expect(idle.clock.waiting).toBe('0 frame(s), 0 timer(s)');

    // Stopped from inside the frame (the terminal was disposed mid-frame).
    const clock2 = new Clock();
    const self: { p?: FramePacer } = {};
    self.p = new FramePacer(
      () => {
        self.p?.stop();
        return true;
      },
      {},
      clock2
    );
    self.p.start();
    expect(clock2.waiting).toBe('0 frame(s), 0 timer(s)');
  });

  test('start twice does not run two loops', () => {
    const { clock, p } = pacer(() => true);
    p.start();
    p.start();
    expect(clock.waiting).toBe('1 frame(s), 0 timer(s)');
  });
});
