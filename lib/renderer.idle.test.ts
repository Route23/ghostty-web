/**
 * dopamine (#914): a frame with nothing new draws nothing.
 *
 * Any draw call dirties the canvas, and a dirty canvas is composited -- so a
 * renderer that repaints the cursor on every frame keeps an idle terminal
 * busy sixty times a second. These tests count the draw calls a frame makes.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { CanvasRenderer, type IRenderable, type IScrollbackProvider } from './renderer';
import type { GhosttyCell } from './types';

/** Every call made on the 2D context since it was last emptied. */
let calls: string[] = [];

function fakeContext(): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {
    measureText: () => ({ width: 8, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
  };
  return new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return () => {
        calls.push(prop);
      };
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function cell(codepoint = 32): GhosttyCell {
  return {
    codepoint,
    fg_r: 200,
    fg_g: 200,
    fg_b: 200,
    bg_r: 0,
    bg_g: 0,
    bg_b: 0,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
  };
}

class FakeBuffer implements IRenderable {
  cols = 10;
  rows = 4;
  cursor = { x: 2, y: 1, visible: true };
  dirty = new Set<number>();
  getLine(_y: number): GhosttyCell[] | null {
    return Array.from({ length: this.cols }, () => cell(97));
  }
  getCursor() {
    return { ...this.cursor };
  }
  getDimensions() {
    return { cols: this.cols, rows: this.rows };
  }
  isRowDirty(y: number): boolean {
    return this.dirty.has(y);
  }
  clearDirty(): void {
    this.dirty.clear();
  }
}

const scrollback: IScrollbackProvider = {
  getScrollbackLine: () => Array.from({ length: 10 }, () => cell(98)),
  getScrollbackLength: () => 50,
};

/** A renderer that has drawn its first frame, and the buffer it draws. */
function settled(options: { cursorBlink?: boolean } = {}) {
  const canvas = document.createElement('canvas');
  const renderer = new CanvasRenderer(canvas, { devicePixelRatio: 1, ...options });
  const buffer = new FakeBuffer();
  renderer.render(buffer, true, 0, scrollback, 0);
  renderer.render(buffer, false, 0, scrollback, 0);
  calls = [];
  return { renderer, buffer };
}

/** Flip the blink phase the way the 530 ms timer does. */
function blink(renderer: CanvasRenderer) {
  const r = renderer as unknown as { cursorVisible: boolean };
  r.cursorVisible = !r.cursorVisible;
}

describe('CanvasRenderer on a frame with nothing new', () => {
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: unknown };
  const original = proto.getContext;
  beforeEach(() => {
    // Happy DOM has no 2D context. Every canvas hands out one that records.
    proto.getContext = () => fakeContext();
    calls = [];
  });
  afterAll(() => {
    proto.getContext = original;
  });

  test('draws nothing at the prompt', () => {
    const { renderer, buffer } = settled();
    for (let i = 0; i < 5; i++) renderer.render(buffer, false, 0, scrollback, 0);
    expect(calls).toEqual([]);
  });

  test('draws nothing between two blinks, and the cursor line at each', () => {
    const { renderer, buffer } = settled({ cursorBlink: true });
    for (let i = 0; i < 5; i++) renderer.render(buffer, false, 0, scrollback, 0);
    expect(calls).toEqual([]);

    // Off: the line is redrawn to take the cursor away, and no cursor on top.
    blink(renderer);
    renderer.render(buffer, false, 0, scrollback, 0);
    const off = calls.length;
    expect(off).toBeGreaterThan(0);
    calls = [];
    renderer.render(buffer, false, 0, scrollback, 0);
    expect(calls).toEqual([]);

    // On again: the line, and one more call for the cursor.
    blink(renderer);
    renderer.render(buffer, false, 0, scrollback, 0);
    expect(calls.length).toBe(off + 1);
    calls = [];
    renderer.render(buffer, false, 0, scrollback, 0);
    expect(calls).toEqual([]);
    renderer.dispose?.();
  });

  test('draws the cursor again when it moves, changes shape, or its row is redrawn', () => {
    const { renderer, buffer } = settled();

    buffer.cursor.x = 5;
    renderer.render(buffer, false, 0, scrollback, 0);
    expect(calls.length).toBeGreaterThan(0);
    calls = [];
    renderer.render(buffer, false, 0, scrollback, 0);
    expect(calls).toEqual([]);

    renderer.setCursorStyle('bar');
    renderer.render(buffer, false, 0, scrollback, 0);
    expect(calls.length).toBeGreaterThan(0);
    calls = [];

    // The row above is dirty: its neighbours are redrawn with it (glyph
    // overflow), the cursor's row among them -- so the cursor goes back on.
    buffer.dirty.add(0);
    renderer.render(buffer, false, 0, scrollback, 0);
    const withCursor = calls.length;
    calls = [];
    // A dirty row far from the cursor does not bring the cursor with it.
    buffer.dirty.add(3);
    renderer.render(buffer, false, 0, scrollback, 0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThan(withCursor);
    calls = [];

    // Hidden by the program: the row is redrawn once, without it.
    buffer.cursor.visible = false;
    renderer.render(buffer, false, 0, scrollback, 0);
    expect(calls.length).toBeGreaterThan(0);
    calls = [];
    renderer.render(buffer, false, 0, scrollback, 0);
    expect(calls).toEqual([]);
  });

  test('draws nothing while the scrollback is in view and nothing arrives', () => {
    const { renderer, buffer } = settled();
    renderer.render(buffer, false, 3, scrollback, 0);
    expect(calls.length).toBeGreaterThan(0);
    calls = [];
    for (let i = 0; i < 5; i++) renderer.render(buffer, false, 3, scrollback, 0);
    expect(calls).toEqual([]);

    // New output: every row on screen is redrawn.
    buffer.dirty.add(2);
    renderer.render(buffer, false, 3, scrollback, 0);
    expect(calls.length).toBeGreaterThan(0);
    calls = [];
    renderer.render(buffer, false, 3, scrollback, 0);
    expect(calls).toEqual([]);

    // The scrollback grew.
    const longer: IScrollbackProvider = { ...scrollback, getScrollbackLength: () => 51 };
    renderer.render(buffer, false, 3, longer, 0);
    expect(calls.length).toBeGreaterThan(0);
  });

  test('keeps redrawing under the scrollbar while it shows, and once after it has gone', () => {
    const { renderer, buffer } = settled();
    renderer.render(buffer, false, 3, scrollback, 1);
    calls = [];
    // Showing: the rows and the bar, every frame, as before.
    renderer.render(buffer, false, 3, scrollback, 1);
    const showing = calls.length;
    expect(showing).toBeGreaterThan(0);
    calls = [];
    renderer.render(buffer, false, 3, scrollback, 0.5);
    expect(calls.length).toBe(showing);
    calls = [];

    // Gone: one full redraw puts back what the bar covered...
    renderer.render(buffer, false, 3, scrollback, 0);
    expect(calls.length).toBeGreaterThan(0);
    calls = [];
    // ...and then nothing.
    renderer.render(buffer, false, 3, scrollback, 0);
    expect(calls).toEqual([]);
  });
});
