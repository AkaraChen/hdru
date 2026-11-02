# Layering

What belongs in which package, and how to add a component without blurring it. Read this before adding a builder,
a node kind, a property or an event. [`rendering.md`](rendering.md) has the tables this refers to, and
[`packages.md`](packages.md) the manifests. `layering.test.mjs` checks the parts a machine can.

## The rule

**Put a thing in the lowest layer that can hold it, and judge that by what it depends on.**

| It depends on | It goes in | Examples |
| --- | --- | --- |
| nothing about nodes | `reactive` | `signal`, `memo`, `effect`, owners, context |
| the protocol, and a meaning every renderer can give it | `ui` | `button`, `input`, `Style`, `Theme`, `Command`, `resource`, the loop `run_on!`, `Recorder` |
| one platform | that renderer: `ui-dom`, `ui-tui` | the `Surface` host trait, providers, `attr`, `dom_class`, `dom_on`, `link`, `textarea` |
| one program | the app | the playground's `Workbench` and its compiler protocol |

Imports go one way, and a package names only what is below it:

```
app  ->  ui-dom | ui-tui  ->  ui  ->  reactive
```

- `reactive` imports nothing of ours, and `ui` imports only `reactive`. Neither has a `[host]` table, so neither
  depends on JavaScript.
- A renderer imports `ui` and never another renderer.
- A portable app's `src/lib.hd` imports only `ui`. Its entries (`src/main.hd`, `src/tui.hd`) pick the renderer.

## `ui` does not follow HTML

`ui` defines its own vocabulary, and `ui-dom` translates it to HTML, as react-native-web does for React Native. So a
rule in `ui` needs a reason in `ui`'s own terms.

- An `input` has no children because it holds a value, on every renderer. That HTML's `<input>` also has none is a
  coincidence that makes `ui-dom`'s work easy; it is not the reason.
- A `button` is a container that can be pressed. That is why it holds children, on every renderer.
- If `ui`'s meaning and a platform's differ, the renderer bridges them. `box` has no such word in HTML, so `ui-dom`
  makes it a `div` with `display: flex`.

## Names show the layer

A property key, node kind or event without a prefix is portable. A prefix says whose it is, and the other renderers
ignore it: `dom:class`, `dom:attr:title`, `dom:textarea`, `dom:a`, `dom:focus`.

`ui` emits no prefixed name itself. It has five neutral extension points, on which a renderer builds its own words:

| Extension point | What it does | Built on it, in `ui-dom` |
| --- | --- | --- |
| `prop(key, compute)` | a property of the block's node that follows signals | `attr` |
| `Style.host_prop(key, value)` | a key beyond the portable ones, in a `Style` | `DomStyle.dom_class` |
| `on(event, handler)` | a handler for an event on the block's node | `dom_on` |
| `text_field(kind, value, style, decorate)` | a field bound to a signal | `textarea` |
| `container(kind, style, children)` | a node holding what its block builds | `link` |

The point is the import. Using `attr` means writing `use dep.ui_dom.attr`, so a component that only works in a browser
says so, and `use dep.ui.attr` does not compile.

A renderer's word is allowed to be missing elsewhere, because the prefix and the import declare it. A word in `ui`
is not: it is a promise that every renderer gives it a meaning.

## Adding a component

First decide what it is:

1. **Can it be composed from what exists?** Then it is an ordinary function in the app, or in `ui` if every app
   needs it. It adds no kind, no key and no renderer work. Most components are this: a card is a `column` with a
   style, and a tab bar is a `row` of `button`s. Try this first.
2. **Does it need something new from the renderer, and can every renderer do it?** Then it is a new portable word, and
   the checklist below applies.
3. **Can only one platform do it?** Then it goes in that renderer's package, with its prefix.

### A new portable word

Each step is a separate place where this goes wrong.

- [ ] State its meaning without naming a platform. If you cannot, it is not portable.
- [ ] Add the row to the kind, key or event table in `rendering.md`, with what each renderer does.
- [ ] Add the builder in `ui`, following the conventions below.
- [ ] Implement it in `ui-dom/providers/dom.mjs` and `ui-tui/providers/tui.mjs`. Both, in the same change:
      `layering.test.mjs` fails on a kind only one renderer knows.
- [ ] Test the commands in `ui/tests/`, with no host.
- [ ] Test each provider in its `providers/*.test.mjs`.
- [ ] Use it in an example, and run that in both a terminal and a browser.

If a renderer cannot follow a key exactly, say how it approximates it in the table, as the terminal does for `wrap`.

## Conventions for a builder

These keep one way to write each thing, so that a new component adds no new concept.

**Content is a closure,** as an argument or a trailing block. `text(fn(): "hello")` and `text(fn(): "${count.get()}")`
are the same function, so static content can become live without changing the call. Do not add a `_live` variant of anything. A closure that reads no
signal leaves no computation behind (`run_effect`), so static content costs no more than a string.

**A container takes a block.** If a word can hold other nodes, its last parameter is
`children: fn() -> void $ Ui + R`. It does not take a label or an icon as parameters: those are children.

```hd
button(fn(): count.update(fn(n): n + 1), style=primary):
    text:
        "${count.get()}"
```

**A leaf is either content or a bound value.** `text` holds content. `input` and `checkbox` hold a signal they keep in
step with the control. Neither has children.

**The order of parameters:** what it needs, then a named `style: Style = Style::empty()`, then the block.

**What acts on a node goes in that node's block.** `on`, `prop`, `attr`, `style_live`, `take_keys` and `on_ready` need
`Target`, which only a builder's block provides. A builder returns `void`, since a component may end with one, so there
is no handle to pass around: where the call is written says which node it means.

```hd
column:
    attr("id", fn(): "main")      # the column
    input(draft):
        on("enter", submit)       # the input
```

Every builder that makes a node takes a block, except `text`, whose block is its content. Give a new one a block too.
A container's block runs under `Ui + Target`. A leaf's runs under `Decorate`, which is `Owner + Target`, so a leaf
cannot be given children. A component body and a `show` or `for_each` block have no `Target`, so calling `on` there does
not compile, and a helper that acts on a node says so in its row: `$ Owner + Target`.

**A ref is an id given to the host, once it exists.** `on_ready(fn(node): ...)` runs after the host has applied the node,
with its opaque `NodeId`. What an id means is between the app and its host: the playground passes it to `Workbench.bind`,
and looks it up in the table the DOM renderer fills. Do not coordinate through DOM ids.

**A default is stopped by declaring it, not in a handler.** A handler runs after the event has crossed into wasm, too
late to prevent anything. `take_keys(fn(): ["Tab"])` says beforehand which keys a node takes from its renderer, on every
renderer, and follows signals, so a node can give a key back.

**Read keys where they are valid.** A block given to a container runs now, under the caller's row. A closure the
library keeps and reruns has only `Track`, so anything from `$.use` is read first, into a local:

```hd
fn title() -> void $ Ui + Provided[string]:
    name := use_given::[string]()
    text(fn(): name)
```

## What enforces this

| Rule | Enforced by |
| --- | --- |
| reading a signal needs `Track`, writing needs `Mutate`, a missing provider | the compiler |
| `ui` offers no DOM words | the compiler: `unknown-import`, `unknown-method` |
| acting on a node needs a block that has one; a leaf takes no children | the compiler: the `Target` key and the `Decorate` row |
| imports go one way; `ui` and `reactive` have no host and no prefixed names | `layering.test.mjs` |
| every kind in `ui` exists in both renderers | `layering.test.mjs` |
| the terminal paints what the real program sends | `ui-tui/providers/tui.test.mjs`, against a fixture |

## Known gaps

Places where the rule is not met yet, so that nobody takes them as precedent.

- **`on` takes a string.** `on("blur", ...)` compiles, and the DOM logs and ignores it at run time. Typed events would
  catch it at compile time, and would change every call of `on`.
- **`Style.disabled` is a control's state, not a style.** It belongs on the controls.
- **`ui-dom` words still run in a terminal.** Importing `ui-dom` is allowed in a program with a terminal entry, where
  `textarea` draws as a plain box and cannot be edited. A requirement key such as `$ Dom` could make this a compile
  error, at the cost of one more thing in every DOM component's row.
- **Only keys can be taken.** No event but a key can stop its default yet. A DOM-only way would belong in `dom_on`.
- **A button can hold a button.** Nothing stops it, though what focus and clicks mean there is undefined on every
  renderer.
