/**
 * Canvas Renderer for Terminal Display
 *
 * High-performance canvas-based renderer that draws the terminal using
 * Ghostty's WASM terminal emulator. Features:
 * - Font metrics measurement with DPI scaling
 * - Full color support (256-color palette + RGB)
 * - All text styles (bold, italic, underline, strikethrough, etc.)
 * - Multiple cursor styles (block, underline, bar)
 * - Dirty line optimization for 60 FPS
 */

import type { ITheme } from './interfaces';
import type { SelectionManager } from './selection-manager';
import type { GhosttyCell, ILink } from './types';
import { CellFlags } from './types';

// Interface for objects that can be rendered
export interface IRenderable {
  getLine(y: number): GhosttyCell[] | null;
  getCursor(): { x: number; y: number; visible: boolean };
  getDimensions(): { cols: number; rows: number };
  isRowDirty(y: number): boolean;
  /** Returns true if a full redraw is needed (e.g., screen change) */
  needsFullRedraw?(): boolean;
  clearDirty(): void;
  /**
   * Get the full grapheme string for a cell at (row, col).
   * For cells with grapheme_len > 0, this returns all codepoints combined.
   * For simple cells, returns the single character.
   */
  getGraphemeString?(row: number, col: number): string;
}

export interface IScrollbackProvider {
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  getScrollbackLength(): number;
}

// ============================================================================
// Type Definitions
// ============================================================================

export interface RendererOptions {
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  cursorStyle?: 'block' | 'underline' | 'bar'; // Default: 'block'
  cursorBlink?: boolean; // Default: false
  theme?: ITheme;
  devicePixelRatio?: number; // Default: window.devicePixelRatio
}

/**
 * How glyphs are drawn (dopamine #414). All off by default — the renderer then
 * behaves exactly as upstream.
 */
export interface RenderOptions {
  /** CSS font-weight for normal / bold cells (default 'normal' / 'bold'). */
  fontWeight?: string;
  fontWeightBold?: string;
  /** WCAG contrast ratio the text keeps against its background (1 = off). */
  minimumContrastRatio?: number;
  /** Draw box-drawing and block characters as paths instead of font glyphs. */
  customGlyphs?: boolean;
  /** Draw runs of same-styled cells with one fillText so the font can form ligatures. */
  ligatures?: boolean;
  /** Bold text in one of the 8 normal ANSI colours is drawn in its bright twin. */
  drawBoldTextInBrightColors?: boolean;
}

export interface FontMetrics {
  width: number; // Character cell width in CSS pixels
  height: number; // Character cell height in CSS pixels
  baseline: number; // Distance from top to text baseline
}

// ============================================================================
// Default Theme
// ============================================================================

export const DEFAULT_THEME: Required<ITheme> = {
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  // Selection colors: solid colors that replace cell bg/fg when selected
  // Using Ghostty's approach: selection bg = default fg, selection fg = default bg
  selectionBackground: '#d4d4d4',
  selectionForeground: '#1e1e1e',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

// ============================================================================
// CanvasRenderer Class
// ============================================================================

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private fontSize: number;
  private fontFamily: string;
  private cursorStyle: 'block' | 'underline' | 'bar';
  private cursorBlink: boolean;
  private renderOpts: Required<RenderOptions> = {
    fontWeight: 'normal',
    fontWeightBold: 'bold',
    minimumContrastRatio: 1,
    customGlyphs: false,
    ligatures: false,
    drawBoldTextInBrightColors: false,
  };
  /** The font's real advance for one cell (unrounded), for ligature runs. */
  private advance = 0;
  private theme: Required<ITheme>;
  private devicePixelRatio: number;
  private metrics: FontMetrics;
  private palette: string[];

  // Cursor blinking state
  private cursorVisible: boolean = true;
  private cursorBlinkInterval?: number;
  private lastCursorPosition: { x: number; y: number } = { x: 0, y: 0 };

  // Viewport tracking (for scrolling)
  private lastViewportY: number = 0;

  // Current buffer being rendered (for grapheme lookups)
  private currentBuffer: IRenderable | null = null;

  // Selection manager (for rendering selection)
  private selectionManager?: SelectionManager;
  // Cached selection coordinates for current render pass (viewport-relative)
  private currentSelectionCoords: {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null = null;

  // Link rendering state
  private hoveredHyperlinkId: number = 0;
  private previousHoveredHyperlinkId: number = 0;

  // Regex link hover tracking (for links without hyperlink_id)
  private hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null =
    null;
  private previousHoveredLinkRange: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null = null;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = ctx;

    // Apply options
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.cursorBlink = options.cursorBlink ?? false;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.devicePixelRatio = options.devicePixelRatio ?? window.devicePixelRatio ?? 1;

    // Build color palette (16 ANSI colors)
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];

    // Measure font metrics
    this.metrics = this.measureFont();

    // Setup cursor blinking if enabled
    if (this.cursorBlink) {
      this.startCursorBlink();
    }
  }

  // ==========================================================================
  // Font Metrics Measurement
  // ==========================================================================

  private measureFont(): FontMetrics {
    // Use an offscreen canvas for measurement
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    // Set font (use actual pixel size for accurate measurement)
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;

    // Measure width using 'M' (typically widest character)
    const widthMetrics = ctx.measureText('M');
    const width = Math.ceil(widthMetrics.width);
    this.advance = widthMetrics.width;

    // Measure height using ascent + descent with padding for glyph overflow
    const ascent = widthMetrics.actualBoundingBoxAscent || this.fontSize * 0.8;
    const descent = widthMetrics.actualBoundingBoxDescent || this.fontSize * 0.2;

    // Add 2px padding to height to account for glyphs that overflow (like 'f', 'd', 'g', 'p')
    // and anti-aliasing pixels
    const height = Math.ceil(ascent + descent) + 2;
    const baseline = Math.ceil(ascent) + 1; // Offset baseline by half the padding

    return { width, height, baseline };
  }

  /**
   * Remeasure font metrics (call after font loads or changes)
   */
  public remeasureFont(): void {
    this.metrics = this.measureFont();
  }

  // ==========================================================================
  // Color Conversion
  // ==========================================================================

  private rgbToCSS(r: number, g: number, b: number): string {
    return `rgb(${r}, ${g}, ${b})`;
  }

  // ==========================================================================
  // Canvas Sizing
  // ==========================================================================

  /**
   * Resize canvas to fit terminal dimensions
   */
  public resize(cols: number, rows: number): void {
    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;

    // Set CSS size (what user sees)
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    // Set actual canvas size (scaled for DPI)
    this.canvas.width = cssWidth * this.devicePixelRatio;
    this.canvas.height = cssHeight * this.devicePixelRatio;

    // Scale context to match DPI (setting canvas.width/height resets the context)
    this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);

    // Set text rendering properties for crisp text
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';

    // Fill background after resize
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, cssWidth, cssHeight);
  }

  // ==========================================================================
  // Main Rendering
  // ==========================================================================

  /**
   * Render the terminal buffer to canvas
   */
  public render(
    buffer: IRenderable,
    forceAll: boolean = false,
    viewportY: number = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity: number = 1
  ): void {
    // Store buffer reference for grapheme lookups in renderCell
    this.currentBuffer = buffer;

    // getCursor() calls update() internally to ensure fresh state.
    // Multiple update() calls are safe - dirty state persists until clearDirty().
    const cursor = buffer.getCursor();
    const dims = buffer.getDimensions();
    const scrollbackLength = scrollbackProvider ? scrollbackProvider.getScrollbackLength() : 0;

    // Check if buffer needs full redraw (e.g., screen change between normal/alternate)
    if (buffer.needsFullRedraw?.()) {
      forceAll = true;
    }

    // Resize canvas if dimensions changed
    const needsResize =
      this.canvas.width !== dims.cols * this.metrics.width * this.devicePixelRatio ||
      this.canvas.height !== dims.rows * this.metrics.height * this.devicePixelRatio;

    if (needsResize) {
      this.resize(dims.cols, dims.rows);
      forceAll = true; // Force full render after resize
    }

    // Force re-render when viewport changes (scrolling)
    if (viewportY !== this.lastViewportY) {
      forceAll = true;
      this.lastViewportY = viewportY;
    }

    // Check if cursor position changed or if blinking (need to redraw cursor line)
    const cursorMoved =
      cursor.x !== this.lastCursorPosition.x || cursor.y !== this.lastCursorPosition.y;
    if (cursorMoved || this.cursorBlink) {
      // Mark cursor lines as needing redraw
      if (!forceAll && !buffer.isRowDirty(cursor.y)) {
        // Need to redraw cursor line
        const line = buffer.getLine(cursor.y);
        if (line) {
          this.renderLine(line, cursor.y, dims.cols);
        }
      }
      if (cursorMoved && this.lastCursorPosition.y !== cursor.y) {
        // Also redraw old cursor line if cursor moved to different line
        if (!forceAll && !buffer.isRowDirty(this.lastCursorPosition.y)) {
          const line = buffer.getLine(this.lastCursorPosition.y);
          if (line) {
            this.renderLine(line, this.lastCursorPosition.y, dims.cols);
          }
        }
      }
    }

    // Check if we need to redraw selection-related lines
    const hasSelection = this.selectionManager && this.selectionManager.hasSelection();
    const selectionRows = new Set<number>();

    // Cache selection coordinates for use during cell rendering
    // This is used by isInSelection() to determine if a cell needs selection colors
    this.currentSelectionCoords = hasSelection ? this.selectionManager!.getSelectionCoords() : null;

    // Mark current selection rows for redraw (includes programmatic selections)
    if (this.currentSelectionCoords) {
      const coords = this.currentSelectionCoords;
      for (let row = coords.startRow; row <= coords.endRow; row++) {
        selectionRows.add(row);
      }
    }

    // Always mark dirty selection rows for redraw (to clear old overlay)
    if (this.selectionManager) {
      const dirtyRows = this.selectionManager.getDirtySelectionRows();
      if (dirtyRows.size > 0) {
        for (const row of dirtyRows) {
          selectionRows.add(row);
        }
        // Clear the dirty rows tracking after marking for redraw
        this.selectionManager.clearDirtySelectionRows();
      }
    }

    // Track rows with hyperlinks that need redraw when hover changes
    const hyperlinkRows = new Set<number>();
    const hyperlinkChanged = this.hoveredHyperlinkId !== this.previousHoveredHyperlinkId;
    const linkRangeChanged =
      JSON.stringify(this.hoveredLinkRange) !== JSON.stringify(this.previousHoveredLinkRange);

    if (hyperlinkChanged) {
      // Find rows containing the old or new hovered hyperlink
      // Must check the correct buffer based on viewportY (scrollback vs screen)
      for (let y = 0; y < dims.rows; y++) {
        let line: GhosttyCell[] | null = null;

        // Same logic as rendering: fetch from scrollback or screen
        if (viewportY > 0) {
          if (y < viewportY && scrollbackProvider) {
            // This row is from scrollback
            // Floor viewportY for array access (handles fractional values during smooth scroll)
            const scrollbackOffset = scrollbackLength - Math.floor(viewportY) + y;
            line = scrollbackProvider.getScrollbackLine(scrollbackOffset);
          } else {
            // This row is from visible screen
            const screenRow = y - Math.floor(viewportY);
            line = buffer.getLine(screenRow);
          }
        } else {
          // At bottom - fetch from visible screen
          line = buffer.getLine(y);
        }

        if (line) {
          for (const cell of line) {
            if (
              cell.hyperlink_id === this.hoveredHyperlinkId ||
              cell.hyperlink_id === this.previousHoveredHyperlinkId
            ) {
              hyperlinkRows.add(y);
              break; // Found hyperlink in this row
            }
          }
        }
      }
      // Update previous state
      this.previousHoveredHyperlinkId = this.hoveredHyperlinkId;
    }

    // Track rows affected by link range changes (for regex URLs)
    if (linkRangeChanged) {
      // Add rows from old range
      if (this.previousHoveredLinkRange) {
        for (
          let y = this.previousHoveredLinkRange.startY;
          y <= this.previousHoveredLinkRange.endY;
          y++
        ) {
          hyperlinkRows.add(y);
        }
      }
      // Add rows from new range
      if (this.hoveredLinkRange) {
        for (let y = this.hoveredLinkRange.startY; y <= this.hoveredLinkRange.endY; y++) {
          hyperlinkRows.add(y);
        }
      }
      this.previousHoveredLinkRange = this.hoveredLinkRange;
    }

    // Track if anything was actually rendered
    let anyLinesRendered = false;

    // Determine which rows need rendering.
    // We also include adjacent rows (above and below) for each dirty row to handle
    // glyph overflow - tall glyphs like Devanagari vowel signs can extend into
    // adjacent rows' visual space.
    const rowsToRender = new Set<number>();
    for (let y = 0; y < dims.rows; y++) {
      // When scrolled, always force render all lines since we're showing scrollback
      const needsRender =
        viewportY > 0
          ? true
          : forceAll || buffer.isRowDirty(y) || selectionRows.has(y) || hyperlinkRows.has(y);

      if (needsRender) {
        rowsToRender.add(y);
        // Include adjacent rows to handle glyph overflow
        if (y > 0) rowsToRender.add(y - 1);
        if (y < dims.rows - 1) rowsToRender.add(y + 1);
      }
    }

    // Render each line
    for (let y = 0; y < dims.rows; y++) {
      if (!rowsToRender.has(y)) {
        continue;
      }

      anyLinesRendered = true;

      // Fetch line from scrollback or visible screen
      let line: GhosttyCell[] | null = null;
      if (viewportY > 0) {
        // Scrolled up - need to fetch from scrollback + visible screen
        // When scrolled up N lines, we want to show:
        // - Scrollback lines (from the end) + visible screen lines

        // Check if this row should come from scrollback or visible screen
        if (y < viewportY && scrollbackProvider) {
          // This row is from scrollback (upper part of viewport)
          // Get from end of scrollback buffer
          // Floor viewportY for array access (handles fractional values during smooth scroll)
          const scrollbackOffset = scrollbackLength - Math.floor(viewportY) + y;
          line = scrollbackProvider.getScrollbackLine(scrollbackOffset);
        } else {
          // This row is from visible screen (lower part of viewport)
          const screenRow = viewportY > 0 ? y - Math.floor(viewportY) : y;
          line = buffer.getLine(screenRow);
        }
      } else {
        // At bottom - fetch from visible screen
        line = buffer.getLine(y);
      }

      if (line) {
        this.renderLine(line, y, dims.cols);
      }
    }

    // Selection highlighting is now integrated into renderCellBackground/renderCellText
    // No separate overlay pass needed - this fixes z-order issues with complex glyphs

    // Link underlines are drawn during cell rendering (see renderCell)

    // Render cursor (only if we're at the bottom, not scrolled)
    if (viewportY === 0 && cursor.visible && this.cursorVisible) {
      this.renderCursor(cursor.x, cursor.y);
    }

    // Render scrollbar if scrolled or scrollback exists (with opacity for fade effect)
    if (scrollbackProvider && scrollbarOpacity > 0) {
      this.renderScrollbar(viewportY, scrollbackLength, dims.rows, scrollbarOpacity);
    }

    // Update last cursor position
    this.lastCursorPosition = { x: cursor.x, y: cursor.y };

    // ALWAYS clear dirty flags after rendering, regardless of forceAll.
    // This is critical - if we don't clear after a full redraw, the dirty
    // state persists and the next frame might not detect new changes properly.
    buffer.clearDirty();
  }

  /**
   * Render a single line using two-pass approach:
   * 1. First pass: Draw all cell backgrounds
   * 2. Second pass: Draw all cell text and decorations
   *
   * This two-pass approach is necessary for proper rendering of complex scripts
   * like Devanagari where diacritics (like vowel sign ि) can extend LEFT of the
   * base character into the previous cell's visual area. If we draw backgrounds
   * and text in a single pass (cell by cell), the background of cell N would
   * cover any left-extending portions of graphemes from cell N-1.
   */
  private renderLine(line: GhosttyCell[], y: number, cols: number): void {
    const lineY = y * this.metrics.height;

    // Clear line background with theme color.
    // We clear just the cell area - glyph overflow is handled by also
    // redrawing adjacent rows (see render() method).
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, lineY, cols * this.metrics.width, this.metrics.height);

    // PASS 1: Draw all cell backgrounds first
    // This ensures all backgrounds are painted before any text, allowing text
    // to "bleed" across cell boundaries without being covered by adjacent backgrounds
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellBackground(cell, x, y);
    }

    // PASS 2: Draw all cell text and decorations
    // Now text can safely extend beyond cell boundaries (for complex scripts)
    if (this.renderOpts.ligatures) {
      this.renderLineRuns(line, y);
      return;
    }
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellText(cell, x, y);
    }
  }

  /**
   * Ligatures (dopamine #414): a run of narrow, plain, same-styled cells is drawn
   * with one fillText so the font can join `->`, `!=`, `===`… Anything special
   * (wide, grapheme, selected, decorated, box drawing, hyperlinks) falls back to
   * the per-cell path. Letter spacing pins each glyph to its cell.
   */
  private renderLineRuns(line: GhosttyCell[], y: number): void {
    const plain = (c: GhosttyCell, x: number) =>
      c.width === 1 &&
      c.grapheme_len === 0 &&
      c.hyperlink_id === 0 &&
      (c.flags & (CellFlags.UNDERLINE | CellFlags.STRIKETHROUGH | CellFlags.INVISIBLE)) === 0 &&
      !this.isInSelection(x, y) &&
      !(this.renderOpts.customGlyphs && isCustomGlyph(c.codepoint));
    const same = (a: GhosttyCell, b: GhosttyCell) =>
      a.fg_r === b.fg_r && a.fg_g === b.fg_g && a.fg_b === b.fg_b && a.bg_r === b.bg_r &&
      a.bg_g === b.bg_g && a.bg_b === b.bg_b && a.flags === b.flags;
    let x = 0;
    while (x < line.length) {
      const cell = line[x];
      if (cell.width === 0) {
        x++;
        continue;
      }
      if (!plain(cell, x)) {
        this.renderCellText(cell, x, y);
        x++;
        continue;
      }
      let end = x + 1;
      while (end < line.length && plain(line[end], end) && same(cell, line[end])) end++;
      if (end - x === 1) {
        this.renderCellText(cell, x, y);
      } else {
        let text = '';
        for (let i = x; i < end; i++) text += String.fromCodePoint(line[i].codepoint || 32);
        this.setTextStyle(cell);
        // Pin the run to the cell grid by stretching it horizontally, not with
        // letter-spacing: any non-zero letter-spacing turns ligatures off.
        const ctx = this.ctx;
        const scale = this.advance > 0 ? this.metrics.width / this.advance : 1;
        ctx.save();
        ctx.translate(x * this.metrics.width, y * this.metrics.height + this.metrics.baseline);
        ctx.scale(scale, 1);
        if (cell.flags & CellFlags.FAINT) ctx.globalAlpha = 0.5;
        ctx.fillText(text, 0, 0);
        ctx.restore();
      }
      x = end;
    }
  }

  /** The font and colour for a cell's text (weight, inverse, bright bold, contrast). */
  private setTextStyle(cell: GhosttyCell): void {
    const bold = (cell.flags & CellFlags.BOLD) !== 0;
    const italic = (cell.flags & CellFlags.ITALIC) !== 0 ? 'italic ' : '';
    const weight = bold ? this.renderOpts.fontWeightBold : this.renderOpts.fontWeight;
    this.ctx.font = `${italic}${weight} ${this.fontSize}px ${this.fontFamily}`;
    let fg: [number, number, number] = [cell.fg_r, cell.fg_g, cell.fg_b];
    let bg: [number, number, number] = [cell.bg_r, cell.bg_g, cell.bg_b];
    if (cell.flags & CellFlags.INVERSE) [fg, bg] = [bg, fg];
    if (bold && this.renderOpts.drawBoldTextInBrightColors) fg = this.brightTwin(fg);
    if (this.renderOpts.minimumContrastRatio > 1) {
      const isDefaultBg = bg[0] === 0 && bg[1] === 0 && bg[2] === 0;
      const back = isDefaultBg ? hexToRgb(this.theme.background) : bg;
      fg = ensureContrast(fg, back, this.renderOpts.minimumContrastRatio);
    }
    this.ctx.fillStyle = this.rgbToCSS(fg[0], fg[1], fg[2]);
  }

  /**
   * Bold in a normal ANSI colour → its bright twin. The cell only carries RGB, so
   * this matches the RGB against the theme's 8 normal colours (a true-colour that
   * happens to equal one is brightened too).
   */
  private brightTwin(fg: [number, number, number]): [number, number, number] {
    for (let i = 0; i < 8; i++) {
      const c = hexToRgb(this.palette[i]);
      if (c[0] === fg[0] && c[1] === fg[1] && c[2] === fg[2]) return hexToRgb(this.palette[i + 8]);
    }
    return fg;
  }

  /**
   * Render a cell's background only (Pass 1 of two-pass rendering)
   * Selection highlighting is integrated here to avoid z-order issues with
   * complex glyphs (like Devanagari) that extend outside their cell bounds.
   */
  private renderCellBackground(cell: GhosttyCell, x: number, y: number): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    if (isSelected) {
      // Draw selection background (solid color, not overlay)
      this.ctx.fillStyle = this.theme.selectionBackground;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return; // Selection background replaces cell background
    }

    // Extract background color and handle inverse
    let bg_r = cell.bg_r,
      bg_g = cell.bg_g,
      bg_b = cell.bg_b;

    if (cell.flags & CellFlags.INVERSE) {
      // When inverted, background becomes foreground
      bg_r = cell.fg_r;
      bg_g = cell.fg_g;
      bg_b = cell.fg_b;
    }

    // Only draw cell background if it's different from the default (black)
    // This lets the theme background (drawn earlier) show through for default cells
    const isDefaultBg = bg_r === 0 && bg_g === 0 && bg_b === 0;
    if (!isDefaultBg) {
      this.ctx.fillStyle = this.rgbToCSS(bg_r, bg_g, bg_b);
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
    }
  }

  /**
   * Render a cell's text and decorations (Pass 2 of two-pass rendering)
   * Selection foreground color is applied here to match the selection background.
   */
  private renderCellText(cell: GhosttyCell, x: number, y: number): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Skip rendering if invisible
    if (cell.flags & CellFlags.INVISIBLE) {
      return;
    }

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    // Set text style (weight, inverse, bright bold, minimum contrast — dopamine #414)
    this.setTextStyle(cell);
    // Use selection foreground if selected
    if (isSelected) {
      this.ctx.fillStyle = this.theme.selectionForeground;
    }

    // Apply faint effect
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 0.5;
    }

    // Draw text
    const textX = cellX;
    const textY = cellY + this.metrics.baseline;

    // Get the character to render - use grapheme lookup for complex scripts
    let char: string;
    if (cell.grapheme_len > 0 && this.currentBuffer?.getGraphemeString) {
      // Cell has additional codepoints - get full grapheme cluster
      char = this.currentBuffer.getGraphemeString(y, x);
    } else {
      // Simple cell - single codepoint
      char = String.fromCodePoint(cell.codepoint || 32); // Default to space if null
    }
    // Box drawing / blocks as paths (dopamine #414): fonts rarely fill the cell, so
    // lines break between rows.
    if (this.renderOpts.customGlyphs && isCustomGlyph(cell.codepoint)) {
      drawCustomGlyph(this.ctx, cell.codepoint, cellX, cellY, cellWidth, this.metrics.height);
    } else {
      this.ctx.fillText(char, textX, textY);
    }

    // Reset alpha
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 1.0;
    }

    // Draw underline
    if (cell.flags & CellFlags.UNDERLINE) {
      const underlineY = cellY + this.metrics.baseline + 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, underlineY);
      this.ctx.lineTo(cellX + cellWidth, underlineY);
      this.ctx.stroke();
    }

    // Draw strikethrough
    if (cell.flags & CellFlags.STRIKETHROUGH) {
      const strikeY = cellY + this.metrics.height / 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, strikeY);
      this.ctx.lineTo(cellX + cellWidth, strikeY);
      this.ctx.stroke();
    }

    // Draw hyperlink underline (for OSC8 hyperlinks)
    if (cell.hyperlink_id > 0) {
      const isHovered = cell.hyperlink_id === this.hoveredHyperlinkId;

      // Only show underline when hovered (cleaner look)
      if (isHovered) {
        const underlineY = cellY + this.metrics.baseline + 2;
        this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(cellX, underlineY);
        this.ctx.lineTo(cellX + cellWidth, underlineY);
        this.ctx.stroke();
      }
    }

    // Draw regex link underline (for plain text URLs)
    if (this.hoveredLinkRange) {
      const range = this.hoveredLinkRange;
      // Check if this cell is within the hovered link range
      const isInRange =
        (y === range.startY && x >= range.startX && (y < range.endY || x <= range.endX)) ||
        (y > range.startY && y < range.endY) ||
        (y === range.endY && x <= range.endX && (y > range.startY || x >= range.startX));

      if (isInRange) {
        const underlineY = cellY + this.metrics.baseline + 2;
        this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(cellX, underlineY);
        this.ctx.lineTo(cellX + cellWidth, underlineY);
        this.ctx.stroke();
      }
    }
  }

  /**
   * Render cursor
   */
  private renderCursor(x: number, y: number): void {
    const cursorX = x * this.metrics.width;
    const cursorY = y * this.metrics.height;

    this.ctx.fillStyle = this.theme.cursor;

    switch (this.cursorStyle) {
      case 'block':
        // Full cell block
        this.ctx.fillRect(cursorX, cursorY, this.metrics.width, this.metrics.height);
        break;

      case 'underline':
        // Underline at bottom of cell
        const underlineHeight = Math.max(2, Math.floor(this.metrics.height * 0.15));
        this.ctx.fillRect(
          cursorX,
          cursorY + this.metrics.height - underlineHeight,
          this.metrics.width,
          underlineHeight
        );
        break;

      case 'bar':
        // Vertical bar at left of cell
        const barWidth = Math.max(2, Math.floor(this.metrics.width * 0.15));
        this.ctx.fillRect(cursorX, cursorY, barWidth, this.metrics.height);
        break;
    }
  }

  // ==========================================================================
  // Cursor Blinking
  // ==========================================================================

  private startCursorBlink(): void {
    // xterm.js uses ~530ms blink interval
    this.cursorBlinkInterval = window.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      // Note: Render loop should redraw cursor line automatically
    }, 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      clearInterval(this.cursorBlinkInterval);
      this.cursorBlinkInterval = undefined;
    }
    this.cursorVisible = true;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Update theme colors
   */
  public setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };

    // Rebuild palette
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];
  }

  /**
   * Change how glyphs are drawn (dopamine #414). Unknown keys are ignored.
   */
  public setRenderOptions(opts: RenderOptions): void {
    this.renderOpts = { ...this.renderOpts, ...opts };
    this.metrics = this.measureFont();
  }

  /**
   * Update font size
   */
  public setFontSize(size: number): void {
    this.fontSize = size;
    this.metrics = this.measureFont();
  }

  /**
   * Update font family
   */
  public setFontFamily(family: string): void {
    this.fontFamily = family;
    this.metrics = this.measureFont();
  }

  /**
   * Update cursor style
   */
  public setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    this.cursorStyle = style;
  }

  /**
   * Enable/disable cursor blinking
   */
  public setCursorBlink(enabled: boolean): void {
    if (enabled && !this.cursorBlink) {
      this.cursorBlink = true;
      this.startCursorBlink();
    } else if (!enabled && this.cursorBlink) {
      this.cursorBlink = false;
      this.stopCursorBlink();
    }
  }

  /**
   * Get current font metrics
   */

  /**
   * Render scrollbar (Phase 2)
   * Shows scroll position and allows click/drag interaction
   * @param opacity Opacity level (0-1) for fade in/out effect
   */
  private renderScrollbar(
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number,
    opacity: number = 1
  ): void {
    const ctx = this.ctx;
    const canvasHeight = this.canvas.height / this.devicePixelRatio;
    const canvasWidth = this.canvas.width / this.devicePixelRatio;

    // Scrollbar dimensions
    const scrollbarWidth = 8;
    const scrollbarX = canvasWidth - scrollbarWidth - 4;
    const scrollbarPadding = 4;
    const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;

    // Always clear the scrollbar area first (fixes ghosting when fading out)
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);

    // Don't draw scrollbar if fully transparent or no scrollback
    if (opacity <= 0 || scrollbackLength === 0) return;

    // Calculate scrollbar thumb size and position
    const totalLines = scrollbackLength + visibleRows;
    const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);

    // Position: 0 = at bottom, scrollbackLength = at top
    const scrollPosition = viewportY / scrollbackLength; // 0 to 1
    const thumbY = scrollbarPadding + (scrollbarTrackHeight - thumbHeight) * (1 - scrollPosition);

    // Draw scrollbar track (subtle background) with opacity
    ctx.fillStyle = `rgba(128, 128, 128, ${0.1 * opacity})`;
    ctx.fillRect(scrollbarX, scrollbarPadding, scrollbarWidth, scrollbarTrackHeight);

    // Draw scrollbar thumb with opacity
    const isScrolled = viewportY > 0;
    const baseOpacity = isScrolled ? 0.5 : 0.3;
    ctx.fillStyle = `rgba(128, 128, 128, ${baseOpacity * opacity})`;
    ctx.fillRect(scrollbarX, thumbY, scrollbarWidth, thumbHeight);
  }
  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  /**
   * Get canvas element (needed by SelectionManager)
   */
  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Set selection manager (for rendering selection)
   */
  public setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
  }

  /**
   * Check if a cell at (x, y) is within the current selection.
   * Uses cached selection coordinates for performance.
   */
  private isInSelection(x: number, y: number): boolean {
    const sel = this.currentSelectionCoords;
    if (!sel) return false;

    const { startCol, startRow, endCol, endRow } = sel;

    // Single line selection
    if (startRow === endRow) {
      return y === startRow && x >= startCol && x <= endCol;
    }

    // Multi-line selection
    if (y === startRow) {
      // First line: from startCol to end of line
      return x >= startCol;
    } else if (y === endRow) {
      // Last line: from start of line to endCol
      return x <= endCol;
    } else if (y > startRow && y < endRow) {
      // Middle lines: entire line is selected
      return true;
    }

    return false;
  }

  /**
   * Set the currently hovered hyperlink ID for rendering underlines
   */
  public setHoveredHyperlinkId(hyperlinkId: number): void {
    this.hoveredHyperlinkId = hyperlinkId;
  }

  /**
   * Set the currently hovered link range for rendering underlines (for regex-detected URLs)
   * Pass null to clear the hover state
   */
  public setHoveredLinkRange(
    range: {
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    } | null
  ): void {
    this.hoveredLinkRange = range;
  }

  /**
   * Get character cell width (for coordinate conversion)
   */
  public get charWidth(): number {
    return this.metrics.width;
  }

  /**
   * Get character cell height (for coordinate conversion)
   */
  public get charHeight(): number {
    return this.metrics.height;
  }

  /**
   * Clear entire canvas
   */
  public clear(): void {
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Cleanup resources
   */
  public dispose(): void {
    this.stopCursorBlink();
  }
}

// ============================================================================
// Helpers (dopamine #414)
// ============================================================================

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const n = Number.parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Move `fg` towards white or black (whichever the background allows) until the ratio holds. */
export function ensureContrast(
  fg: [number, number, number],
  bg: [number, number, number],
  ratio: number
): [number, number, number] {
  if (contrastRatio(fg, bg) >= ratio) return fg;
  const towards: [number, number, number] = luminance(bg) > 0.5 ? [0, 0, 0] : [255, 255, 255];
  let out = fg;
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    out = [0, 1, 2].map((i) => Math.round(fg[i] + (towards[i] - fg[i]) * t)) as [number, number, number];
    if (contrastRatio(out, bg) >= ratio) break;
  }
  return out;
}

export function isCustomGlyph(cp: number): boolean {
  return (cp >= 0x2500 && cp <= 0x257f) || (cp >= 0x2580 && cp <= 0x259f);
}

/**
 * Box drawing (U+2500–257F): each glyph is up/right/down/left arms of weight
 * 0 none, 1 light, 2 heavy, 3 double. Blocks (U+2580–259F) are rectangles / shades.
 */
const BOX: Record<number, [number, number, number, number]> = {};
(() => {
  // [up, right, down, left]
  const set = (cp: number, u: number, r: number, d: number, l: number) => {
    BOX[cp] = [u, r, d, l];
  };
  set(0x2500, 0, 1, 0, 1); set(0x2501, 0, 2, 0, 2); set(0x2502, 1, 0, 1, 0); set(0x2503, 2, 0, 2, 0);
  set(0x250c, 0, 1, 1, 0); set(0x250f, 0, 2, 2, 0); set(0x2510, 0, 0, 1, 1); set(0x2513, 0, 0, 2, 2);
  set(0x2514, 1, 1, 0, 0); set(0x2517, 2, 2, 0, 0); set(0x2518, 1, 0, 0, 1); set(0x251b, 2, 0, 0, 2);
  set(0x251c, 1, 1, 1, 0); set(0x2523, 2, 2, 2, 0); set(0x2524, 1, 0, 1, 1); set(0x252b, 2, 0, 2, 2);
  set(0x252c, 0, 1, 1, 1); set(0x2533, 0, 2, 2, 2); set(0x2534, 1, 1, 0, 1); set(0x253b, 2, 2, 0, 2);
  set(0x253c, 1, 1, 1, 1); set(0x254b, 2, 2, 2, 2);
  set(0x2550, 0, 3, 0, 3); set(0x2551, 3, 0, 3, 0); set(0x2554, 0, 3, 3, 0); set(0x2557, 0, 0, 3, 3);
  set(0x255a, 3, 3, 0, 0); set(0x255d, 3, 0, 0, 3); set(0x2560, 3, 3, 3, 0); set(0x2563, 3, 0, 3, 3);
  set(0x2566, 0, 3, 3, 3); set(0x2569, 3, 3, 0, 3); set(0x256c, 3, 3, 3, 3);
  // rounded corners are drawn as light corners
  set(0x256d, 0, 1, 1, 0); set(0x256e, 0, 0, 1, 1); set(0x256f, 1, 0, 0, 1); set(0x2570, 1, 1, 0, 0);
  set(0x2574, 0, 0, 0, 1); set(0x2575, 1, 0, 0, 0); set(0x2576, 0, 1, 0, 0); set(0x2577, 0, 0, 1, 0);
})();

export function drawCustomGlyph(
  ctx: CanvasRenderingContext2D,
  cp: number,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  if (cp >= 0x2580) {
    const shade = (a: number) => {
      const old = ctx.globalAlpha;
      ctx.globalAlpha = old * a;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = old;
    };
    switch (cp) {
      case 0x2580: ctx.fillRect(x, y, w, h / 2); return;
      case 0x2584: ctx.fillRect(x, y + h / 2, w, h / 2); return;
      case 0x2588: ctx.fillRect(x, y, w, h); return;
      case 0x258c: ctx.fillRect(x, y, w / 2, h); return;
      case 0x2590: ctx.fillRect(x + w / 2, y, w / 2, h); return;
      case 0x2591: shade(0.25); return;
      case 0x2592: shade(0.5); return;
      case 0x2593: shade(0.75); return;
      default:
        // lower eighths ▁..▇ (2581–2587), left eighths ▉..▏ (2589–258F)
        if (cp >= 0x2581 && cp <= 0x2587) {
          const f = (cp - 0x2580) / 8;
          ctx.fillRect(x, y + h * (1 - f), w, h * f);
        } else if (cp >= 0x2589 && cp <= 0x258f) {
          const f = (0x2590 - cp) / 8;
          ctx.fillRect(x, y, w * f, h);
        } else {
          ctx.fillText(String.fromCodePoint(cp), x, y + h * 0.8);
        }
        return;
    }
  }
  const arms = BOX[cp];
  if (!arms) {
    ctx.fillText(String.fromCodePoint(cp), x, y + h * 0.8);
    return;
  }
  const light = Math.max(1, Math.round(h / 16));
  const heavy = light * 2;
  const cx = Math.round(x + w / 2);
  const cy = Math.round(y + h / 2);
  const t = (wgt: number) => (wgt === 2 ? heavy : light);
  // A double line is two light lines `gap` apart.
  const gap = light * 2;
  const [u, r, d, l] = arms;
  const hline = (x0: number, x1: number, wgt: number) => {
    if (wgt === 3) {
      ctx.fillRect(x0, cy - gap, x1 - x0, light);
      ctx.fillRect(x0, cy + gap - light, x1 - x0, light);
    } else {
      ctx.fillRect(x0, cy - Math.floor(t(wgt) / 2), x1 - x0, t(wgt));
    }
  };
  const vline = (y0: number, y1: number, wgt: number) => {
    if (wgt === 3) {
      ctx.fillRect(cx - gap, y0, light, y1 - y0);
      ctx.fillRect(cx + gap - light, y0, light, y1 - y0);
    } else {
      ctx.fillRect(cx - Math.floor(t(wgt) / 2), y0, t(wgt), y1 - y0);
    }
  };
  // Arms meet at the centre. An arm that stops there (a corner or tee) reaches
  // exactly to the far edge of the crossing line — no further, so corners neither
  // gap nor poke out.
  const span = (wgt: number) => (wgt === 3 ? gap + light : wgt ? Math.ceil(t(wgt) / 2) : 0);
  const vReach = Math.max(span(u), span(d));
  const hReach = Math.max(span(l), span(r));
  if (l) hline(x, r ? cx : cx + vReach, l);
  if (r) hline(l ? cx : cx - vReach, x + w, r);
  if (u) vline(y, d ? cy : cy + hReach, u);
  if (d) vline(u ? cy : cy - hReach, y + h, d);
}
