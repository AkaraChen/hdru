// The provider for `ui-tui`'s `surface.Surface`: a terminal under Node.
//
// It keeps the retained tree the commands describe, lays it out with the
// small flexbox pass below, paints it into a grid of cells, and writes the
// rows that changed as ANSI. Key presses become the protocol's events: Tab
// and Shift-Tab move the focus, Enter and Space click, typing edits a field,
// Space toggles a checkbox, a left press focuses and clicks, and `q` (outside
// a field) or Ctrl-C sends handler 0.
//
// With stdout not a terminal it prints each changed frame as plain text, and
// stdin may be a pipe, whose end also sends handler 0:
//   printf '\t\rq' | hd run counter-tui
//
// This is the terminal's half of rendering.md: its kinds and keys as
// far as a cell grid can follow them. Unknown kinds are boxes, unknown keys
// are dropped, and a key with a renderer prefix ("dom:...") is another
// renderer's. docs/rendering.md says where it departs.
//
// Commands arrive as { tag, fields }; see ui-dom/providers/dom.mjs. Each part
// is exported for providers/tui.test.mjs, which needs no terminal; importing
// this module touches nothing until the first `apply`.

import { execFileSync, spawn } from "node:child_process";
import { closeSync, createReadStream, fstatSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadStream, WriteStream, isatty } from "node:tty";
import { Worker, isMainThread } from "node:worker_threads";

// ---- Units ---------------------------------------------------------------
//
// The vocabulary's numbers are logical pixels and a renderer applies its own
// scale. A cell is taken as 8 by 16 pixels, the
// usual terminal font, so `padding(16)` is two columns and one row. Any
// nonzero border is one cell, the only width a box-drawing glyph has.

const CELL_WIDTH = 8;
const CELL_HEIGHT = 16;
const toCols = (px) => Math.round(px / CELL_WIDTH);
const toRows = (px) => Math.round(px / CELL_HEIGHT);

// A field with no size of its own, about as wide as a browser's default.
const INPUT_COLS = 20;
const INPUT_MIN_COLS = 4;

// ---- Text ----------------------------------------------------------------

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text) => Array.from(segmenter.segment(text), (part) => part.segment);

const WIDE = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

// The cells one grapheme takes: 0 for a control character, which must never
// reach the terminal, or a lone combining mark.
export function graphemeWidth(grapheme) {
  const code = grapheme.codePointAt(0);
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (/^\p{Mark}/u.test(grapheme)) return 0;
  return WIDE.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
}

export function textWidth(text) {
  let width = 0;
  for (const grapheme of graphemes(text)) width += graphemeWidth(grapheme);
  return width;
}

// `text` broken into lines of at most `limit` cells, at spaces where it can
// and inside a word that is too long for a line. No limit keeps only its own
// line breaks.
export function wrapText(text, limit = null) {
  if (limit !== null && limit <= 0) return [""];
  const lines = [];
  for (const paragraph of text.split("\n")) {
    if (limit === null || textWidth(paragraph) <= limit) {
      lines.push(paragraph);
      continue;
    }
    let line = "";
    let width = 0;
    const flush = () => {
      lines.push(line);
      line = "";
      width = 0;
    };
    for (const word of paragraph.split(/(?<= )/)) {
      const wordWidth = textWidth(word.trimEnd());
      if (width > 0 && width + wordWidth > limit) flush();
      for (const grapheme of graphemes(word)) {
        const cells = graphemeWidth(grapheme);
        if (width + cells > limit && width > 0) {
          if (grapheme === " ") continue;
          flush();
        }
        line += grapheme;
        width += cells;
      }
    }
    lines.push(line);
  }
  return lines.map((line) => line.trimEnd());
}

// ---- The retained tree ---------------------------------------------------

const KINDS = new Set(["box", "text", "button", "input", "checkbox", "fragment"]);

function newNode(id, kind) {
  return { id, kind, parent: null, children: [], text: "", props: new Map(), listeners: new Map(), cursor: null };
}

// The tree the commands describe. Node 0 is the terminal's root, a column.
export function createTree() {
  const nodes = new Map();
  const root = newNode(0, "box");
  nodes.set(0, root);
  const node = (id) => {
    const found = nodes.get(id);
    if (!found) throw new Error(`ui: unknown node ${id}`);
    return found;
  };
  const detach = (child) => {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = null;
  };
  const forget = (n) => {
    for (const child of n.children) forget(child);
    nodes.delete(n.id);
  };
  const apply = (command) => {
    const f = command.fields;
    switch (command.tag) {
      case "Create":
        nodes.set(f.node, newNode(f.node, KINDS.has(f.kind) ? f.kind : "box"));
        break;
      case "Append": {
        const child = node(f.child);
        detach(child);
        child.parent = node(f.parent);
        child.parent.children.push(child);
        break;
      }
      case "MoveBefore": {
        const child = node(f.child);
        detach(child);
        child.parent = node(f.parent);
        const siblings = child.parent.children;
        const index = f.before === null ? -1 : siblings.indexOf(node(f.before));
        if (index < 0) siblings.push(child);
        else siblings.splice(index, 0, child);
        break;
      }
      case "Remove": {
        const target = node(f.node);
        detach(target);
        forget(target);
        break;
      }
      case "Clear": {
        const target = node(f.node);
        for (const child of target.children) {
          child.parent = null;
          forget(child);
        }
        target.children = [];
        break;
      }
      case "SetText":
        node(f.node).text = f.text;
        break;
      case "SetProp":
        // A prefixed key belongs to another renderer.
        if (f.key.includes(":")) break;
        // hd replacing a field's text puts the cursor back at its end.
        if (f.key === "value") node(f.node).cursor = null;
        if (f.value.tag === "Unset") node(f.node).props.delete(f.key);
        else node(f.node).props.set(f.key, f.value);
        break;
      case "Listen": {
        // A prefixed event belongs to another renderer. Listening would also
        // make the node take the focus.
        if (f.event.includes(":")) break;
        const n = node(f.node);
        if (!n.listeners.has(f.event)) n.listeners.set(f.event, []);
        n.listeners.get(f.event).push(f.handler);
        break;
      }
      default:
        throw new Error(`ui: unknown command ${command.tag}`);
    }
  };
  return { root, nodes, apply };
}

const prop = (node, key) => node.props.get(key)?.fields;
const num = (node, key) => prop(node, key)?.value ?? 0;
const word = (node, key) => prop(node, key)?.value;
const flag = (node, key) => prop(node, key)?.value === true;
const paintOf = (node, key) => prop(node, key)?.color ?? null;

// ---- Layout --------------------------------------------------------------
//
// A flexbox subset over whole cells: direction, gap, padding, margin, border,
// width and height with Px / Pct / Auto / Fill, min and max, grow, shrink,
// justify, align. One line only: `wrap` is not followed. Sizes are border
// box, as React Native's. `layout` is pure: it returns a tree of
// { node, x, y, w, h, kids }, with x and y relative to the parent.

function edges(node) {
  const border = num(node, "border_width") > 0 ? 1 : 0;
  return {
    left: border + toCols(num(node, "padding_left")),
    right: border + toCols(num(node, "padding_right")),
    top: border + toRows(num(node, "padding_top")),
    bottom: border + toRows(num(node, "padding_bottom")),
  };
}

function margins(node) {
  return {
    left: toCols(num(node, "margin_left")),
    right: toCols(num(node, "margin_right")),
    top: toRows(num(node, "margin_top")),
    bottom: toRows(num(node, "margin_bottom")),
  };
}

// A size key in cells, "fill", or null for auto. A percentage of an unknown
// base is auto, as in CSS.
function extent(node, key, base) {
  const size = prop(node, key)?.size;
  if (!size) return null;
  switch (size.tag) {
    case "Px":
      return key.endsWith("width") ? toCols(size.fields.value) : toRows(size.fields.value);
    case "Pct":
      return base === null ? null : Math.round((base * size.fields.value) / 100);
    case "Fill":
      return "fill";
    default:
      return null;
  }
}

function limit(node, key, base) {
  const value = extent(node, key, base);
  return typeof value === "number" ? value : null;
}

function clamp(value, low, high) {
  let out = value;
  if (high !== null) out = Math.min(out, high);
  if (low !== null) out = Math.max(out, low);
  return out;
}

function flattened(node) {
  const out = [];
  for (const child of node.children) {
    if (child.kind === "fragment") out.push(...flattened(child));
    else out.push(child);
  }
  return out;
}

// A button that holds only text is one label: it centers, wraps and takes its
// brackets as a whole. A button holding anything else lays out as a box.
const isLabel = (node) => node.kind === "button" && flattened(node).every((child) => child.kind === "text");

// The children that take part in layout: a fragment's stand in for it.
function flowChildren(node) {
  return isLabel(node) ? [] : flattened(node);
}

const contentOf = (node) => (isLabel(node) ? flattened(node).map((child) => child.text).join("") : node.text);

// A button draws brackets when nothing else marks it: the DOM's button has
// chrome of its own, and a terminal has none.
function bracketed(node) {
  return node.kind === "button" && !(num(node, "border_width") > 0) && !paintOf(node, "background");
}

function labelOf(node) {
  return bracketed(node) && isLabel(node) ? `[${contentOf(node)}]` : contentOf(node);
}

function leafContent(node, innerW) {
  if (node.kind === "input") return { w: INPUT_COLS, h: 1 };
  if (node.kind === "checkbox") return { w: 3, h: 1 };
  const lines = wrapText(labelOf(node), innerW);
  let w = 0;
  for (const line of lines) w = Math.max(w, textWidth(line));
  return { w, h: labelOf(node) === "" ? 0 : lines.length };
}

// The narrowest `node` can get along a row: its longest word, the whole of a
// button's label, or its children's narrowest.
function minContentWidth(node) {
  const declared = limit(node, "min_width", null);
  if (declared !== null) return declared;
  const e = edges(node);
  const kids = flowChildren(node);
  let content = 0;
  if (kids.length) {
    const row = word(node, "direction") === "row";
    for (const child of kids) {
      const m = margins(child);
      const width = minContentWidth(child) + m.left + m.right;
      content = row ? content + width : Math.max(content, width);
    }
    if (row) content += toCols(num(node, "gap")) * (kids.length - 1);
  } else if (node.kind === "input") {
    content = INPUT_MIN_COLS;
  } else if (node.kind === "checkbox") {
    content = 3;
  } else if (node.kind === "button") {
    content = leafContent(node, null).w;
  } else {
    for (const part of node.text.split(/\s+/)) content = Math.max(content, textWidth(part));
  }
  return content + e.left + e.right;
}

// Shares `free` cells out by `weights`, in whole cells that add up.
function share(free, weights) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let used = 0;
  let seen = 0;
  return weights.map((weight) => {
    seen += weight;
    const upTo = total === 0 ? 0 : Math.round((free * seen) / total);
    const part = upTo - used;
    used = upTo;
    return part;
  });
}

function placeLeaf(node, W, H) {
  const e = edges(node);
  const innerW = W === null ? null : Math.max(0, W - e.left - e.right);
  const content = leafContent(node, innerW);
  return {
    node,
    x: 0,
    y: 0,
    w: W ?? content.w + e.left + e.right,
    h: H ?? content.h + e.top + e.bottom,
    kids: [],
  };
}

// Lays `node` out at border box W by H, either of which may be null for its
// content's size.
function place(memo, node, W, H) {
  let known = memo.get(node);
  if (!known) memo.set(node, (known = new Map()));
  const key = `${W},${H}`;
  let result = known.get(key);
  if (!result) {
    const kids = flowChildren(node);
    result = kids.length ? placeBox(memo, node, kids, W, H) : placeLeaf(node, W, H);
    known.set(key, result);
  }
  return result;
}

function placeBox(memo, node, kids, W, H) {
  const e = edges(node);
  const row = word(node, "direction") === "row";
  const innerW = W === null ? null : Math.max(0, W - e.left - e.right);
  const innerH = H === null ? null : Math.max(0, H - e.top - e.bottom);
  const mainSpace = row ? innerW : innerH;
  const crossSpace = row ? innerH : innerW;
  const gap = row ? toCols(num(node, "gap")) : toRows(num(node, "gap"));
  const mainKey = row ? "width" : "height";
  const crossKey = row ? "height" : "width";
  const align = word(node, "align") ?? "stretch";
  const lay = (child, main, cross) => (row ? place(memo, child, main, cross) : place(memo, child, cross, main));
  const mainOf = (laid) => (row ? laid.w : laid.h);
  const crossOf = (laid) => (row ? laid.h : laid.w);

  const items = kids.map((child) => {
    const m = margins(child);
    const mainMargin = row ? m.left + m.right : m.top + m.bottom;
    const crossMargin = row ? m.top + m.bottom : m.left + m.right;
    const wantMain = extent(child, mainKey, mainSpace);
    const wantCross = extent(child, crossKey, crossSpace);
    const minMain = limit(child, `min_${mainKey}`, mainSpace);
    const maxMain = limit(child, `max_${mainKey}`, mainSpace);
    const room = crossSpace === null ? null : Math.max(0, crossSpace - crossMargin);
    const clampCross = (value) =>
      value === null ? null : clamp(value, limit(child, `min_${crossKey}`, crossSpace), limit(child, `max_${crossKey}`, crossSpace));
    const stretch = typeof wantCross !== "number" && (wantCross === "fill" || align === "stretch");
    let cross = typeof wantCross === "number" ? wantCross : stretch ? room : null;
    // A column's child that does not stretch still wraps at the column.
    if (cross === null && !row && room !== null) cross = Math.min(place(memo, child, null, null).w, room);
    cross = clampCross(cross);
    const fill = wantMain === "fill" && mainSpace !== null;
    const natural = typeof wantMain === "number" ? wantMain : mainOf(lay(child, null, cross));
    return {
      child,
      m,
      mainMargin,
      crossMargin,
      stretch,
      cross,
      clampCross,
      minMain,
      maxMain,
      grow: wantMain === "fill" ? Math.max(num(child, "grow"), 1) : num(child, "grow"),
      shrink: child.props.has("shrink") ? num(child, "shrink") : 1,
      size: clamp(fill ? 0 : natural, minMain, maxMain),
    };
  });

  const gaps = gap * Math.max(0, items.length - 1);
  const used = () => items.reduce((sum, item) => sum + item.size + item.mainMargin, gaps);
  if (mainSpace !== null) {
    const free = mainSpace - used();
    if (free > 0) {
      const parts = share(free, items.map((item) => item.grow));
      items.forEach((item, index) => {
        item.size = clamp(item.size + parts[index], item.minMain, item.maxMain);
      });
    } else if (free < 0 && row) {
      // Columns do not shrink: their overflow is the screen's to scroll.
      // Along a row, one cell at a time off the widest that can give it,
      // which is flex-shrink's result in whole cells.
      const floors = items.map((item) => (item.shrink > 0 ? Math.max(item.minMain ?? 0, Math.min(minContentWidth(item.child), item.size)) : item.size));
      for (let over = -free; over > 0; over -= 1) {
        let widest = -1;
        items.forEach((item, index) => {
          if (item.size > floors[index] && (widest < 0 || item.size > items[widest].size)) widest = index;
        });
        if (widest < 0) break;
        items[widest].size -= 1;
      }
    }
  }

  let laid = items.map((item) => lay(item.child, item.size, item.cross));
  let line = 0;
  laid.forEach((box, index) => {
    line = Math.max(line, crossOf(box) + items[index].crossMargin);
  });
  // An auto-sized cross axis is the line's, and now stretching can happen.
  if (crossSpace === null) {
    laid = laid.map((box, index) => {
      const item = items[index];
      return item.stretch ? lay(item.child, item.size, item.clampCross(line - item.crossMargin)) : box;
    });
  }

  const crossSize = crossSpace ?? line;
  const free = mainSpace === null ? 0 : Math.max(0, mainSpace - used());
  const justify = word(node, "justify") ?? "start";
  const count = items.length;
  let cursor = 0;
  let between = gap;
  if (justify === "center") cursor = free / 2;
  else if (justify === "end") cursor = free;
  else if (justify === "between" && count > 1) between = gap + free / (count - 1);
  else if (justify === "around") {
    cursor = free / count / 2;
    between = gap + free / count;
  }
  const originX = e.left;
  const originY = e.top;
  const boxes = laid.map((box, index) => {
    const item = items[index];
    const left = crossSize - crossOf(box) - item.crossMargin;
    let offset = 0;
    if (align === "center") offset = Math.max(0, Math.floor(left / 2));
    else if (align === "end") offset = Math.max(0, left);
    const at = Math.round(cursor);
    cursor += mainOf(box) + item.mainMargin + between;
    return row
      ? { ...box, x: originX + at + item.m.left, y: originY + offset + item.m.top }
      : { ...box, x: originX + offset + item.m.left, y: originY + at + item.m.top };
  });

  const contentMain = used();
  return {
    node,
    x: 0,
    y: 0,
    w: W ?? (row ? contentMain : line) + e.left + e.right,
    h: H ?? (row ? line : contentMain) + e.top + e.bottom,
    kids: boxes,
  };
}

// The layout of `root` on a screen of `cols` by `rows`.
export function layout(root, cols, rows) {
  return place(new Map(), root, cols, rows);
}

// ---- Painting ------------------------------------------------------------

function blend(top, under) {
  const alpha = top.a / 255;
  if (!under || alpha === 1) return { r: top.r, g: top.g, b: top.b };
  const mix = (a, b) => Math.round(a * alpha + b * (1 - alpha));
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b) };
}

// What a text with no color of its own reads as on `background`. The DOM's
// default is black on a white page; a terminal's default may be the reverse,
// and an app that paints a light surface must not get light text on it.
function contrast(background) {
  const luma = 0.299 * background.r + 0.587 * background.g + 0.114 * background.b;
  return luma > 140 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
}

// What `node` takes from its ancestors. rendering.md promises no inheritance,
// but `text` takes no style, so text is styled by the view around
// it and the examples rely on the DOM passing that down. GPUI passes color as
// well. Fragments count: `show` may be restyled though it takes no layout.
function inherited(node) {
  let color = null;
  let weight = null;
  let opacity = 1;
  for (let at = node; at; at = at.parent) {
    color ??= paintOf(at, "color");
    weight ??= at.props.has("font_weight") ? num(at, "font_weight") : null;
    if (at.props.has("opacity")) opacity *= num(at, "opacity");
  }
  return { color, bold: (weight ?? 400) >= 600, dim: opacity < 1 };
}

function blankCell() {
  return { ch: " ", fg: null, bg: null, bold: false, dim: false, reverse: false, underline: false };
}

class Grid {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.cells = Array.from({ length: rows }, () => Array.from({ length: cols }, blankCell));
  }
  at(x, y) {
    return this.cells[y]?.[x];
  }
  // Paints `background` over a rectangle; a clip is [x0, y0, x1, y1).
  fill(x, y, w, h, color, clip) {
    if (color.a === 0) return;
    for (let cy = Math.max(y, clip[1]); cy < Math.min(y + h, clip[3]); cy += 1) {
      for (let cx = Math.max(x, clip[0]); cx < Math.min(x + w, clip[2]); cx += 1) {
        this.repair(cx, cy);
        const cell = this.cells[cy][cx];
        cell.bg = blend(color, cell.bg);
        cell.ch = " ";
        cell.fg = null;
      }
    }
  }
  // Blanks the other half of a wide glyph that a write at (x, y) cuts in two.
  repair(x, y) {
    const row = this.cells[y];
    if (row[x].ch === "" && x > 0) row[x - 1].ch = " ";
    if (x + 1 < row.length && row[x + 1].ch === "") row[x + 1].ch = " ";
  }
  // One glyph of `width` cells; a wide one that cannot fit shows as a blank.
  put(x, y, glyph, width, style, clip) {
    if (y < clip[1] || y >= clip[3] || x >= clip[2] || x + width <= clip[0]) return;
    const fits = x >= clip[0] && x + width <= clip[2];
    for (let i = 0; i < width; i += 1) {
      const cx = x + i;
      if (cx >= clip[0] && cx < clip[2]) this.repair(cx, y);
    }
    for (let i = 0; i < width; i += 1) {
      const cx = x + i;
      if (cx < clip[0] || cx >= clip[2]) continue;
      const cell = this.cells[y][cx];
      cell.ch = !fits ? " " : i === 0 ? glyph : "";
      cell.fg = style.color ? blend(style.color, cell.bg) : cell.bg ? contrast(cell.bg) : null;
      cell.bold = Boolean(style.bold);
      cell.dim = Boolean(style.dim);
      cell.underline = Boolean(style.underline);
    }
  }
  text(x, y, text, style, clip) {
    let cx = x;
    for (const grapheme of graphemes(text)) {
      const width = graphemeWidth(grapheme);
      if (width === 0) continue;
      this.put(cx, y, grapheme, width, style, clip);
      cx += width;
    }
  }
  mark(x, y, w, h, field, clip) {
    for (let cy = Math.max(y, clip[1]); cy < Math.min(y + h, clip[3]); cy += 1) {
      for (let cx = Math.max(x, clip[0]); cx < Math.min(x + w, clip[2]); cx += 1) {
        this.cells[cy][cx][field] = true;
      }
    }
  }
}

function drawBorder(grid, x, y, w, h, node, style, clip) {
  const round = num(node, "radius") > 0;
  const glyphs = round ? "╭╮╰╯" : "┌┐└┘";
  const border = { ...style, color: paintOf(node, "border_color") ?? style.color };
  for (let cx = x + 1; cx < x + w - 1; cx += 1) {
    grid.put(cx, y, "─", 1, border, clip);
    grid.put(cx, y + h - 1, "─", 1, border, clip);
  }
  for (let cy = y + 1; cy < y + h - 1; cy += 1) {
    grid.put(x, cy, "│", 1, border, clip);
    grid.put(x + w - 1, cy, "│", 1, border, clip);
  }
  grid.put(x, y, glyphs[0], 1, border, clip);
  grid.put(x + w - 1, y, glyphs[1], 1, border, clip);
  grid.put(x, y + h - 1, glyphs[2], 1, border, clip);
  grid.put(x + w - 1, y + h - 1, glyphs[3], 1, border, clip);
}

// What a field of `room` cells shows of `value` with its cursor at grapheme
// `at`: as much as fits up to the cursor, leaving a cell for it, then whatever
// follows. `width` is the cursor's column.
function fieldWindow(value, at, room) {
  const parts = graphemes(value);
  const cursor = Math.min(at ?? parts.length, parts.length);
  let width = 0;
  let start = cursor;
  while (start > 0) {
    const cells = graphemeWidth(parts[start - 1]);
    if (width + cells > room - 1) break;
    width += cells;
    start -= 1;
  }
  return { text: parts.slice(start).join(""), width };
}

function paintBox(grid, box, ox, oy, clip, focus) {
  const { node, w, h } = box;
  const x = ox + box.x;
  const y = oy + box.y;
  const style = inherited(node);
  const focused = node === focus;
  const background = paintOf(node, "background");
  if (background) grid.fill(x, y, w, h, background, clip);
  const hasBorder = num(node, "border_width") > 0 && w >= 2 && h >= 2;
  const e = edges(node);
  const inner = [
    Math.max(clip[0], x + e.left),
    Math.max(clip[1], y + e.top),
    Math.min(clip[2], x + w - e.right),
    Math.min(clip[3], y + h - e.bottom),
  ];
  if (hasBorder) drawBorder(grid, x, y, w, h, node, style, clip);
  const iw = Math.max(0, w - e.left - e.right);
  const ih = Math.max(0, h - e.top - e.bottom);
  const dim = style.dim || flag(node, "disabled");
  if (node.kind === "input") {
    const tail = fieldWindow(word(node, "value") ?? "", node.cursor, iw);
    const field = { ...style, dim };
    grid.text(x + e.left, y + e.top, tail.text, field, inner);
    if (!hasBorder) grid.mark(x + e.left, y + e.top, iw, 1, "underline", inner);
    if (focused) grid.mark(x + e.left + tail.width, y + e.top, 1, 1, "reverse", inner);
  } else if (node.kind === "checkbox") {
    grid.text(x + e.left, y + e.top, flag(node, "checked") ? "[x]" : "[ ]", { ...style, dim }, inner);
  } else if (box.kids.length === 0) {
    const lines = wrapText(labelOf(node), iw);
    const center = node.kind === "button";
    const top = center ? Math.max(0, Math.floor((ih - lines.length) / 2)) : 0;
    lines.forEach((line, index) => {
      const left = center ? Math.max(0, Math.floor((iw - textWidth(line)) / 2)) : 0;
      grid.text(x + e.left + left, y + e.top + top + index, line, { ...style, dim }, inner);
    });
  }
  const overflow = word(node, "overflow");
  const kidClip = overflow === "hidden" || overflow === "scroll" ? inner : clip;
  for (const kid of box.kids) paintBox(grid, kid, x, y, kidClip, focus);
  // The focus is the cells inside the border in reverse video; in a field,
  // only its cursor.
  if (focused && node.kind !== "input") grid.mark(x + e.left, y + e.top, iw, ih, "reverse", inner);
}

// Where `node`'s box lies on the page, or null if it has none.
function boxOf(box, node, ox = 0, oy = 0) {
  const x = ox + box.x;
  const y = oy + box.y;
  if (box.node === node) return { x, y, w: box.w, h: box.h };
  for (const kid of box.kids) {
    const found = boxOf(kid, node, x, y);
    if (found) return found;
  }
  return null;
}

// The innermost box at a point of the page, the last painted if they overlap.
function boxAt(box, px, py, ox = 0, oy = 0) {
  const x = ox + box.x;
  const y = oy + box.y;
  // Children first: a page taller than the screen overflows the root.
  for (let i = box.kids.length - 1; i >= 0; i -= 1) {
    const found = boxAt(box.kids[i], px, py, x, y);
    if (found) return found;
  }
  return px < x || py < y || px >= x + box.w || py >= y + box.h ? null : box;
}

// The bottom of the laid-out page, which may lie past the screen.
function pageHeight(box, oy = 0) {
  const y = oy + box.y;
  let bottom = y + box.h;
  for (const kid of box.kids) bottom = Math.max(bottom, pageHeight(kid, y));
  return bottom;
}

// Paints a laid-out tree into a new grid, its page moved up by `scroll` rows.
export function paint(laid, cols, rows, focus = null, scroll = 0) {
  const grid = new Grid(cols, rows);
  paintBox(grid, laid, 0, -scroll, [0, 0, cols, rows], focus);
  return grid;
}

// A grid's rows as plain text, right-trimmed.
export function plainRows(grid) {
  return grid.cells.map((row) =>
    row
      .map((cell) => cell.ch)
      .join("")
      .trimEnd(),
  );
}

// One color as SGR parameters, for a terminal of `depth` color bits.
function colorParams(color, depth, base) {
  if (depth >= 24) return `;${base};2;${color.r};${color.g};${color.b}`;
  if (depth >= 8) {
    const level = (value) => (value < 48 ? 0 : value < 115 ? 1 : Math.min(5, Math.round((value - 35) / 40)));
    const index = 16 + 36 * level(color.r) + 6 * level(color.g) + level(color.b);
    return `;${base};5;${index}`;
  }
  return "";
}

function cellParams(cell, depth) {
  let params = "";
  if (cell.bold) params += ";1";
  if (cell.dim) params += ";2";
  if (cell.underline) params += ";4";
  if (cell.reverse) params += ";7";
  if (cell.fg) params += colorParams(cell.fg, depth, 38);
  if (cell.bg) params += colorParams(cell.bg, depth, 48);
  return params;
}

// A grid's row with its colors and attributes, from and back to the default.
export function ansiRow(row, depth) {
  let out = "";
  let current = "";
  for (const cell of row) {
    if (cell.ch === "") continue;
    const params = cellParams(cell, depth);
    if (params !== current) {
      out += `\x1b[0${params}m`;
      current = params;
    }
    out += cell.ch;
  }
  return current === "" ? out : `${out}\x1b[0m`;
}

// ---- Keys ----------------------------------------------------------------
//
// Key names are the DOM's `KeyboardEvent.key`, so a `key` listener gets the
// same payload on either renderer. "Ctrl-C" is the one control chord kept.

const SEQUENCES = new Map([
  ["\x1b[A", "ArrowUp"],
  ["\x1b[B", "ArrowDown"],
  ["\x1b[C", "ArrowRight"],
  ["\x1b[D", "ArrowLeft"],
  ["\x1bOA", "ArrowUp"],
  ["\x1bOB", "ArrowDown"],
  ["\x1bOC", "ArrowRight"],
  ["\x1bOD", "ArrowLeft"],
  ["\x1b[H", "Home"],
  ["\x1b[F", "End"],
  ["\x1b[3~", "Delete"],
  ["\x1b[Z", "Shift-Tab"],
]);

// The escape sequence at the start of `text`, or "" when it is incomplete.
function escapeAt(text) {
  if (text.length < 2) return "";
  if (text[1] === "[" || text[1] === "O") {
    for (let i = 2; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return text.slice(0, i + 1);
    }
    return "";
  }
  return text.slice(0, 2);
}

// Splits bytes read from a terminal into key names, as a list, and what is
// left of a sequence the read cut in two. A printable key's name is itself;
// an unknown sequence names nothing and is dropped whole.
export function parseKeys(text) {
  const keys = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    if (rest[0] === "\x1b") {
      const sequence = escapeAt(rest);
      if (sequence === "") return { keys, rest };
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)M$/.exec(sequence);
      // A press of the left button, no modifier. Wheels and releases name nothing.
      if (mouse && mouse[1] === "0") keys.push(`Mouse:${mouse[2] - 1}:${mouse[3] - 1}`);
      else if (SEQUENCES.has(sequence)) keys.push(SEQUENCES.get(sequence));
      at += sequence.length;
      continue;
    }
    const grapheme = graphemes(rest.slice(0, 32))[0];
    at += grapheme.length;
    if (grapheme === "\r" || grapheme === "\n" || grapheme === "\r\n") keys.push("Enter");
    else if (grapheme === "\t") keys.push("Tab");
    else if (grapheme === "\x7f" || grapheme === "\b") keys.push("Backspace");
    else if (grapheme === "\x03") keys.push("Ctrl-C");
    else if (graphemeWidth(grapheme) > 0) keys.push(grapheme);
  }
  return { keys, rest: "" };
}

const isText = (key) => graphemes(key).length === 1;

// ---- The surface ---------------------------------------------------------

// Every node with a listener, in the tree's order, and not disabled.
function focusable(node, out = []) {
  if (node.listeners.size > 0 && !flag(node, "disabled")) out.push(node);
  for (const child of node.children) focusable(child, out);
  return out;
}

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[2J";
const LEAVE_SCREEN = "\x1b[?1006l\x1b[?1000l\x1b[?7h\x1b[?25h\x1b[0m\x1b[?1049l";

// How long a lone Esc waits for the rest of a sequence the read cut in two.
const ESCAPE_MS = 30;

// The process's standard streams. In a worker, which is where `--time-limit`
// runs the program, `process.stdin` is not the real one, so they are opened by
// descriptor, as the host's own guest input does (host/input.ts).
function openStreams() {
  if (isMainThread) return { input: process.stdin, output: process.stdout, owned: false };
  let input;
  if (isatty(0)) input = new ReadStream(0);
  else {
    const stat = fstatSync(0);
    input = stat.isFIFO() || stat.isSocket() ? new Socket({ fd: 0, readable: true, writable: false }) : createReadStream(null, { fd: 0, autoClose: false });
  }
  const output = isatty(1)
    ? new WriteStream(1)
    : {
        isTTY: false,
        on() {},
        off() {},
        write(text) {
          let bytes = Buffer.from(text);
          while (bytes.length) {
            try {
              bytes = bytes.subarray(writeSync(1, bytes));
            } catch (error) {
              if (error.code !== "EAGAIN") throw error;
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
            }
          }
        },
      };
  return { input, output, owned: true };
}

// While the alternate screen is up, what the program writes to stderr would
// scribble on it and then vanish with it, a panic's message above all. So fd 2
// becomes an unlinked file for that time: POSIX gives an open the lowest free
// descriptor, which is how a Node program can do dup2. `drain` puts the terminal
// back on fd 2 and returns what was written. Null if this cannot be done safely;
// stderr then stays as it was. A worker closing a descriptor it did not open makes
// Node warn, on the screen, so that one warning is held back. A worker's report
// reaches fd 2 through the main thread, so it lands in the file or, if it comes
// after `drain`, on the restored terminal: either way it is seen.
function closeQuietly(fd) {
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (!String(warning?.message ?? warning).includes("unmanaged mode")) emit.call(process, warning, ...rest);
  };
  try {
    closeSync(fd);
  } finally {
    setImmediate(() => {
      process.emitWarning = emit;
    });
  }
}

export function captureStderr() {
  if (process.platform === "win32" || !isatty(2)) return null;
  const path = join(tmpdir(), `hd-ui-tui-${process.pid}-${Date.now()}`);
  try {
    closeSync(openSync("/dev/tty", "w"));
    closeQuietly(2);
    const fd = openSync(path, "wx+", 0o600);
    unlinkSync(path);
    if (fd !== 2) {
      closeSync(fd);
      openSync("/dev/tty", "w");
      return null;
    }
  } catch {
    return null;
  }
  return {
    drain() {
      const bytes = Buffer.alloc(fstatSync(2).size);
      if (bytes.length) readSync(2, bytes, 0, bytes.length, 0);
      closeQuietly(2);
      openSync("/dev/tty", "w");
      return bytes.toString("utf8");
    },
  };
}

// A process that outlives this one: if its pipe from us closes while it still
// runs, we died without cleaning up (a killed worker, SIGKILL, a crash), and it
// puts the terminal back. A clean exit kills it first. It is in its own session
// so a terminal signal cannot reach it, and it writes to the fd it inherits.
export function startGuard() {
  try {
    const saved = execFileSync("stty", ["-g"], { stdio: [0, "pipe", "ignore"], encoding: "utf8" }).trim();
    const script = `IFS= read -r line
printf '%s' "$2"
stty "$1" <&1 2>/dev/null
printf 'ui-tui: the program was killed; its last message may be lost\\n'`;
    const guard = spawn("/bin/sh", ["-c", script, "ui-tui-guard", saved, LEAVE_SCREEN], {
      detached: true,
      stdio: ["pipe", 1, "ignore"],
    });
    guard.on("error", () => {});
    guard.stdin.on("error", () => {});
    guard.unref();
    guard.stdin.unref?.();
    return guard;
  } catch {
    return null;
  }
}

// Reads a terminal on a thread of its own, so Ctrl-C is seen while the main
// thread is stuck in Wasm, where a raw terminal sends no signal and nothing else
// would ever read the byte. If a second passes with no sign of the main thread,
// the process is killed and the guard puts the terminal back.
const KEY_READER = `
const { parentPort, workerData } = require("node:worker_threads");
const { ReadStream } = require("node:tty");
const alive = new Int32Array(workerData.alive);
const input = new ReadStream(0);
input.setEncoding("utf8");
input.on("data", (text) => {
  if (text.includes("\\x03")) {
    const seen = Atomics.load(alive, 0);
    setTimeout(() => {
      if (Atomics.load(alive, 0) === seen) process.kill(process.pid, "SIGKILL");
    }, workerData.waitMs).unref();
  }
  parentPort.postMessage(text);
});
input.on("end", () => parentPort.postMessage(null));
`;

function startKeyReader(data, end) {
  const alive = new Int32Array(new SharedArrayBuffer(4));
  const reader = new Worker(KEY_READER, { eval: true, workerData: { alive: alive.buffer, waitMs: 1000 } });
  reader.on("message", (text) => {
    Atomics.add(alive, 0, 1);
    if (text === null) end();
    else data(text);
  });
  return reader;
}

// The process's own terminal, or pipes. It starts on the first `apply`, and
// the `exit` hook puts the terminal back however the program ends.
export function processTerminal(env = process.env) {
  let streams = null;
  const opened = () => (streams ??= openStreams());
  let open = false;
  let stderr = null;
  let sizeTimer = null;
  let guard = null;
  let reader = null;
  const close = () => {
    if (!open) return;
    open = false;
    clearInterval(sizeTimer);
    const { input, output } = opened();
    if (input.isTTY) input.setRawMode(false);
    if (output.isTTY) output.write(LEAVE_SCREEN);
    guard?.kill("SIGKILL");
    const captured = stderr?.drain();
    if (captured) output.write(captured);
  };
  return {
    get screen() {
      return Boolean(opened().output.isTTY);
    },
    get depth() {
      return this.screen ? opened().output.getColorDepth() : 1;
    },
    // A pty that reports no size says 0 columns.
    size() {
      const { output } = opened();
      const [cols, rows] = output.getWindowSize?.() ?? [0, 0];
      return { cols: cols || Number(env.COLUMNS) || 80, rows: rows || Number(env.LINES) || 24 };
    },
    write: (text) => opened().output.write(text),
    start({ data, end, resize }) {
      const { input, output, owned } = opened();
      open = true;
      process.on("exit", close);
      if (output.isTTY) guard = startGuard();
      if (input.isTTY) input.setRawMode(true);
      if (input.isTTY && !owned) {
        reader = startKeyReader(data, end);
      } else {
        input.setEncoding("utf8");
        input.on("data", data);
        input.on("end", end);
      }
      if (output.isTTY) {
        stderr = captureStderr();
        output.write(ENTER_SCREEN);
      }
      if (owned && output.isTTY) {
        // A worker hears no SIGWINCH, so it looks.
        let last = this.size();
        sizeTimer = setInterval(() => {
          const next = this.size();
          if (next.cols !== last.cols || next.rows !== last.rows) {
            last = next;
            resize();
          }
        }, 250);
        sizeTimer.unref();
      } else {
        output.on("resize", resize);
      }
    },
    stop() {
      close();
      process.off("exit", close);
      const { input, owned } = opened();
      reader?.terminate();
      input.pause();
      if (owned) input.destroy();
      else input.unref?.();
    },
  };
}

// The `Surface` over `terminal`: { screen, depth, size(), write(text),
// start({ data, end, resize }), stop() }. `stop` is called at most once.
export function createTuiSurface(terminal) {
  const tree = createTree();
  const events = [];
  const keys = [];
  let waiting = null;
  let started = false;
  let stopped = false;
  let released = false;
  let focus = null;
  let focusIndex = 0;
  let scroll = 0;
  let shown = [];
  let pendingBytes = "";
  let escapeTimer = null;
  let page = null;

  const placeFocus = () => {
    const list = focusable(tree.root);
    if (focus && tree.nodes.get(focus.id) === focus && list.includes(focus)) {
      focusIndex = list.indexOf(focus);
      return list;
    }
    // The focused node went away: its successor takes over, by position.
    focusIndex = Math.min(focusIndex, Math.max(0, list.length - 1));
    focus = list[focusIndex] ?? null;
    return list;
  };

  const render = (full = false) => {
    if (stopped) return;
    placeFocus();
    const { cols, rows } = terminal.size();
    const laid = layout(tree.root, cols, rows);
    page = laid;
    // A page taller than the screen follows the focus.
    if (focus) {
      const at = boxOf(laid, focus);
      if (at) {
        if (at.y + at.h > scroll + rows) scroll = at.y + at.h - rows;
        if (at.y < scroll) scroll = at.y;
      }
    }
    scroll = Math.max(0, Math.min(scroll, Math.max(0, pageHeight(laid) - rows)));
    const grid = paint(laid, cols, rows, focus, scroll);
    if (terminal.screen) {
      const next = grid.cells.map((row) => ansiRow(row, terminal.depth));
      let out = full ? "\x1b[2J" : "";
      next.forEach((line, y) => {
        // Every row is a full width of cells, so nothing to its right needs
        // erasing, and an erase would take the last column with it.
        if (full || line !== shown[y]) out += `\x1b[${y + 1};1H${line}`;
      });
      shown = next;
      if (out !== "") terminal.write(out);
    } else {
      const next = plainRows(grid);
      while (next.length && next[next.length - 1] === "") next.pop();
      const frame = next.join("\n");
      if (frame !== shown) {
        shown = frame;
        terminal.write(`${frame}\n-- end of frame\n`);
      }
    }
  };

  const release = () => {
    clearTimeout(escapeTimer);
    if (started && !released) terminal.stop();
    released = true;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    release();
    events.push({ handler: 0, payload: "" });
  };

  // Reports `event` on `node` and its ancestors, as the DOM's events bubble.
  const fire = (node, event, payload) => {
    for (let at = node; at; at = at.parent) {
      for (const handler of at.listeners.get(event) ?? []) events.push({ handler, payload });
    }
  };

  const moveFocus = (step) => {
    const list = placeFocus();
    if (list.length === 0) return;
    focusIndex = (focusIndex + step + list.length) % list.length;
    focus = list[focusIndex];
  };

  const edit = (node, parts, cursor) => {
    const next = parts.join("");
    node.props.set("value", { tag: "Text", fields: { value: next } });
    node.cursor = cursor;
    fire(node, "input", next);
  };

  // One key in a focused field. The cursor is a grapheme index.
  const pressInField = (node, key) => {
    const value = word(node, "value") ?? "";
    const parts = graphemes(value);
    const at = Math.min(node.cursor ?? parts.length, parts.length);
    if (key === "Enter") fire(node, "enter", value);
    else if (key === "ArrowLeft") node.cursor = Math.max(0, at - 1);
    else if (key === "ArrowRight") node.cursor = Math.min(parts.length, at + 1);
    else if (key === "Home") node.cursor = 0;
    else if (key === "End") node.cursor = parts.length;
    else if (key === "Backspace") {
      if (at > 0) edit(node, parts.toSpliced(at - 1, 1), at - 1);
    } else if (key === "Delete") {
      if (at < parts.length) edit(node, parts.toSpliced(at, 1), at);
    } else if (isText(key)) edit(node, parts.toSpliced(at, 0, key), at + 1);
  };

  // A click, or Space: a checkbox also toggles.
  const activate = (node) => {
    fire(node, "click", "");
    if (node.kind === "checkbox") {
      const next = !flag(node, "checked");
      node.props.set("checked", { tag: "Flag", fields: { value: next } });
      fire(node, "change", String(next));
    }
  };

  // A press of the left button: the nearest focusable node under it takes the
  // focus and is clicked; a field only takes the focus.
  const pressMouse = (key) => {
    const [, column, line] = key.split(":").map(Number);
    if (!page) return;
    const list = placeFocus();
    const hit = boxAt(page, column, line + scroll);
    let node = hit?.node;
    while (node && !list.includes(node)) node = node.parent;
    if (!node) return;
    focus = node;
    if (node.kind !== "input") activate(node);
  };

  // One key, against the tree as hd last left it.
  const press = (key) => {
    if (key === "Ctrl-C") {
      stop();
      return;
    }
    if (key === "Tab" || key === "Shift-Tab") {
      moveFocus(key === "Tab" ? 1 : -1);
      render();
      return;
    }
    if (key.startsWith("Mouse:")) {
      pressMouse(key);
      render();
      return;
    }
    placeFocus();
    const node = focus;
    const inField = node?.kind === "input";
    if (key === "q" && !inField) {
      stop();
      return;
    }
    if (!node) return;
    fire(node, "key", key);
    if (inField) pressInField(node, key);
    else if (key === " ") activate(node);
    else if (key === "Enter") fire(node, "click", "");
    render();
  };

  // Keys wait here until hd asks for an event, so each is read against the
  // tree the previous one's event left: a keystroke cannot race the echo of
  // an earlier one, and a key cannot act on a row a click just removed.
  const pump = () => {
    while (events.length === 0 && keys.length > 0 && !stopped) press(keys.shift());
  };

  const deliver = () => {
    if (!waiting) return;
    pump();
    if (events.length === 0) return;
    const resolve = waiting;
    waiting = null;
    resolve(events.shift());
  };

  const read = (bytes) => {
    clearTimeout(escapeTimer);
    const parsed = parseKeys(pendingBytes + bytes);
    pendingBytes = parsed.rest;
    keys.push(...parsed.keys);
    // Ctrl-C does not wait its turn: the terminal comes back at once, even
    // if hd never asks for another event.
    if (parsed.keys.includes("Ctrl-C")) stop();
    if (pendingBytes !== "") {
      // Esc pressed by itself: nothing follows, so it names no key we keep.
      escapeTimer = setTimeout(() => {
        pendingBytes = "";
      }, ESCAPE_MS);
      escapeTimer.unref?.();
    }
    deliver();
  };

  // The host aborts `instanceSignal` when the program ends, whatever ended
  // it. Without this a panic would leave stdin holding the process open and
  // the terminal raw, with nobody left to read a key.
  const start = (context) => {
    if (started || stopped) return;
    started = true;
    context?.instanceSignal?.addEventListener("abort", () => {
      stopped = true;
      release();
    });
    terminal.start({
      data: read,
      end: () => {
        stop();
        deliver();
      },
      resize: () => {
        shown = [];
        render(true);
      },
    });
  };

  return {
    tree,
    focused: () => focus,
    // The rendering a test looks at, without a screen.
    frame() {
      placeFocus();
      const { cols, rows } = terminal.size();
      return paint(layout(tree.root, cols, rows), cols, rows, focus, scroll);
    },
    apply(commands, context) {
      start(context);
      for (const command of commands) tree.apply(command);
      render();
    },
    next_event(context) {
      start(context);
      pump();
      if (events.length) return events.shift();
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
  };
}

export default createTuiSurface(processTerminal());
