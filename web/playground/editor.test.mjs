import assert from "node:assert/strict";
import { test } from "node:test";
import { indentEdit, rangeOf, tokensOf } from "./editor.mjs";
import { commandLog, problemsOf } from "../../playground/providers/workbench.mjs";

const applied = (text, e) => text.slice(0, e.from) + e.insert + text.slice(e.to);

test("tokens carry offsets into the whole source", () => {
  const source = "fn app() -> i32:\n    x := 1 # hi\n";
  const tokens = tokensOf(source);
  const keyword = tokens.find((t) => t.kind === "keyword");
  assert.equal(source.slice(keyword.start, keyword.end), "fn");
  const number = tokens.find((t) => t.kind === "number");
  assert.equal(source.slice(number.start, number.end), "1");
  const comment = tokens.find((t) => t.kind === "comment");
  assert.equal(source.slice(comment.start, comment.end), "# hi");
  for (const t of tokens) assert.ok(t.start < t.end && t.end <= source.length);
});

test("the line cache gives the same tokens and holds only current lines", () => {
  const cache = new Map();
  const first = tokensOf("fn a\nfn b", cache);
  assert.deepEqual(tokensOf("fn a\nfn b", cache), first);
  tokensOf("fn a", cache);
  assert.deepEqual([...cache.keys()], ["fn a"]);
});

test("Tab inserts spaces up to the next stop", () => {
  const e = indentEdit("ab", 2, 2, false);
  assert.equal(applied("ab", e), "ab  ");
  assert.deepEqual([e.selStart, e.selEnd], [4, 4]);
  assert.equal(applied("", indentEdit("", 0, 0, false)), "    ");
});

test("Tab on a selection within a line replaces it", () => {
  assert.equal(applied("abcd", indentEdit("abcd", 1, 3, false)), "a   d");
});

test("Tab indents every selected line and keeps the selection on the text", () => {
  const text = "a\n\nb\nc";
  const e = indentEdit(text, 0, 4, false);
  assert.equal(applied(text, e), "    a\n\n    b\nc");
  assert.equal(applied(text, e).slice(e.selStart, e.selEnd), "a\n\n    b");
});

test("a selection ending at a line's start leaves that line alone", () => {
  const text = "a\nb\nc";
  assert.equal(applied(text, indentEdit(text, 0, 2, false)), "    a\nb\nc");
});

test("Shift-Tab removes up to one level from each line", () => {
  const text = "      a\n  b\nc";
  const e = indentEdit(text, 0, text.length, true);
  assert.equal(applied(text, e), "  a\nb\nc");
});

test("Shift-Tab with a caret keeps it on the same character", () => {
  const text = "x\n    ab";
  const e = indentEdit(text, 7, 7, true);
  const out = applied(text, e);
  assert.equal(out, "x\nab");
  assert.equal(out[e.selStart], "b");
});

test("Shift-Tab with the caret inside the indent lands at the line's start", () => {
  const e = indentEdit("    a", 2, 2, true);
  assert.deepEqual([e.selStart, e.selEnd], [0, 0]);
});

const at = (line, column, end_line, end_column) => ({ line, column, end_line, end_column });
const covered = (source, p) => {
  const r = rangeOf(source, p);
  return r && source.slice(r.start, r.end);
};

test("a problem's place maps lines and columns to offsets", () => {
  assert.equal(covered("ab\n    nope(1)\n", at(2, 5, 2, 9)), "nope");
});

test("columns count characters, not UTF-16 units or bytes", () => {
  // The compiler reports this semicolon at column 13, not 14.
  assert.equal(covered('    x := "😀"; nope', at(1, 13, 1, 14)), ";");
  assert.equal(covered('    x := "中文字"; nope', at(1, 15, 1, 16)), ";");
});

test("a problem can span lines", () => {
  assert.equal(covered("a(\n  b\n)", at(1, 1, 3, 2)), "a(\n  b\n)");
});

test("a problem with no width or no end still covers something", () => {
  assert.equal(covered("abc def", at(1, 5, 1, 5)), "def");
  assert.equal(covered("abc def", at(1, 5, 0, 0)), "def");
  assert.equal(covered("abc", at(1, 4, 1, 4)), "c");
  assert.equal(covered("x😀", at(1, 3, 1, 3)), "😀");
});

test("a problem with no place has no range", () => {
  assert.equal(rangeOf("abc", at(0, 0, 0, 0)), null);
  assert.equal(rangeOf("abc", at(9, 1, 9, 2)), null);
  assert.equal(rangeOf("a\n\nb", at(2, 1, 2, 1)), null);
});

test("a problem past the end of its line stops at the line's end", () => {
  assert.equal(covered("ab\ncd", at(1, 2, 1, 99)), "b");
});

test("diagnostics become rows, and another file's has no place", () => {
  const rows = problemsOf([
    { path: "src/main.hd", line: 2, column: 5, endLine: 2, endColumn: 9, code: "c", severity: "error", message: "here" },
    { path: "ui/src/lib.hd", line: 7, column: 1, endLine: 7, endColumn: 2, code: null, severity: "warning", message: "there" },
    { path: null, line: null, column: null, endLine: null, endColumn: null, code: null, severity: "error", message: "nowhere" },
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.line, r.end_column, r.code]), [[0, 2, 9, "c"], [1, 0, 0, ""], [2, 0, 0, ""]]);
  assert.equal(rows[1].message, "ui/src/lib.hd:7: there");
  assert.equal(rows[2].message, "nowhere");
});

test("the log joins one node's properties and still counts every command", () => {
  const prop = (node, key, value) => ({ tag: "SetProp", fields: { node, key, value: { tag: "Number", fields: { value } } } });
  const text = commandLog([
    { tag: "Create", fields: { node: 1, kind: "box" } },
    prop(1, "gap", 8),
    prop(1, "radius", 4),
    prop(2, "gap", 1),
    { tag: "Append", fields: { parent: 0, child: 1 } },
  ]);
  assert.deepEqual(text.split("\n"), [
    "── batch · 5 commands",
    'Create(1, "box")',
    "SetProp(1) gap=8 radius=4",
    "SetProp(2) gap=1",
    "Append(0, 1)",
  ]);
});
