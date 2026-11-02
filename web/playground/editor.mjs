// What the editor needs beyond hdru's Style and commands. The textarea edits
// and shows the caret, with its own text transparent; behind it, an hdru text
// node holds the same text, colored here with hd-lang's `classify` through the
// CSS Custom Highlight API, so coloring adds no DOM nodes. `::highlight()` can
// only set colors and decoration, which keeps both layers' glyphs the same
// width. The shell decides when Tab indents; applying the edit is here, because it
// needs the selection and the browser's undo history.
import { classify } from "../../../hd-lang/website/src/highlight.ts";

const INDENT = 4;

// The tokens of `source` as { kind, start, end } in UTF-16 offsets, without
// plain text. `cache` keeps each line's spans, so an edit reclassifies one line.
export function tokensOf(source, cache = new Map()) {
  const tokens = [];
  let offset = 0;
  const seen = new Map();
  for (const line of source.split("\n")) {
    const spans = cache.get(line) ?? classify(line);
    seen.set(line, spans);
    let at = offset;
    for (const { text, kind } of spans) {
      if (kind !== "plain") tokens.push({ kind, start: at, end: at + text.length });
      at += text.length;
    }
    offset += line.length + 1;
  }
  // Only the current text's lines stay, so a long session does not grow it.
  cache.clear();
  for (const [line, spans] of seen) cache.set(line, spans);
  return tokens;
}

// The UTF-16 offset of 1-based `column`, which counts characters, in the line
// starting at `lineStart`. It stops at the line's end.
function offsetAtColumn(source, lineStart, column) {
  let at = lineStart;
  for (let n = 1; n < column && at < source.length && source[at] !== "\n"; n++) {
    at += source.codePointAt(at) > 0xffff ? 2 : 1;
  }
  return at;
}

// Where a problem is in `source`, as UTF-16 offsets `start` to `end`, or null
// when it has no place there. A problem with no width, or no end, covers at
// least something to underline: the rest of its line, or the character before
// a line's end.
export function rangeOf(source, { line, column, end_line, end_column }) {
  if (line < 1) return null;
  const starts = [0];
  for (let at = source.indexOf("\n"); at >= 0; at = source.indexOf("\n", at + 1)) starts.push(at + 1);
  if (line > starts.length) return null;
  const start = offsetAtColumn(source, starts[line - 1], column);
  const lineEnd = (at) => {
    const found = source.indexOf("\n", at);
    return found < 0 ? source.length : found;
  };
  let end = end_line >= 1 && end_line <= starts.length ? offsetAtColumn(source, starts[end_line - 1], end_column) : lineEnd(start);
  if (end > start) return { start, end };
  end = lineEnd(start);
  if (end > start) return { start, end };
  // At a line's end: the character before it, when the line has one.
  if (start > starts[line - 1]) return { start: start - (source.codePointAt(start - 2) > 0xffff ? 2 : 1), end: start };
  return null;
}

// What Tab or Shift-Tab does to `text` with the selection `start` to `end`:
// replace `from` to `to` with `insert`, then select `selStart` to `selEnd`.
export function indentEdit(text, start, end, outdent) {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const sameLine = !text.slice(start, end).includes("\n");
  if (!outdent && sameLine) {
    const insert = " ".repeat(INDENT - ((start - lineStart) % INDENT));
    const after = start + insert.length;
    return { from: start, to: end, insert, selStart: after, selEnd: after };
  }
  // A selection that ends at a line's start does not reach that line.
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
  let lineEnd = text.indexOf("\n", last);
  if (lineEnd < 0) lineEnd = text.length;
  const lines = text.slice(lineStart, lineEnd).split("\n");
  // Maps an old offset in the block to its new one, line by line.
  let selStart = start;
  let selEnd = end;
  let oldAt = lineStart;
  let shift = 0;
  const changed = lines.map((line) => {
    const lead = line.length - line.trimStart().length;
    const drop = outdent ? Math.min(lead, INDENT) : 0;
    const add = outdent || line === "" ? 0 : INDENT;
    const next = " ".repeat(add) + line.slice(drop);
    const move = (at) => {
      if (at < oldAt || at > oldAt + line.length) return null;
      return oldAt + shift + add + Math.max(at - oldAt - drop, 0);
    };
    selStart = move(start) ?? selStart;
    selEnd = move(end) ?? selEnd;
    oldAt += line.length + 1;
    shift += add - drop;
    return next;
  });
  return { from: lineStart, to: lineEnd, insert: changed.join("\n"), selStart, selEnd };
}

function applyEdit(input, edit) {
  input.setSelectionRange(edit.from, edit.to);
  // execCommand keeps the browser's undo history, and fires `input` for hdru.
  const done =
    edit.from === edit.to && edit.insert === ""
      ? true
      : edit.insert === ""
        ? document.execCommand("delete")
        : document.execCommand("insertText", false, edit.insert);
  if (!done) {
    input.setRangeText(edit.insert, edit.from, edit.to, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  input.setSelectionRange(edit.selStart, edit.selEnd);
}

function attach(back, gutterBox, input, state) {
  const layer = back.querySelector("span");
  const gutter = gutterBox.querySelector("span");
  const cache = new Map();
  const paint = () => {
    if (typeof Highlight === "undefined") return;
    const node = layer.firstChild;
    const groups = new Map();
    if (node) {
      for (const { kind, start, end } of tokensOf(node.data, cache)) {
        const range = new StaticRange({ startContainer: node, startOffset: start, endContainer: node, endOffset: end });
        if (!groups.has(kind)) groups.set(kind, []);
        groups.get(kind).push(range);
      }
      // Problems for an older text have stale places; the next report replaces them.
      if (state.source === node.data) {
        for (const problem of state.problems) {
          const place = rangeOf(node.data, problem);
          if (!place) continue;
          const kind = problem.severity === "error" ? "error" : "warning";
          const range = new StaticRange({ startContainer: node, startOffset: place.start, endContainer: node, endOffset: place.end });
          if (!groups.has(kind)) groups.set(kind, []);
          groups.get(kind).push(range);
        }
      }
    }
    for (const name of [...CSS.highlights.keys()]) {
      if (name.startsWith("hd-") && !groups.has(name.slice(3))) CSS.highlights.delete(name);
    }
    for (const [kind, ranges] of groups) CSS.highlights.set(`hd-${kind}`, new Highlight(...ranges));
  };
  // A transform, not scrollTop: the textarea's scrollbars make its scrolling
  // range differ from a layer without them.
  const scroll = () => {
    layer.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
    gutter.style.transform = `translateY(${-input.scrollTop}px)`;
  };
  new MutationObserver(() => {
    paint();
    scroll();
  }).observe(layer, { childList: true, characterData: true, subtree: true });
  input.addEventListener("scroll", scroll);
  state.paint = paint;
  state.input = input;
  paint();

}

// The editor, attached once the shell has bound its three nodes.
export function createEditor() {
  const state = { source: null, problems: [], paint: () => {}, input: null };
  const parts = {};
  return {
    bind(role, element) {
      parts[role] = element;
      if (parts["editor-back"] && parts["editor-gutter"] && parts["editor-input"]) {
        attach(parts["editor-back"], parts["editor-gutter"], parts["editor-input"], state);
      }
    },
    indent(outdent) {
      const { input } = state;
      if (input) applyEdit(input, indentEdit(input.value, input.selectionStart, input.selectionEnd, outdent));
    },
    showProblems(source, problems) {
      state.source = source;
      state.problems = problems;
      state.paint();
    },
    // Selects `problem`'s place, and scrolls it to the editor's middle unless
    // it is on screen already.
    reveal(problem) {
      const { input } = state;
      const place = input && rangeOf(input.value, problem);
      if (!place) return;
      input.focus();
      input.setSelectionRange(place.start, place.end);
      const lineHeight = parseFloat(getComputedStyle(input).lineHeight);
      const top = (problem.line - 1) * lineHeight;
      const seen = top >= input.scrollTop && top + lineHeight <= input.scrollTop + input.clientHeight - lineHeight;
      if (!seen) input.scrollTop = Math.max(0, top - input.clientHeight / 2);
      const before = input.value.slice(input.value.lastIndexOf("\n", place.start - 1) + 1, place.start);
      const x = before.length * parseFloat(getComputedStyle(input).fontSize) * 0.6;
      if (x < input.scrollLeft || x > input.scrollLeft + input.clientWidth - 40) input.scrollLeft = Math.max(0, x - 40);
    },
  };
}
