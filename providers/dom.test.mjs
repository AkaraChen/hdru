// Checks that both trees of providers/dom.mjs forget the nodes a `Remove`
// or `Clear` takes away. Run with `node --test providers/`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDomSurface, createScriptedSurface } from "./dom.mjs";

// Just enough of the DOM for createDomSurface.
class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.dataset = {};
    this.children = [];
    this.parent = null;
    this.textContent = "";
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
  setAttribute() {}
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
    command("Create", { node: 1, kind: "div" }),
    command("Append", { parent: 0, child: 1 }),
    command("Create", { node: 2, kind: "div" }),
    command("Append", { parent: 1, child: 2 }),
  ];
  const batches = [mount];
  let next = 3;
  for (let i = 0; i < times; i += 1) {
    const row = next++;
    const a = next++;
    const b = next++;
    batches.push([
      command("Create", { node: row, kind: "div" }),
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
    command("Create", { node: next, kind: "div" }),
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
