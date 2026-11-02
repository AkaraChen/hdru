# Rendering

Where the renderer boundary sits, what crosses it, how style is expressed, and the two
renderers that exist: the DOM (`ui-dom`) and the terminal (`ui-tui`).

## Three layers

React is portable because of its renderer interface, not its virtual DOM, and Solid
shows the same with `createRenderer` and no virtual DOM at all. Host vocabulary is not
shared: `div` and `className` for the DOM, `View` and `style` for React Native. This
library has the same shape:

| Layer | React | Solid | Here | Package |
| --- | --- | --- | --- | --- |
| 1 Reactive core | reconciler, Fiber | signals, owners | `graph.hd`, `reactive.hd`, `owner.hd` | `reactive` |
| 2 Renderer protocol | host config | `createRenderer` table | the `Command` stream | types in `ui`; the `@host` trait and loop in each renderer (`ui-dom`, `ui-tui`) |
| 3 Vocabulary | `div` vs `View` | `solid-js/web` | node kinds, events and property keys, typed by `Style` | `ui` |

**Layer 2 carries no vocabulary.** Kinds, event names and property keys are data, so
adding a property touches `Style` and the renderers that want it, never the host trait.

## Layer 2: the protocol

```hd
@derive(Eq, Debug)
pub enum Command:
    Create(node: NodeId, kind: string)
    Append(parent: NodeId, child: NodeId)
    MoveBefore(parent: NodeId, child: NodeId, before: NodeId?)
    Remove(node: NodeId)
    Clear(node: NodeId)
    SetText(node: NodeId, text: string)
    SetProp(node: NodeId, key: string, value: PropValue)
    Listen(node: NodeId, event: string, handler: HandlerId)

@derive(Eq, Debug)
pub enum PropValue:
    Number(value: f32)
    Text(value: string)
    Flag(value: bool)
    Paint(color: Color)
    Extent(size: Size)
    Unset

pub struct Color:  # r, g, b, a: u8; built by rgb and rgba
pub enum Size:     # Px(value: f32), Pct(value: f32), Auto, Fill
```

A host answers with `UiEvent { handler, payload }`. Handler 0 ends the loop.

- **Fields are named because they cross the ABI by name.** The generated glue delivers
  `{ tag: "Px", fields: { value: 8 } }`, and an optional is a value or `null`.
- **`PropValue` is typed** so that a renderer in any language never parses `"8px"` or
  `"#336699"`. `Color` and `Size` are the only structured values every renderer needs.
- **Key namespaces.** A key without a prefix is portable. A key with a renderer prefix
  belongs to that renderer and is ignored by the others: `dom:class`,
  `dom:attr:aria-label`. This replaces a raw command and makes non-portable code visible
  at the call site.
- **Numbers are `f32` logical pixels**, and each renderer applies its own scale.

## Layer 3: the vocabulary

The subset every target can implement: flexbox boxes, text, two controls. It is React
Native's model, which react-native-web has shown maps onto CSS without loss. Not included:
grid, absolute positioning, transforms, animation, shadows, pseudo-states.

### Node kinds

| kind | DOM | Terminal | Rule |
| --- | --- | --- | --- |
| `box` | `div`, `display: flex`, column | a flex column | every box is a flex container, column by default; the builder is `view` |
| `text` | `span` | wrapped text | holds text only |
| `button` | `button` | centered label, `[label]` with no border or background | emits `click`, takes `SetText` |
| `input` | `input type=text` | a field with a cursor | `value` property |
| `checkbox` | `input type=checkbox` | `[x]` / `[ ]` | `checked` property |
| `fragment` | `div`, `display: contents` | no box at all | groups without layout; `show` and `for_each` render into one |

`button` and `input` stay kinds, not boxes with a `role` key: both renderers draw them
differently from a box, and a key would carry the same switch with less checking. An
unknown kind renders as `box`.

### Events

| event | payload | DOM | Terminal |
| --- | --- | --- | --- |
| `click` | empty | `click` | Enter or Space on the focus, or a left press |
| `input` | the field's text | `input` | editing a focused field |
| `change` | `"true"` / `"false"` | `change` | Space or a press on a checkbox |
| `key` | the key name, as `KeyboardEvent.key` | `keydown` | any key on the focus but Tab, Shift-Tab and the quit keys |
| `enter` | the field's text | `keydown` of Enter | Enter in a focused field |

Events bubble to ancestors' listeners on both renderers.

### Properties

Edges stay four keys rather than one value: a provider reads each by name, and four
`SetProp`s cost nothing a batch notices. An unknown key is dropped.

| key | value | DOM | Terminal |
| --- | --- | --- | --- |
| `direction` | Text `row` / `column` | `flex-direction` | followed |
| `wrap` | Flag | `flex-wrap` | not followed: one line only |
| `justify` | Text `start` / `center` / `end` / `between` / `around` | `justify-content` | followed |
| `align` | Text `start` / `center` / `end` / `stretch` | `align-items` | followed |
| `gap` | Number | `gap` | in cells |
| `grow`, `shrink` | Number | `flex-grow`, `flex-shrink` | followed, in whole cells |
| `width`, `height`, `min_*`, `max_*` | Extent | the same; `Fill` is `flex: 1 1 0; align-self: stretch` | in cells; see `Fill` below |
| `padding_*`, `margin_*` | Number | the same | in cells |
| `border_width` | Number | `border-width` | any nonzero is one cell |
| `border_color` | Paint | `border-color` | the border's color |
| `radius` | Number | `border-radius` | above 0, rounded corners |
| `background` | Paint | `background-color` | blended over what is underneath |
| `opacity` | Number 0..1 | `opacity` | under 1, the dim attribute |
| `overflow` | Text `visible` / `hidden` / `scroll` | `overflow` | `hidden` and `scroll` both clip |
| `cursor` | Text `default` / `pointer` / `text` | `cursor` | not followed |
| `color` | Paint | `color` | inherited; see below |
| `font_size` | Number | `font-size` | not followed |
| `font_weight` | Number 100..900 | `font-weight` | 600 and up is bold; inherited |
| `font_family` | Text, a token name | resolved by a theme table | not followed |
| `value` | Text | `input.value` | the field's text |
| `checked` | Flag | `input.checked` | the checkbox's state |
| `disabled` | Flag | `disabled` | dim, takes no focus |

**`color` and `font_weight` inherit on both renderers.** `text_live` takes no style, so
live text is styled by a wrapping `view` and depends on it.

**`Fill` differs by renderer.** The terminal grows on the main-axis key and stretches on
the cross-axis key. The DOM applies its one CSS shorthand to either key, so `width: Fill`
in a column also grows there. Code that wants both renderers to agree sets `Fill` on the
main-axis key.

## The hd side: `Style`

`Style` has one optional field per key, with edges as four fields. `None` means "not set",
so one value serves both a whole style and a set of changes. It is generated from one field
table, so field order, lowering order and diff order are the same.

```hd
column(style=Style::empty().gap(8.0).padding(12.0).bg(theme.surface)):
    style_live:
        Style::empty().opacity(if dim.get(): 0.5 else: 1.0)
    text("hello", style=Style::empty().color(theme.on_surface))
```

- `Style::empty()` is a static method because a parameter named `style` hides a function
  named `style` in its own default.
- Chain methods exist per field, with shorthands `padding`, `padding_x`, `padding_y`,
  `margin` and `border(px, color)`, and `merge(other)` overlays one style on another. The
  background setter is `bg`.
- `lower(style)` gives one `SetProp` per set field, and `diff(last, next)` gives changed keys,
  with `Unset` for a key that went to `None`.
- `style_live:` restyles the enclosing container and emits only changed keys, nothing for an
  equal style. Its first run compares with an empty style, so give a key a static or a live
  value, not both, or `Unset` can remove the static one.
- `column` and `row` are `view` with `direction` set, always emitted.
- `Style.dom_class` and `attr` / `attr_live` reach the `dom:` keys.

## Theme instead of a cascade

CSS's cascade carries values from an ancestor to deep nodes, and hd already has that: a
requirement key.

```hd
fn card() -> void $ Ui + Theme:
    theme := $.use(Theme).palette()
    column(style=Style::empty().bg(theme.peek().surface).padding(12.0)):
        style_live:
            Style::empty().bg(theme.get().surface)
        text("hello", style=Style::empty().color(theme.peek().on_surface))
```

`provide_theme(palette_signal, body)` installs it, and `Palette::light()` and `dark()` have the
roles `background`, `surface`, `on_surface`, `muted`, `line`, `accent` and `on_accent`. Forgetting
to provide one is `missing-requirement` at compile time. `peek` gives a static style and `get`
inside `style_live` follows the signal, so dark mode is one write.

## What a renderer implements

A package with its own `@host trait Surface` (one trait maps to one provider file), its own
`run_app!` and `Recorder`, and a provider that keeps a node table, implements the eight commands,
and follows the kind and key tables as far as it can. A provider is a plain object with `apply`,
`next_event`, `post_job` and `next_job`. Suspending methods may return a value or a Promise, and
each method also receives a context whose `instanceSignal` aborts when the program ends.

## The DOM provider

`ui-dom/providers/dom.mjs` is the react-native-web of this design. In a browser it drives real
elements under `#app`; anywhere else it keeps an in-memory tree, prints each batch, and answers
the events in `UI_CLICKS` (`2,2,1` clicks, `4=milk` sends a payload). `cssFor(key, value)` is the key
table as a pure function. Unknown kinds and keys are logged once.

`web/` holds the browser pages. `web/main.js` bundles `../hd-lang/host/web.ts`, the generated
`counter.host.mjs` and the provider with esbuild, and binds them as `host/run.ts` does for Node. One
glue file serves all three examples, because the trait belongs to `ui-dom`.

## The terminal provider

`ui-tui/providers/tui.mjs` runs under Node: a retained tree, a pure layout pass, a cell painter,
then keys and focus. Importing it touches nothing until the first `apply`.

**Layout** is an embedded flexbox pass of about 290 lines, not yoga-layout or taffy-wasm. Those are
asynchronous Wasm to load, would be the repo's first npm or vendored binary dependency, and calculate
in floats that a cell grid has to round anyway. `place` is pure and memoized per pass, because a box
measures a child and then lays it out, which is otherwise exponential in depth. Sizes are border box,
as React Native's, and text wraps at its box.

**Units.** A cell is 8 by 16 logical pixels, so `padding(16)` is two columns and one row, and
`padding_y(4)` rounds to no rows.

**Painting** fills a grid of cells and writes only rows that changed, each a full width, so nothing
needs erasing. An erase at the last column would take the border with it. Color follows the terminal's
depth (truecolor, 256 or none). Text with no color contrasts with the background it is on, because a
terminal's default may be light where the DOM's is black, and over no background the terminal's own
color stands.

**Keys.** Tab and Shift-Tab move the focus, Enter and Space click, Space toggles a checkbox, and
typing, Left, Right, Home, End, Backspace and Delete edit a field. A left press focuses the nearest
listening node under it and clicks it, and a field only takes the focus. `q` quits except in a field,
where it is a letter. Ctrl-C always quits.

**A key is read when hd asks for an event, not when it arrives,** so each sees the tree the previous
key's event left. It cannot append to a value a batch is about to replace, or act on a row a click is
about to remove.

**Focus** starts on the first node with a listener. It shows as reverse video inside the border, or a
cursor in a field. When its node goes, it passes to whatever holds its position. A page taller than the
screen scrolls to keep the focus in view; boxes do not scroll.

**Off a terminal** it prints each changed frame as plain text, and the end of a piped stdin ends the
loop, so `printf '\t\rq' | hd run counter-tui` is a test.

**Getting the terminal back,** whatever happens:

- A clean end, a panic or a passed deadline aborts `instanceSignal`, and the provider restores the
  screen and raw mode. Without this a panic would leave stdin holding the process open.
- While the alternate screen is up, fd 2 is an unlinked file, printed on leaving, so a panic's message
  survives and stderr cannot scribble on the screen. Close 2 and POSIX gives the next open the lowest
  free descriptor, which is how Node can do `dup2`. This happens only when stderr is a terminal.
- Keys are read on their own thread, so Ctrl-C is seen even with the main thread stuck in a Wasm loop,
  where in raw mode it is only a byte. If the main thread shows no sign a second later, the thread sends
  SIGKILL.
- A guard, a small `sh` in its own session, waits on a pipe from the provider. If the pipe closes while
  it runs, the provider died without cleaning up, and it leaves the alternate screen and restores `stty`.
  A clean exit kills it first.
- `--time-limit` runs the program in a worker, where `process.stdin` is not the real one, so the provider
  opens fds 0 and 1 itself and polls the window size.

**Limits:**

- Under `--time-limit`, a panic's first line is lost on a real screen unless stderr is redirected, because
  closing fd 2 from a worker makes Node print a warning.
- Mouse reporting takes selection from the terminal; most give it back under Shift.
- While a program is stuck only Ctrl-C works, not `q`, and a synchronous computation over a second counts as
  stuck.
- A process killed this way reports status 1.
- The fd 2 swap, the worker path, the key thread, the guard and real mouse input need a real terminal, so
  `tui.test.mjs` cannot reach them. They were checked by hand in tmux.

## Native renderers

A GPUI or other native renderer cannot be bound as a package host trait today: package providers run only on
JavaScript hosts (`cli.host.package.javascript`), which [hd-lang#1191](https://github.com/HerringtonDarkholme/hd-lang/issues/1191)
tracks. This comes from reading the source at `cf5040b4a`, since this `hd` build has no wasmtime engine to run.

**`hd_run_wasmtime` is closed in two places.** `WasmtimeEngine::load` refuses any module with an
`hd.capabilities` section (`engine.rs:240`). Past that, the `Linker` is made and filled inside `instantiate_host`
(`engine.rs:141`), imports dispatch through a closed `Kind` enum (`host/call.rs`), and the store's `Host` type is
private. No public API takes an extra import.

**Driving is already open.** `hd_run::Instance` is public, with `init`, `poll`, `wake` and `completed`, and
`WasmtimeInstance` implements it, so an embedder could run turns from GPUI's foreground executor. The JS core has
the matching `createDriver` (`cli.host.driver.*`).

**A raw `wasmtime` embedder is possible but not an open path.** `counter-tui.wasm` imports only seven `hd:pkg:<hash>`
functions and four from `hd:rt`, and `hd_host_abi::schema::from_wasm` returns the checked contract. A Rust program could
link them, but would own the exchange-buffer codec, which exists only as generated JavaScript, the driver, and every other
host trait the app names (the fetcher adds `hd:Clock`), against an ABI that is not stable and a module name that holds a
directory hash.

**What #1191 should decide:**

1. Binding shape: a generated Rust trait plus codec, passed to an engine API at instantiation, as the analogue of
   `NAME.host.mjs`. A GPUI app is a Rust binary that owns `main` and embeds hd, so a dylib adds problems it does not need.
2. Consent stays as it is: `[capabilities]` in the app's manifest, checked by the embedder as the invoker.
3. Value conversion mirrors `module.host.package.js-values`: enums with named payload fields become Rust enums with the
   same names.
4. How a native provider's completions reach the guest. `completed()` returns the engine's own reactor batch, and on a
   first look there is no way to add to it from outside. A pending `next_event.start` needs one. Not checked by a run.

The terminal provider shows what such a renderer would keep: the protocol needed no change, and the split into retained
tree, pure layout and paint carries over, with taffy in place of `place` and GPUI's own focus.
