// Checks providers/tui.mjs without a terminal: layout and painting of the
// counter's real mount commands (fixtures/counter-mount.json, what
// `hd run counter-tui` sends), the flexbox subset, keys and focus, and what
// is written to a screen. Run with `node --test ui-tui/providers/tui.test.mjs`.
//
// The last case runs the real program over pipes and compares its first frame
// with the fixture's, so a change in the example shows up here as a stale
// fixture rather than as a test of something else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  ansiRow,
  createTree,
  createTuiSurface,
  layout,
  paint,
  parseKeys,
  plainRows,
  textWidth,
  wrapText,
} from "./tui.mjs";

const counterMount = JSON.parse(readFileSync(new URL("./fixtures/counter-mount.json", import.meta.url), "utf8"));

const command = (tag, fields) => ({ tag, fields });
const create = (node, kind) => command("Create", { node, kind });
const append = (parent, child) => command("Append", { parent, child });
const setText = (node, text) => command("SetText", { node, text });
// A button's label: a text node it holds.
const labelled = (button, text) => {
  const child = button + 1000;
  return [create(child, "text"), append(button, child), setText(child, text)];
};
const set = (node, key, value) => command("SetProp", { node, key, value });
const listen = (node, event, handler) => command("Listen", { node, event, handler });
const num = (value) => ({ tag: "Number", fields: { value } });
const word = (value) => ({ tag: "Text", fields: { value } });
const flag = (value) => ({ tag: "Flag", fields: { value } });
const paintOf = (r, g, b, a = 255) => ({ tag: "Paint", fields: { color: { r, g, b, a } } });
const extent = (tag, value) => ({ tag: "Extent", fields: { size: { tag, fields: value === undefined ? {} : { value } } } });
const unset = { tag: "Unset", fields: {} };

function treeOf(commands) {
  const tree = createTree();
  for (const c of commands) tree.apply(c);
  return tree;
}

// The screen `commands` paint, as rows of text.
function rowsOf(commands, cols = 40, rows = 10) {
  const tree = treeOf(commands);
  return plainRows(paint(layout(tree.root, cols, rows), cols, rows));
}

// Finds a node's box and its place on the screen.
function findBox(box, id, ox = 0, oy = 0) {
  const x = ox + box.x;
  const y = oy + box.y;
  if (box.node.id === id) return { x, y, w: box.w, h: box.h };
  for (const kid of box.kids) {
    const found = findBox(kid, id, x, y);
    if (found) return found;
  }
  return null;
}

function boxesOf(commands, cols = 40, rows = 10) {
  const tree = treeOf(commands);
  const laid = layout(tree.root, cols, rows);
  return (id) => findBox(laid, id);
}

// A terminal that records, and whose keys a test types.
function fakeTerminal({ screen = false, depth = 24, cols = 40, rows = 20 } = {}) {
  const terminal = {
    screen,
    depth,
    cols,
    rows,
    written: [],
    stops: 0,
    callbacks: null,
    size: () => ({ cols: terminal.cols, rows: terminal.rows }),
    write: (text) => terminal.written.push(text),
    start: (callbacks) => {
      terminal.callbacks = callbacks;
    },
    stop: () => {
      terminal.stops += 1;
    },
    type: (bytes) => terminal.callbacks.data(bytes),
  };
  return terminal;
}

// A surface already showing `commands`, and how to read what it reports.
function surfaceOf(commands, options) {
  const terminal = fakeTerminal(options);
  const surface = createTuiSurface(terminal);
  surface.apply(commands);
  return { terminal, surface };
}

// Everything the surface reports for `bytes`, asking as hd's loop does: one
// `next_event` at a time, the last of them left waiting for the next key.
const waitingEvent = new WeakMap();
const NOTHING = Symbol("nothing");
async function eventsAfter(surface, terminal, bytes) {
  terminal.type(bytes);
  const out = [];
  let next = waitingEvent.get(surface) ?? surface.next_event();
  for (;;) {
    const event = await Promise.race([next, new Promise((resolve) => setImmediate(resolve, NOTHING))]);
    if (event === NOTHING) {
      waitingEvent.set(surface, next);
      return out;
    }
    out.push(event);
    next = surface.next_event();
  }
}

// ---- The counter ---------------------------------------------------------

test("the counter's command stream lays out and paints", () => {
  assert.deepEqual(rowsOf(counterMount, 40, 16), [
    "",
    "  ╭──────────────────────────────────╮",
    "  │                                  │",
    "  │  Count: 0                        │",
    "  │                                  │",
    "  │  ╭─────╮ ╭─────╮                 │",
    "  │  │  -  │ │  +  │                 │",
    "  │  ╰─────╯ ╰─────╯                 │",
    "  │                                  │",
    "  ╰──────────────────────────────────╯",
    "",
    "  ╭──────────────────────────────────╮",
    "  │         toggle dark mode         │",
    "  ╰──────────────────────────────────╯",
    "",
    "",
  ]);
});

test("the counter's colors come from Paint and its focus is reverse video", () => {
  const { surface } = surfaceOf(counterMount, { rows: 16 });
  const grid = surface.frame();
  const label = grid.at(5, 3);
  assert.equal(label.ch, "C");
  assert.ok(label.bg, "the surface's background is under the text");
  assert.deepEqual(label.fg, { r: 29, g: 35, b: 43 }, "on_surface");
  assert.equal(grid.at(8, 6).ch, "-");
  assert.equal(grid.at(8, 6).reverse, true, "the first button has the focus");
  assert.equal(grid.at(16, 6).reverse, false, "the second does not");
  assert.equal(grid.at(5, 5).reverse, false, "the border is not part of the focus");
});

test("Tab and Enter click the counter's buttons, in order", async () => {
  const { surface, terminal } = surfaceOf(counterMount);
  const handlers = counterMount.filter((c) => c.tag === "Listen").map((c) => c.fields.handler);
  assert.deepEqual(handlers, [1, 2, 3], "minus, plus, toggle");
  assert.deepEqual(await eventsAfter(surface, terminal, "\r"), [{ handler: 1, payload: "" }]);
  assert.deepEqual(await eventsAfter(surface, terminal, "\t "), [{ handler: 2, payload: "" }]);
  assert.deepEqual(await eventsAfter(surface, terminal, "\t\r"), [{ handler: 3, payload: "" }]);
  assert.deepEqual(await eventsAfter(surface, terminal, "\t\r"), [{ handler: 1, payload: "" }], "Tab wraps");
  assert.deepEqual(await eventsAfter(surface, terminal, "\x1b[Z\r"), [{ handler: 3, payload: "" }], "Shift-Tab goes back");
  surface.apply([setText(3, "Count: 41")]);
  assert.ok(plainRows(surface.frame())[3].includes("Count: 41"), "SetText repaints");
});

// ---- The flexbox subset --------------------------------------------------

const column = (node, parent = 0) => [create(node, "box"), append(parent, node)];
const rowBox = (node, parent = 0) => [create(node, "box"), set(node, "direction", word("row")), append(parent, node)];
const label = (node, parent, text) => [create(node, "text"), append(parent, node), setText(node, text)];

test("a box is a column by default and direction makes a row", () => {
  assert.deepEqual(rowsOf([...column(1), ...label(2, 1, "a"), ...label(3, 1, "b")]).slice(0, 2), ["a", "b"]);
  assert.deepEqual(rowsOf([...rowBox(1), ...label(2, 1, "a"), ...label(3, 1, "b")]).slice(0, 2), ["ab", ""]);
});

test("gap and padding scale from pixels to cells: 8 wide, 16 high", () => {
  const box = boxesOf([
    ...rowBox(1),
    set(1, "gap", num(16)),
    set(1, "padding_left", num(24)),
    set(1, "padding_top", num(32)),
    ...label(2, 1, "aa"),
    ...label(3, 1, "bb"),
  ]);
  assert.deepEqual(box(2), { x: 3, y: 2, w: 2, h: 1 });
  assert.deepEqual(box(3), { x: 7, y: 2, w: 2, h: 1 }, "gap 16 is two columns");
  const tall = boxesOf([...column(1), set(1, "gap", num(16)), ...label(2, 1, "a"), ...label(3, 1, "b")]);
  assert.equal(tall(3).y, 2, "gap 16 is one row");
});

test("width and height: Px, Pct, Auto and Fill", () => {
  const box = boxesOf([
    ...rowBox(1),
    set(1, "height", extent("Px", 80)),
    ...label(2, 1, "x"),
    set(2, "width", extent("Px", 80)),
    ...label(3, 1, "y"),
    set(3, "width", extent("Pct", 25)),
    ...label(4, 1, "z"),
    set(4, "width", extent("Auto")),
    ...label(5, 1, "w"),
    set(5, "width", extent("Fill")),
  ]);
  assert.equal(box(1).h, 5, "80px is five rows");
  assert.equal(box(1).w, 40, "a column's child stretches");
  assert.equal(box(2).w, 10, "80px is ten columns");
  assert.equal(box(3).w, 10, "25% of 40");
  assert.equal(box(4).w, 1, "Auto is its content");
  assert.equal(box(5).w, 19, "Fill takes what is left");
  assert.equal(box(5).x, 21);
  const across = boxesOf([...column(1), set(1, "align", word("start")), ...label(2, 1, "x"), set(2, "width", extent("Fill"))]);
  assert.equal(across(2).w, 40, "Fill across the main axis stretches");
  const down = boxesOf([...column(1), set(1, "height", extent("Fill")), ...label(2, 1, "x")], 40, 10);
  assert.equal(down(1).h, 10, "Fill along a column takes the screen");
  const clamped = boxesOf([...rowBox(1), ...label(2, 1, "x"), set(2, "width", extent("Fill")), set(2, "max_width", extent("Px", 40))]);
  assert.equal(clamped(2).w, 5, "max_width bounds Fill");
});

test("grow shares the free cells by weight, in whole cells", () => {
  const box = boxesOf([
    ...rowBox(1),
    ...label(2, 1, "a"),
    set(2, "grow", num(1)),
    ...label(3, 1, "b"),
    set(3, "grow", num(2)),
    ...label(4, 1, "c"),
  ]);
  assert.equal(box(2).w + box(3).w + box(4).w, 40);
  assert.equal(box(2).w, 1 + 12);
  assert.equal(box(3).w, 1 + 25);
  assert.equal(box(4).w, 1);
});

test("justify and align: start, center, end, between", () => {
  const placed = (key, value, kid = 2) => {
    const box = boxesOf([
      ...rowBox(1),
      set(1, "height", extent("Px", 64)),
      set(1, key, word(value)),
      ...label(2, 1, "aaaa"),
      ...label(3, 1, "bb"),
    ]);
    return box(kid);
  };
  assert.equal(placed("justify", "start").x, 0);
  assert.equal(placed("justify", "center").x, 17);
  assert.equal(placed("justify", "end").x, 34);
  assert.equal(placed("justify", "end", 3).x, 38);
  assert.equal(placed("justify", "between", 3).x, 38);
  assert.equal(placed("align", "start").y, 0);
  assert.equal(placed("align", "start").h, 1);
  assert.equal(placed("align", "center").y, 1);
  assert.equal(placed("align", "end").y, 3);
  assert.equal(placed("align", "stretch").h, 4);
});

test("text wraps at its box, and a row shrinks before it overflows", () => {
  assert.deepEqual(wrapText("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrapText("abcdefgh", 3), ["abc", "def", "gh"]);
  assert.deepEqual(wrapText("a\nb"), ["a", "b"]);
  assert.deepEqual(rowsOf([...column(1), ...label(2, 1, "one two three")], 7, 3), ["one two", "three", ""]);
  const box = boxesOf(
    [...rowBox(1), ...label(2, 1, "one two three"), create(3, "button"), append(1, 3), ...labelled(3, "go")],
    10,
    4,
  );
  assert.equal(box(3).w, 4, "a button keeps its label: [go]");
  assert.equal(box(2).w, 6, "the text gives way");
  assert.equal(box(2).h, 3, "and wraps");
  assert.equal(box(1).h, 3, "the row is as tall as it needs");
});

test("wide characters take two cells and never split", () => {
  assert.equal(textWidth("中文a"), 5);
  assert.equal(textWidth("é"), 1, "a combining mark takes none");
  assert.deepEqual(rowsOf([...rowBox(1), ...label(2, 1, "中文")], 3, 1), ["中"], "the second would cross the edge");
});

test("a fragment takes no layout of its own, and gaps ignore it", () => {
  const box = boxesOf([
    ...rowBox(1),
    set(1, "gap", num(8)),
    ...label(2, 1, "a"),
    create(3, "fragment"),
    append(1, 3),
    ...label(4, 3, "b"),
    create(5, "fragment"),
    append(3, 5),
    ...label(6, 5, "c"),
    create(7, "fragment"),
    append(1, 7),
    ...label(8, 1, "d"),
  ]);
  assert.equal(box(3), null, "no box");
  assert.deepEqual([box(2).x, box(4).x, box(6).x, box(8).x], [0, 2, 4, 6], "an empty fragment makes no gap");
});

test("an unknown kind is a box, unknown and dom: keys change nothing", () => {
  const plain = rowsOf([...column(1), ...label(2, 1, "a")]);
  const noisy = rowsOf([
    create(1, "canvas"),
    append(0, 1),
    set(1, "shadow", num(3)),
    set(1, "dom:class", word("card")),
    set(1, "dom:attr:gap", word("9")),
    set(1, "dom:gap", num(160)),
    ...label(2, 1, "a"),
  ]);
  assert.deepEqual(noisy, plain);
  const tree = treeOf([create(1, "canvas"), set(1, "dom:class", word("card"))]);
  assert.equal(tree.nodes.get(1).kind, "box");
  assert.equal(tree.nodes.get(1).props.size, 0, "a prefixed key is not kept");
});

test("Unset removes a property", () => {
  const before = [...rowBox(1), set(1, "gap", num(16)), ...label(2, 1, "a"), ...label(3, 1, "b")];
  assert.equal(rowsOf(before)[0], "a  b");
  assert.equal(rowsOf([...before, set(1, "gap", unset)])[0], "ab");
});

// ---- The tree ------------------------------------------------------------

test("MoveBefore reorders, Remove and Clear forget their subtrees", () => {
  const tree = treeOf([...column(1), ...label(2, 1, "a"), ...label(3, 1, "b"), command("MoveBefore", { parent: 1, child: 3, before: 2 })]);
  assert.deepEqual(tree.nodes.get(1).children.map((n) => n.id), [3, 2]);
  tree.apply(command("MoveBefore", { parent: 1, child: 3, before: null }));
  assert.deepEqual(tree.nodes.get(1).children.map((n) => n.id), [2, 3]);
  const size = tree.nodes.size;
  for (let i = 0; i < 100; i += 1) {
    const base = 100 + i * 10;
    tree.apply(create(base, "fragment"));
    tree.apply(append(1, base));
    tree.apply(create(base + 1, "text"));
    tree.apply(append(base, base + 1));
    if (i % 2) tree.apply(command("Remove", { node: base }));
    else {
      tree.apply(command("Clear", { node: base }));
      tree.apply(command("Remove", { node: base }));
    }
  }
  assert.equal(tree.nodes.size, size, "toggled 100 times, the map is at its mount size");
  assert.throws(() => tree.apply(setText(999, "x")), /unknown node 999/);
});

// ---- Text painting -------------------------------------------------------

test("font_weight 600 is bold, inherited, as color is; a transparent paint is nothing", () => {
  const tree = treeOf([
    ...column(1),
    set(1, "font_weight", num(600)),
    set(1, "color", paintOf(190, 40, 40)),
    ...label(2, 1, "a"),
    ...label(3, 1, "b"),
    set(3, "font_weight", num(400)),
    set(3, "color", paintOf(0, 0, 255)),
    set(3, "background", paintOf(0, 0, 0, 0)),
  ]);
  const grid = paint(layout(tree.root, 4, 2), 4, 2);
  assert.equal(grid.at(0, 0).bold, true);
  assert.deepEqual(grid.at(0, 0).fg, { r: 190, g: 40, b: 40 });
  assert.equal(grid.at(0, 1).bold, false, "the nearest weight wins");
  assert.deepEqual(grid.at(0, 1).fg, { r: 0, g: 0, b: 255 });
  assert.equal(grid.at(0, 1).bg, null);
});

test("alpha blends over what is underneath, and text with no color contrasts", () => {
  const tree = treeOf([
    ...column(1),
    set(1, "background", paintOf(255, 255, 255)),
    ...column(2, 1),
    set(2, "background", paintOf(0, 0, 0, 128)),
    ...label(3, 2, "a"),
    ...label(4, 1, "b"),
  ]);
  const grid = paint(layout(tree.root, 2, 2), 2, 2);
  assert.deepEqual(grid.at(0, 0).bg, { r: 127, g: 127, b: 127 });
  assert.deepEqual(grid.at(0, 1).fg, { r: 0, g: 0, b: 0 }, "black on white, whatever the terminal's default");
  const dark = treeOf([...column(1), set(1, "background", paintOf(10, 10, 10)), ...label(2, 1, "a")]);
  assert.deepEqual(paint(layout(dark.root, 1, 1), 1, 1).at(0, 0).fg, { r: 255, g: 255, b: 255 });
  const bare = treeOf([...column(1), ...label(2, 1, "a")]);
  assert.equal(paint(layout(bare.root, 1, 1), 1, 1).at(0, 0).fg, null, "no background leaves the terminal's own");
});

test("opacity under 1 dims the subtree", () => {
  const tree = treeOf([...column(1), set(1, "opacity", num(0.5)), ...label(2, 1, "a")]);
  assert.equal(paint(layout(tree.root, 1, 1), 1, 1).at(0, 0).dim, true);
});

test("borders: one cell whatever the width, rounded with a radius, in border_color", () => {
  const box = [...column(1), set(1, "border_width", num(3)), set(1, "border_color", paintOf(1, 2, 3)), ...label(2, 1, "a")];
  assert.deepEqual(rowsOf(box, 3, 3), ["┌─┐", "│a│", "└─┘"]);
  assert.deepEqual(rowsOf([...box, set(1, "radius", num(4))], 3, 3), ["╭─╮", "│a│", "╰─╯"]);
  const tree = treeOf(box);
  assert.deepEqual(paint(layout(tree.root, 3, 3), 3, 3).at(0, 0).fg, { r: 1, g: 2, b: 3 });
});

test("the controls: a bare button is bracketed, a checkbox ticks, a field shows its tail", () => {
  assert.equal(rowsOf([...rowBox(1), create(2, "button"), append(1, 2), ...labelled(2, "ok")])[0], "[ok]");
  assert.equal(
    rowsOf([...rowBox(1), create(2, "checkbox"), append(1, 2), set(2, "checked", flag(true)), create(3, "checkbox"), append(1, 3)])[0],
    "[x][ ]",
  );
  const field = rowsOf([...column(1), create(2, "input"), append(1, 2), set(2, "width", extent("Px", 48)), set(2, "value", word("abcdefghij"))]);
  assert.equal(field[0], "fghij", "room for the cursor after it");
});

test("overflow hidden clips to the box", () => {
  const box = [...column(1), set(1, "width", extent("Px", 16)), set(1, "align", word("start")), ...label(2, 1, "abcd"), set(2, "width", extent("Px", 32))];
  assert.equal(rowsOf(box)[0], "abcd");
  assert.equal(rowsOf([...box, set(1, "overflow", word("hidden"))])[0], "ab");
});

test("ansiRow writes color for the terminal's depth, and control characters never", () => {
  const tree = treeOf([...column(1), set(1, "color", paintOf(190, 40, 40)), set(1, "font_weight", num(700)), ...label(2, 1, "a\x1b[2Jb")]);
  const grid = paint(layout(tree.root, 3, 1), 3, 1);
  const row = grid.cells[0];
  assert.equal(ansiRow(row, 24), "\x1b[0;1;38;2;190;40;40ma[2\x1b[0m", "the ESC itself is dropped");
  assert.equal(ansiRow(row, 8), "\x1b[0;1;38;5;160ma[2\x1b[0m");
  assert.equal(ansiRow(row, 1), "\x1b[0;1ma[2\x1b[0m");
  assert.equal(ansiRow(new Array(2).fill({ ch: " " }), 24), "  ", "no attributes, no codes");
});

// ---- Keys ----------------------------------------------------------------

test("parseKeys names keys and drops what it does not know", () => {
  assert.deepEqual(parseKeys("a\r\t\x7f\x03").keys, ["a", "Enter", "Tab", "Backspace", "Ctrl-C"]);
  assert.deepEqual(parseKeys("\x1b[A\x1b[Z\x1bOB").keys, ["ArrowUp", "Shift-Tab", "ArrowDown"]);
  assert.deepEqual(parseKeys("\x1b[15~x\x1bfy\x01").keys, ["x", "y"], "F5, Alt-f and Ctrl-A are dropped whole");
  assert.deepEqual(parseKeys("中é"), { keys: ["中", "é"], rest: "" });
  assert.deepEqual(parseKeys("a\x1b["), { keys: ["a"], rest: "\x1b[" }, "a sequence cut in two waits");
  assert.deepEqual(parseKeys("\x1b"), { keys: [], rest: "\x1b" });
});

const form = [
  ...column(1),
  create(2, "input"),
  append(1, 2),
  listen(2, "input", 10),
  listen(2, "enter", 11),
  create(3, "checkbox"),
  append(1, 3),
  listen(3, "change", 12),
  create(4, "button"),
  append(1, 4),
  ...labelled(4, "go"),
  listen(4, "click", 13),
  create(5, "button"),
  append(1, 5),
  ...labelled(5, "off"),
  listen(5, "click", 14),
  set(5, "disabled", flag(true)),
  ...label(6, 1, "not listening"),
];

test("typing into a field fires input with its text, and Enter fires enter", async () => {
  const { surface, terminal } = surfaceOf(form);
  assert.deepEqual(await eventsAfter(surface, terminal, "hi"), [
    { handler: 10, payload: "h" },
    { handler: 10, payload: "hi" },
  ]);
  assert.deepEqual(await eventsAfter(surface, terminal, "\x7f"), [{ handler: 10, payload: "h" }]);
  assert.deepEqual(await eventsAfter(surface, terminal, "\r"), [{ handler: 11, payload: "h" }]);
  assert.deepEqual(await eventsAfter(surface, terminal, "q "), [
    { handler: 10, payload: "hq" },
    { handler: 10, payload: "hq " },
  ], "q and Space are text in a field");
  assert.equal(terminal.stops, 0);
  surface.apply([set(2, "value", word(""))]);
  assert.deepEqual(await eventsAfter(surface, terminal, "\x7f"), [], "Backspace in an empty field reports nothing");
  assert.deepEqual(await eventsAfter(surface, terminal, "\x1b[A\x1b[D\x01"), [], "unknown keys are dropped");
  assert.equal(plainRows(surface.frame())[0], "");
  assert.deepEqual(await eventsAfter(surface, terminal, "é"), [{ handler: 10, payload: "é" }]);
});

test("the field's text a key sees is the one hd last sent", async () => {
  const { surface, terminal } = surfaceOf(form);
  assert.deepEqual(await eventsAfter(surface, terminal, "a"), [{ handler: 10, payload: "a" }]);
  // hd handles the event and clears the field, while two more keys arrived.
  const next = surface.next_event();
  terminal.type("bc");
  assert.deepEqual(await next, { handler: 10, payload: "ab" }, "the first key is read at once");
  surface.apply([set(2, "value", word(""))]);
  assert.deepEqual(surface.next_event(), { handler: 10, payload: "c" }, "the second waits for that batch");
});

test("Space toggles a checkbox and fires change with its state", async () => {
  const { surface, terminal } = surfaceOf(form);
  assert.deepEqual(await eventsAfter(surface, terminal, "\t "), [{ handler: 12, payload: "true" }]);
  assert.equal(plainRows(surface.frame())[1], "[x]");
  assert.deepEqual(await eventsAfter(surface, terminal, " "), [{ handler: 12, payload: "false" }]);
  assert.deepEqual(await eventsAfter(surface, terminal, "\r"), [], "Enter does not, as in a browser");
});

test("Tab skips what is disabled or has no listener, and the focus follows disabled", async () => {
  const { surface, terminal } = surfaceOf(form);
  assert.equal(surface.focused().id, 2);
  terminal.type("\t");
  surface.next_event();
  assert.equal(surface.focused().id, 3);
  terminal.type("\t");
  surface.next_event();
  assert.equal(surface.focused().id, 4);
  surface.apply([set(5, "disabled", unset)]);
  terminal.type("\t");
  surface.next_event();
  assert.equal(surface.focused().id, 5, "enabled again");
  surface.apply([set(5, "disabled", flag(true))]);
  assert.equal(surface.focused().id, 4, "its place passes to what is now last");
});

test("a removed focus passes to whatever took its place", async () => {
  const { surface, terminal } = surfaceOf(form);
  terminal.type("\t\t");
  surface.next_event();
  surface.next_event();
  assert.equal(surface.focused().id, 4);
  surface.apply([command("Remove", { node: 4 }), create(7, "button"), append(1, 7), listen(7, "click", 15)]);
  assert.equal(surface.focused().id, 7);
  surface.apply([command("Remove", { node: 7 })]);
  assert.equal(surface.focused().id, 3, "the last one left");
  surface.apply([command("Clear", { node: 1 })]);
  assert.equal(surface.focused(), null);
});

test("events bubble, and a key listener gets the DOM's key names", async () => {
  const { surface, terminal } = surfaceOf([
    ...column(1),
    listen(1, "click", 20),
    create(2, "button"),
    append(1, 2),
    listen(2, "click", 21),
    listen(2, "key", 22),
  ]);
  assert.equal(surface.focused().id, 1, "a box with a listener takes the focus");
  assert.deepEqual(await eventsAfter(surface, terminal, "\t"), []);
  assert.deepEqual(await eventsAfter(surface, terminal, "\r"), [
    { handler: 22, payload: "Enter" },
    { handler: 21, payload: "" },
    { handler: 20, payload: "" },
  ]);
  assert.deepEqual(await eventsAfter(surface, terminal, "\x1b[A"), [{ handler: 22, payload: "ArrowUp" }]);
});

test("q and Ctrl-C end the loop with handler 0, and put the terminal back once", async () => {
  for (const key of ["q", "\x03"]) {
    const { surface, terminal } = surfaceOf(counterMount);
    const stop = surface.next_event();
    terminal.type(key);
    assert.deepEqual(await stop, { handler: 0, payload: "" });
    assert.equal(terminal.stops, 1, JSON.stringify(key));
    surface.apply([setText(3, "landed after the end")]);
    assert.equal(terminal.written.join("").includes("landed"), false, "a late batch paints nothing");
  }
});

test("Ctrl-C works in a field, and with no one waiting for an event", () => {
  const { surface, terminal } = surfaceOf(form);
  terminal.type("\x03");
  assert.equal(terminal.stops, 1, "at once");
  assert.deepEqual(surface.next_event(), { handler: 0, payload: "" });
});

test("the end of stdin ends the loop", async () => {
  const { surface, terminal } = surfaceOf(counterMount);
  const stop = surface.next_event();
  terminal.callbacks.end();
  assert.deepEqual(await stop, { handler: 0, payload: "" });
});

test("when the host closes the instance the terminal comes back and no paint follows", () => {
  const terminal = fakeTerminal({ screen: true });
  const surface = createTuiSurface(terminal);
  const lifetime = new AbortController();
  surface.apply(counterMount, { instanceSignal: lifetime.signal });
  assert.equal(terminal.stops, 0);
  lifetime.abort();
  assert.equal(terminal.stops, 1);
  const before = terminal.written.length;
  surface.apply([setText(3, "after")]);
  assert.equal(terminal.written.length, before);
});

test("a sequence cut in two reads as one key, and Esc alone is dropped", async () => {
  const { surface, terminal } = surfaceOf(counterMount);
  terminal.type("\x1b");
  terminal.type("[Z\r");
  assert.deepEqual(surface.next_event(), { handler: 3, payload: "" }, "Shift-Tab from the first button");
  terminal.type("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 60));
  terminal.type("\t\r");
  assert.deepEqual(surface.next_event(), { handler: 1, payload: "" }, "the Esc did not swallow the Tab");
});

test("a field edits at its cursor, which hd replacing the text puts back at the end", async () => {
  const { surface, terminal } = surfaceOf(form);
  const typed = async (bytes) => (await eventsAfter(surface, terminal, bytes)).map((event) => event.payload);
  assert.deepEqual(await typed("ac"), ["a", "ac"]);
  assert.deepEqual(await typed("\x1b[Db"), ["abc"], "ArrowLeft, then an insert");
  assert.deepEqual(await typed("\x7f"), ["ac"], "Backspace before the cursor");
  assert.deepEqual(await typed("\x1b[3~"), ["a"], "Delete under it");
  assert.deepEqual(await typed("\x1b[H"), [], "Home moves only");
  assert.deepEqual(await typed("z"), ["za"]);
  assert.deepEqual(await typed("\x1b[Fy"), ["zay"], "End");
  surface.apply([set(2, "value", word("new"))]);
  assert.deepEqual(await typed("!"), ["new!"]);
  assert.deepEqual(await typed("\x1b[H\x7f"), [], "Backspace at the start is nothing");
});

test("a long field keeps its cursor in view", async () => {
  const { surface, terminal } = surfaceOf([...column(1), create(2, "input"), append(1, 2), set(2, "width", extent("Px", 48)), listen(2, "input", 1), set(2, "value", word("abcdefghij"))]);
  assert.equal(plainRows(surface.frame())[0], "fghij");
  await eventsAfter(surface, terminal, "\x1b[H");
  assert.equal(plainRows(surface.frame())[0], "abcdef");
  const cursor = surface.frame().at(0, 0);
  assert.equal(cursor.reverse, true, "the cursor is on the first letter");
});

test("the mouse: a left press focuses and clicks; a field only takes the focus", async () => {
  const { surface, terminal } = surfaceOf(form);
  const press = (x, y) => `\x1b[<0;${x + 1};${y + 1}M`;
  assert.deepEqual(parseKeys(press(3, 4) + "\x1b[<0;4;5m\x1b[<64;4;5M\x1b[<2;4;5M").keys, ["Mouse:3:4"], "no release, wheel or right button");
  assert.deepEqual(await eventsAfter(surface, terminal, press(1, 2)), [{ handler: 13, payload: "" }], "the go button");
  assert.equal(surface.focused().id, 4);
  assert.deepEqual(await eventsAfter(surface, terminal, press(1, 1)), [{ handler: 12, payload: "true" }], "the checkbox toggles");
  assert.deepEqual(await eventsAfter(surface, terminal, press(1, 0)), [], "the field");
  assert.equal(surface.focused().id, 2);
  assert.deepEqual(await eventsAfter(surface, terminal, press(1, 3)), [], "disabled");
  assert.deepEqual(await eventsAfter(surface, terminal, press(1, 4)), [], "a label with no listener");
  assert.equal(surface.focused().id, 2, "the focus stays");
});

test("the mouse counts scroll", async () => {
  const items = [];
  for (let i = 0; i < 10; i += 1) items.push(create(10 + i, "button"), append(1, 10 + i), ...labelled(10 + i, `b${i}`), listen(10 + i, "click", 10 + i));
  const { surface, terminal } = surfaceOf([...column(1), ...items], { rows: 3, cols: 10 });
  await eventsAfter(surface, terminal, "\t".repeat(9));
  assert.deepEqual(await eventsAfter(surface, terminal, "\x1b[<0;1;1M"), [{ handler: 17, payload: "" }], "the top row shows b7");
});

test("a glyph over half of a wide one blanks the other half", () => {
  const tree = treeOf([
    ...column(1),
    set(1, "height", extent("Px", 16)),
    ...label(2, 1, "中文"),
    create(3, "box"),
    append(1, 3),
    set(3, "margin_top", num(-16)),
    set(3, "margin_left", num(8)),
    set(3, "background", paintOf(1, 1, 1)),
    set(3, "width", extent("Px", 8)),
    set(3, "height", extent("Px", 16)),
  ]);
  const grid = paint(layout(tree.root, 6, 1), 6, 1);
  assert.deepEqual([0, 1, 2, 3].map((x) => grid.at(x, 0).ch), [" ", " ", "文", ""]);
});

// ---- The screen ----------------------------------------------------------

test("a screen is written row by row, and only rows that changed", () => {
  const { surface, terminal } = surfaceOf(counterMount, { screen: true, rows: 16 });
  const first = terminal.written.join("");
  assert.equal((first.match(/\x1b\[\d+;1H/g) ?? []).length, 16, "every row");
  assert.equal(first.includes("\x1b[K"), false, "an erase at the last column would take the border with it");
  terminal.written.length = 0;
  surface.apply([setText(3, "Count: 1")]);
  const update = terminal.written.join("");
  assert.deepEqual(update.match(/\x1b\[\d+;1H/g), ["\x1b[4;1H"], "the one row with the count");
  assert.ok(update.includes("Count: 1"));
  terminal.written.length = 0;
  surface.apply([]);
  assert.deepEqual(terminal.written, [], "no change, no write");
});

test("a resize repaints the whole screen at the new size", () => {
  const { terminal } = surfaceOf(counterMount, { screen: true, cols: 40, rows: 16 });
  terminal.written.length = 0;
  terminal.cols = 30;
  terminal.rows = 15;
  terminal.callbacks.resize();
  const out = terminal.written.join("");
  assert.ok(out.startsWith("\x1b[2J"));
  assert.equal((out.match(/\x1b\[\d+;1H/g) ?? []).length, 15);
  assert.ok(out.includes(`╭${"─".repeat(24)}╮`), "26 of the 30 columns");
});

test("a page taller than the screen scrolls to keep the focus in view", async () => {
  const items = [];
  for (let i = 0; i < 20; i += 1) {
    const id = 10 + i;
    items.push(create(id, "button"), append(1, id), ...labelled(id, `b${i}`), listen(id, "click", id));
  }
  const { surface, terminal } = surfaceOf([...column(1), ...items], { screen: true, rows: 5, cols: 10 });
  const seen = () => terminal.written.at(-1);
  assert.ok(seen().includes("[b0]"));
  terminal.type("\t".repeat(7));
  surface.next_event();
  assert.equal(surface.focused().id, 17);
  assert.ok(seen().includes("[b7]"), "scrolled down");
  assert.equal(terminal.written.join("").includes("[b8]"), false, "and no further than it had to");
  terminal.type("\x1b[Z".repeat(7));
  surface.next_event();
  assert.ok(seen().includes("[b0]"), "and back");
});

test("off a screen, each changed frame prints once as plain text", () => {
  const { surface, terminal } = surfaceOf([...column(1), ...label(2, 1, "a")]);
  assert.deepEqual(terminal.written, ["a\n-- end of frame\n"]);
  surface.apply([]);
  assert.equal(terminal.written.length, 1);
  surface.apply([setText(2, "b")]);
  assert.equal(terminal.written[1], "b\n-- end of frame\n");
});

// ---- The real program ----------------------------------------------------

const hd = spawnSync("hd", ["--version"], { stdio: "ignore" });

test("hd run counter-tui, over pipes, paints what the fixture paints", { skip: hd.error ? "no hd on PATH" : false }, () => {
  const run = spawnSync("hd", ["run", "counter-tui"], {
    cwd: new URL("../../examples/counter/", import.meta.url),
    input: "\t\rq",
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(run.status, 0, run.stderr);
  const frames = run.stdout.split("-- end of frame\n").map((frame) => frame.trimEnd());
  const expected = rowsOf(counterMount, 80, 24).join("\n").trimEnd();
  assert.equal(frames[0], expected, "the mount; regenerate fixtures/counter-mount.json if the example changed");
  assert.ok(frames.some((frame) => frame.includes("Count: 1")), "Tab, Enter clicked plus");
});

test("a prefixed event is another renderer's: no listener, and no focus", () => {
  const tree = treeOf([
    create(1, "box"),
    { tag: "Listen", fields: { node: 1, event: "dom:focus", handler: 1 } },
  ]);
  assert.equal(tree.nodes.get(1).listeners.size, 0);
});

test("a button holding only text is one label; one holding more lays out as a box", () => {
  assert.equal(rowsOf([...rowBox(1), create(2, "button"), append(1, 2), ...labelled(2, "a"), create(3, "text"), append(2, 3), setText(3, "b")])[0], "[ab]");
  const live = treeOf([...rowBox(1), create(2, "button"), append(1, 2), ...labelled(2, "0")]);
  assert.equal(live.nodes.get(2).children.length, 1);
  assert.equal(rowsOf([...rowBox(1), create(2, "button"), append(1, 2), ...labelled(2, "0"), setText(1002, "1")])[0], "[1]", "a label follows its text");
  const fragment = [create(3, "fragment"), append(2, 3), create(4, "text"), append(3, 4), setText(4, "x")];
  assert.equal(rowsOf([...rowBox(1), create(2, "button"), append(1, 2), ...fragment])[0], "[x]", "a fragment's text counts");
  const boxed = rowsOf([...rowBox(1), create(2, "button"), append(1, 2), create(3, "box"), append(2, 3), create(4, "text"), append(3, 4), setText(4, "icon")]);
  assert.equal(boxed[0], "icon", "a box inside: no brackets, its child paints");
});

test("a press on a button's label reaches the button", async () => {
  const { surface, terminal } = surfaceOf([...rowBox(1), create(2, "button"), append(1, 2), ...labelled(2, "ok"), listen(2, "click", 7)], { rows: 3, cols: 10 });
  assert.deepEqual(await eventsAfter(surface, terminal, "\x1b[<0;2;1M"), [{ handler: 7, payload: "" }]);
});

test("a node takes keys from the renderer, can give them back, and never Ctrl-C", async () => {
  const items = [
    ...column(1),
    create(2, "input"),
    append(1, 2),
    listen(2, "key", 9),
    set(2, "take_keys", word("Tab\nShift+Tab\nq")),
    create(3, "button"),
    append(1, 3),
    ...labelled(3, "next"),
    listen(3, "click", 8),
  ];
  const { surface, terminal } = surfaceOf(items, { rows: 5, cols: 20 });
  assert.equal(surface.focused().id, 2);
  assert.deepEqual(await eventsAfter(surface, terminal, "\t"), [{ handler: 9, payload: "Tab" }]);
  assert.equal(surface.focused().id, 2, "the focus stayed");
  assert.deepEqual(await eventsAfter(surface, terminal, "\x1b[Z"), [{ handler: 9, payload: "Shift+Tab" }]);
  assert.equal(surface.focused().id, 2);
  surface.apply([set(2, "take_keys", word(""))]);
  await eventsAfter(surface, terminal, "\t");
  assert.equal(surface.focused().id, 3, "given back: Tab moves the focus");
});
