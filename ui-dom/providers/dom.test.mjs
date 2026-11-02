// Checks providers/dom.mjs: both trees forget the nodes a `Remove` or
// `Clear` takes away, and the DOM tree implements the kind and key tables
// of rendering.md. Run with
// `node --test ui-dom/providers/dom.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chordOf, createDomSurface, createScriptedSurface, cssFor } from "./dom.mjs";

// Just enough of the DOM for createDomSurface.
class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.dataset = {};
    this.children = [];
    this.parent = null;
    this.textContent = "";
    this.style = {};
    this.attributes = {};
    this.className = "";
  }
  appendChild(child) {
    child.remove();
    child.parent = this;
    this.children.push(child);
  }
  insertBefore(child, before) {
    child.remove();
    child.parent = this;
    const index = before === null ? -1 : this.children.indexOf(before);
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  replaceChildren() {
    for (const child of this.children) child.parent = null;
    this.children = [];
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  addEventListener() {}
  querySelectorAll(selector) {
    assert.equal(selector, "[data-hd]");
    const found = [];
    const walk = (element) => {
      for (const child of element.children) {
        if (child.dataset.hd !== undefined) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

const command = (tag, fields) => ({ tag, fields });

// The commands `show` emits: a column holding a fragment, then a branch
// with a nested row of two texts, mounted and cleared `times` times.
function showToggled(times) {
  const mount = [
    command("Create", { node: 1, kind: "box" }),
    command("Append", { parent: 0, child: 1 }),
    command("Create", { node: 2, kind: "fragment" }),
    command("Append", { parent: 1, child: 2 }),
  ];
  const batches = [mount];
  let next = 3;
  for (let i = 0; i < times; i += 1) {
    const row = next++;
    const a = next++;
    const b = next++;
    batches.push([
      command("Create", { node: row, kind: "box" }),
      command("Append", { parent: 2, child: row }),
      command("Create", { node: a, kind: "text" }),
      command("Append", { parent: row, child: a }),
      command("Create", { node: b, kind: "text" }),
      command("Append", { parent: row, child: b }),
    ]);
    batches.push([command("Clear", { node: 2 })]);
  }
  // A for_each-style row removed with its subtree.
  batches.push([
    command("Create", { node: next, kind: "fragment" }),
    command("Append", { parent: 1, child: next }),
    command("Create", { node: next + 1, kind: "text" }),
    command("Append", { parent: next, child: next + 1 }),
  ]);
  batches.push([command("Remove", { node: next })]);
  return batches;
}

const quiet = () => {};

test("the DOM tree forgets cleared and removed nodes", () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  const nodes = new Map();
  const log = console.log;
  console.log = quiet;
  try {
    const surface = createDomSurface(new FakeElement("main"), nodes);
    const [mount, ...rest] = showToggled(100);
    surface.apply(mount);
    const mounted = nodes.size;
    for (const batch of rest) surface.apply(batch);
    assert.equal(nodes.size, mounted, "a show toggled 100 times leaves the map at its mount size");
  } finally {
    console.log = log;
    delete globalThis.document;
  }
});

test("the scripted tree forgets cleared and removed nodes", () => {
  const nodes = new Map();
  const surface = createScriptedSurface([], quiet, nodes);
  const [mount, ...rest] = showToggled(100);
  surface.apply(mount);
  const mounted = nodes.size;
  for (const batch of rest) surface.apply(batch);
  assert.equal(nodes.size, mounted, "a show toggled 100 times leaves the map at its mount size");
});

const num = (value) => ({ tag: "Number", fields: { value } });
const word = (value) => ({ tag: "Text", fields: { value } });
const flag = (value) => ({ tag: "Flag", fields: { value } });
const paint = (r, g, b, a = 255) => ({ tag: "Paint", fields: { color: { r, g, b, a } } });
const extent = (tag, value) => ({ tag: "Extent", fields: { size: { tag, fields: value === undefined ? {} : { value } } } });
const unset = { tag: "Unset", fields: {} };

// rendering.md, the DOM column: key, value, the CSS it names.
const table = [
  ["direction", word("row"), [["flexDirection", "row"]]],
  ["wrap", flag(true), [["flexWrap", "wrap"]]],
  ["justify", word("between"), [["justifyContent", "space-between"]]],
  ["align", word("center"), [["alignItems", "center"]]],
  ["gap", num(8), [["gap", "8px"]]],
  ["grow", num(1), [["flexGrow", "1"]]],
  ["shrink", num(0), [["flexShrink", "0"]]],
  ["width", extent("Px", 120), [["width", "120px"]]],
  ["height", extent("Pct", 50), [["height", "50%"]]],
  ["min_width", extent("Auto"), [["minWidth", "auto"]]],
  ["min_height", extent("Px", 4), [["minHeight", "4px"]]],
  ["max_width", extent("Px", 640), [["maxWidth", "640px"]]],
  ["max_height", extent("Pct", 100), [["maxHeight", "100%"]]],
  ["width", extent("Fill"), [["flex", "1 1 0"], ["alignSelf", "stretch"], ["width", ""]]],
  ["padding_top", num(1), [["paddingTop", "1px"]]],
  ["padding_right", num(2), [["paddingRight", "2px"]]],
  ["padding_bottom", num(3), [["paddingBottom", "3px"]]],
  ["padding_left", num(4), [["paddingLeft", "4px"]]],
  ["margin_top", num(1), [["marginTop", "1px"]]],
  ["margin_right", num(2), [["marginRight", "2px"]]],
  ["margin_bottom", num(3), [["marginBottom", "3px"]]],
  ["margin_left", num(4), [["marginLeft", "4px"]]],
  ["border_width", num(1), [["borderWidth", "1px"], ["borderStyle", "solid"]]],
  ["border_color", paint(1, 2, 3), [["borderColor", "rgb(1, 2, 3)"]]],
  ["radius", num(6), [["borderRadius", "6px"]]],
  ["background", paint(10, 20, 30, 128), [["backgroundColor", "rgba(10, 20, 30, 0.502)"]]],
  ["opacity", num(0.5), [["opacity", "0.5"]]],
  ["overflow", word("hidden"), [["overflow", "hidden"]]],
  ["cursor", word("pointer"), [["cursor", "pointer"]]],
  ["color", paint(255, 255, 255), [["color", "rgb(255, 255, 255)"]]],
  ["font_size", num(18), [["fontSize", "18px"]]],
  ["font_weight", num(600), [["fontWeight", "600"]]],
  ["font_family", word("mono"), [["fontFamily", "ui-monospace, SFMono-Regular, Menlo, monospace"]]],
  ["font_family", word("Inter"), [["fontFamily", "Inter"]]],
];

test("each key of the table produces the CSS the table names", () => {
  for (const [key, value, css] of table) {
    assert.deepEqual(cssFor(key, value), css, key);
    assert.ok(
      cssFor(key, unset).every(([, text]) => text === ""),
      `Unset clears ${key}`,
    );
  }
  assert.equal(cssFor("shadow", num(1)), null, "an unknown key is not a style key");
});

test("the DOM tree applies kinds, style keys, dom: keys and control values", () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  const nodes = new Map();
  const warnings = [];
  const log = console.log;
  console.log = quiet;
  try {
    const surface = createDomSurface(new FakeElement("main"), nodes, (line) => warnings.push(line));
    surface.apply([
      command("Create", { node: 1, kind: "box" }),
      command("SetProp", { node: 1, key: "gap", value: num(8) }),
      command("SetProp", { node: 1, key: "dom:class", value: word("card") }),
      command("SetProp", { node: 1, key: "dom:attr:aria-label", value: word("main card") }),
      command("SetProp", { node: 1, key: "shadow", value: num(3) }),
      command("SetProp", { node: 1, key: "shadow", value: num(4) }),
      command("Append", { parent: 0, child: 1 }),
      command("Create", { node: 2, kind: "fragment" }),
      command("Create", { node: 3, kind: "checkbox" }),
      command("SetProp", { node: 3, key: "checked", value: flag(true) }),
      command("Create", { node: 4, kind: "input" }),
      command("SetProp", { node: 4, key: "value", value: word("milk") }),
      command("SetProp", { node: 4, key: "disabled", value: flag(true) }),
      command("Create", { node: 5, kind: "canvas" }),
    ]);
    const box = nodes.get(1);
    assert.equal(box.tag, "div");
    assert.equal(box.style.display, "flex", "a box is a flex container");
    assert.equal(box.style.flexDirection, "column", "column by default");
    assert.equal(box.style.gap, "8px");
    assert.equal(box.className, "card");
    assert.equal(box.attributes["aria-label"], "main card");
    assert.equal(nodes.get(2).style.display, "contents", "a fragment lays out as its parent");
    assert.equal(nodes.get(3).type, "checkbox");
    assert.equal(nodes.get(3).checked, true);
    assert.equal(nodes.get(4).type, "text");
    assert.equal(nodes.get(4).value, "milk");
    assert.equal(nodes.get(4).disabled, true);
    assert.equal(nodes.get(5).style.display, "flex", "an unknown kind renders as a box");
    assert.deepEqual(warnings, ["ui: ignoring unknown property shadow", "ui: ignoring unknown kind canvas"], "each once");
    surface.apply([
      command("SetProp", { node: 1, key: "gap", value: unset }),
      command("SetProp", { node: 1, key: "dom:attr:aria-label", value: unset }),
    ]);
    assert.equal(box.style.gap, "", "Unset removes a style key");
    assert.equal("aria-label" in box.attributes, false, "Unset removes an attribute");
  } finally {
    console.log = log;
    delete globalThis.document;
  }
});

test("the DOM tree routes portable and dom: events, and drops an unknown one", () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  const nodes = new Map();
  const warnings = [];
  try {
    const surface = createDomSurface(new FakeElement("main"), nodes, (line) => warnings.push(line), quiet);
    const listened = [];
    surface.apply([command("Create", { node: 1, kind: "dom:textarea" })]);
    const element = nodes.get(1);
    assert.equal(element.tag, "textarea");
    element.addEventListener = (name, listener) => listened.push([name, listener]);
    surface.apply([
      command("Listen", { node: 1, event: "input", handler: 1 }),
      command("Listen", { node: 1, event: "dom:theme-change", handler: 2 }),
      command("Listen", { node: 1, event: "blur", handler: 3 }),
    ]);
    assert.deepEqual(listened.map(([name]) => name), ["input", "theme-change"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /event blur/);
    // A CustomEvent's string detail is the payload of a dom: event.
    listened[1][1]({ detail: "dark", target: { value: "no" } });
    assert.deepEqual(surface.next_event(), { handler: 2, payload: "dark" });
    // A portable event's payload is the target's value, whatever its detail.
    listened[0][1]({ detail: 1, target: { value: "typed" } });
    assert.deepEqual(surface.next_event(), { handler: 1, payload: "typed" });
  } finally {
    delete globalThis.document;
  }
});

test("a key's name carries its modifiers, and a shift only before a named key", () => {
  assert.equal(chordOf({ key: "a" }), "a");
  assert.equal(chordOf({ key: "A", shiftKey: true }), "A");
  assert.equal(chordOf({ key: "Tab" }), "Tab");
  assert.equal(chordOf({ key: "Tab", shiftKey: true }), "Shift+Tab");
  assert.equal(chordOf({ key: "Enter", metaKey: true }), "Meta+Enter");
  assert.equal(chordOf({ key: "s", ctrlKey: true }), "Ctrl+s");
  assert.equal(chordOf({ key: "Shift", shiftKey: true }), "Shift");
});

test("take_keys prevents only the keys it names, can change, and leaves a composition alone", () => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  const nodes = new Map();
  try {
    const surface = createDomSurface(new FakeElement("main"), nodes, quiet, quiet);
    surface.apply([command("Create", { node: 1, kind: "box" })]);
    const listeners = [];
    nodes.get(1).addEventListener = (name, listener) => listeners.push([name, listener]);
    surface.apply([command("SetProp", { node: 1, key: "take_keys", value: word("Tab\nShift+Tab") })]);
    const keydown = (fields) => {
      let prevented = false;
      listeners[0][1]({ ...fields, preventDefault: () => (prevented = true) });
      return prevented;
    };
    assert.equal(listeners.length, 1);
    assert.equal(keydown({ key: "Tab" }), true);
    assert.equal(keydown({ key: "Tab", shiftKey: true }), true);
    assert.equal(keydown({ key: "a" }), false);
    assert.equal(keydown({ key: "Tab", isComposing: true }), false);
    surface.apply([command("SetProp", { node: 1, key: "take_keys", value: word("") })]);
    assert.equal(listeners.length, 1, "no second listener");
    assert.equal(keydown({ key: "Tab" }), false, "given back");
  } finally {
    delete globalThis.document;
  }
});
