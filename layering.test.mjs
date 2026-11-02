// Checks what docs/layering.md says a machine can check. Run with
// `node --test layering.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

function sources(dir) {
  const out = [];
  for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (entry.name.endsWith(".hd")) out.push(path);
  }
  return out;
}

// The packages a file imports with `use dep.NAME`.
const depsOf = (text) => [...text.matchAll(/^\s*(?:pub )?use dep\.([a-z_]+)/gm)].map((m) => m[1]);
// A file with its comments gone, so that prose may mention what code may not.
const code = (text) => text.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");

const ALLOWED = {
  reactive: [],
  ui: ["reactive"],
  "ui-dom": ["ui"],
  "ui-tui": ["ui"],
};

for (const [pkg, allowed] of Object.entries(ALLOWED)) {
  test(`${pkg} imports only what is below it`, () => {
    for (const file of sources(`${pkg}/src`)) {
      for (const dep of depsOf(code(read(file)))) {
        assert.ok(allowed.includes(dep), `${file} imports dep.${dep}`);
      }
    }
  });
}

test("reactive and ui declare no host", () => {
  for (const pkg of ["reactive", "ui"]) {
    assert.ok(!/^\[host\]/m.test(read(`${pkg}/hd.toml`)), `${pkg} has a [host] table`);
    for (const file of sources(`${pkg}/src`)) assert.ok(!code(read(file)).includes("@host"), `${file} has a @host`);
  }
});

test("reactive and ui emit no renderer's names", () => {
  for (const pkg of ["reactive", "ui"]) {
    for (const file of sources(`${pkg}/src`)) {
      assert.deepEqual(code(read(file)).match(/"[a-z]+:[^\s"]*"/g) ?? [], [], `${file} names a renderer's key`);
    }
  }
});

test("a portable app's library imports only ui", () => {
  for (const app of readdirSync(new URL("examples", import.meta.url))) {
    assert.deepEqual(depsOf(code(read(`examples/${app}/src/lib.hd`))).filter((dep) => dep !== "ui"), [], app);
  }
});

test("every kind in ui exists in both renderers", () => {
  const kinds = new Set();
  for (const file of sources("ui/src")) {
    for (const m of code(read(file)).matchAll(/(?:create_node|styled_node|text_field)\("([a-z]+)"/g)) kinds.add(m[1]);
  }
  assert.ok(kinds.has("button") && kinds.has("text"), "the scan found the kinds");
  const dom = read("ui-dom/providers/dom.mjs");
  const domKinds = dom.slice(dom.indexOf("const kinds = {"), dom.indexOf("};", dom.indexOf("const kinds = {")));
  const tui = read("ui-tui/providers/tui.mjs");
  const tuiKinds = tui.slice(tui.indexOf("const KINDS"), tui.indexOf("\n", tui.indexOf("const KINDS")));
  for (const kind of kinds) {
    // "box" is also what each renderer falls back to, but it is still listed.
    assert.ok(new RegExp(`\\b${kind}:`).test(domKinds), `ui-dom has no kind ${kind}`);
    assert.ok(tuiKinds.includes(`"${kind}"`), `ui-tui has no kind ${kind}`);
  }
});
