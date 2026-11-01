# Rendering layers and style

Status: design, 2026-11-02. Decides where the renderer boundary sits, what
crosses it, and how style is expressed so that one hd component tree can
render to the DOM today and to non-CSS renderers (GPUI-like, custom
retained trees) later. Probed against `../hd-lang` at `cf5040b4a`; the
probe is in section 8. `roadmap.md` phase 11 implements this.

## 1. Three layers, as React and Solid draw them

React is portable because of its renderer interface, not its virtual DOM.
The reconciler diffs `{type, props}` trees and emits mutations; a *host
config* of about thirty functions (`createInstance`, `appendChild`,
`commitUpdate`, ...) applies them; and the *host component vocabulary*
(`div` and `className` for the DOM, `View` and `style` for React Native)
is not shared at all. React itself has no opinion on style: `style` is a
prop handed to the renderer. React Native defined a typed flexbox subset
over Yoga, and react-native-web maps that subset back onto CSS. Solid has
no virtual DOM and still renders anywhere through
`solid-js/universal`'s `createRenderer({ createElement, insertNode,
setProperty, ... })`, which shows that the interface, not the diffing
strategy, is what carries portability.

| Layer | React | Solid | This package | hd package (`packages.md`) |
| --- | --- | --- | --- | --- |
| 1 Reactive core | reconciler, Fiber | signals, owners | `graph.hd`, `reactive.hd`, `owner.hd`: done | `reactive` |
| 2 Renderer protocol | host config | `createRenderer` table | the `Surface` command stream: done, but carries DOM words | types in `ui`; the `@host` trait and loop in each renderer package (`ui-dom`) |
| 3 Vocabulary | `div`/`className` vs `View`/`style` | `solid-js/web` | not defined; this document | `ui` |

Rule that follows: **layer 2 carries no vocabulary.** Node kinds, event
names and property keys are data. Layer 3 is a typed hd module that
lowers to layer 2, the way React Native's `View` and `ViewStyle` lower to
host config calls. A renderer implements the layer 2 protocol once and
the layer 3 key table as far as it can; unknown keys are ignored.

## 2. Layer 2: the protocol

`DomCommand` becomes `Command`. Eight operations on opaque node ids:

```hd
@derive(Eq, Debug)
pub enum Command:
    ## Makes a node of `kind`. The kinds are vocabulary (section 3); a
    ## renderer treats an unknown kind as "box".
    Create(node: NodeId, kind: string)
    Append(parent: NodeId, child: NodeId)
    MoveBefore(parent: NodeId, child: NodeId, before: NodeId?)
    Remove(node: NodeId)
    Clear(node: NodeId)
    ## The text of a "text" node.
    SetText(node: NodeId, text: string)
    ## Sets or unsets one property. Keys are vocabulary; unknown keys are
    ## ignored. `Unset` removes the property.
    SetProp(node: NodeId, key: string, value: PropValue)
    ## Reports `event` on `node` as `UiEvent { handler, payload }`.
    Listen(node: NodeId, event: string, handler: HandlerId)

@derive(Eq, Debug)
pub enum PropValue:
    Number(f32)
    Text(string)
    Flag(bool)
    Paint(Color)
    Extent(Size)
    Unset

@derive(Eq, Debug)
pub struct Color:
    pub r: u8
    pub g: u8
    pub b: u8
    pub a: u8

@derive(Eq, Debug)
pub enum Size:
    Px(f32)
    Pct(f32)
    Auto
    Fill
```

Why `PropValue` is typed at all, when React's `props` are untyped: the
protocol crosses an ABI, and a renderer written in Rust or Go must not
parse `"8px"` or `"#336699"`. `Color` and `Size` are the only structured
values every renderer needs; everything else in the vocabulary is a
number, a word or a flag. Adding a property never changes this enum, so
the host trait and every provider stay fixed while the vocabulary grows.

Key namespaces: a key without a prefix is portable vocabulary. A key with
a renderer prefix is that renderer's and is ignored by the others:
`dom:class`, `dom:attr:aria-label`, later `gpui:...`. This replaces a
`Raw` command and makes non-portable code visible at the call site.

`SetAttr` is gone: `class` is `SetProp(n, "dom:class", .Text(...))`, and
`style` strings are gone with it. `UiEvent` is unchanged.

## 3. Layer 3: the portable vocabulary, version 1

The subset every target can implement: flexbox boxes, text, two
controls. It is React Native's model, which react-native-web has shown
maps onto CSS without loss.

### Node kinds

| kind | DOM | Rule |
| --- | --- | --- |
| `box` | `div` with `display:flex; flex-direction:column` | every box is a flex container, column by default, as React Native's `View` |
| `text` | `span` | holds text only; styled by the text properties |
| `button` | `button` | a box that emits `click`; kept distinct so the DOM gets its accessibility semantics |
| `input` | `input` | emits `input` with the value as payload; `value` property |

### Events

`click`, `input`, `change`, `key`. Payload: empty for `click`, the value
for `input` and `change`, the key name for `key`.

### Properties

| key | value | DOM | taffy / GPUI-like |
| --- | --- | --- | --- |
| `direction` | Text `row` / `column` | `flex-direction` | `flex_direction` |
| `wrap` | Flag | `flex-wrap` | `flex_wrap` |
| `justify` | Text `start` / `center` / `end` / `between` / `around` | `justify-content` | `justify_content` |
| `align` | Text `start` / `center` / `end` / `stretch` | `align-items` | `align_items` |
| `gap` | Number | `gap` (px) | `gap` |
| `grow`, `shrink` | Number | `flex-grow`, `flex-shrink` | `flex_grow`, `flex_shrink` |
| `width`, `height`, `min_width`, `min_height`, `max_width`, `max_height` | Extent | the same; `Fill` is `flex: 1 1 0` | `size`, `min_size`, `max_size`; `Fill` is grow 1, basis 0 |
| `padding_top` ... `padding_left`, `margin_*` | Number | the same (px) | `padding`, `margin` rects |
| `border_width` | Number | `border-width` | `border` |
| `border_color` | Paint | `border-color` | border color |
| `radius` | Number | `border-radius` | corner radii |
| `background` | Paint | `background-color` | fill |
| `opacity` | Number 0..1 | `opacity` | opacity |
| `overflow` | Text `visible` / `hidden` / `scroll` | `overflow` | `overflow` |
| `cursor` | Text `default` / `pointer` / `text` | `cursor` | cursor style |
| `color` | Paint | `color` | text color |
| `font_size` | Number | `font-size` (px) | font size |
| `font_weight` | Number 100..900 | `font-weight` | weight |
| `font_family` | Text, a token name | resolved by the renderer's theme table | the same |
| `value` | Text | `input.value` | control value |
| `disabled` | Flag | `disabled` | interaction off |

Not in version 1: grid, absolute positioning, transforms, animation,
shadows, pseudo-states. Overlays will come as a `layer` node kind, not by
opening `position`.

Text properties are valid on `text` nodes only. The DOM inherits `color`
and font from a parent box; GPUI inherits text color too; taffy and
custom renderers do not. The vocabulary therefore promises no
inheritance, and the hd `Theme` (section 5) makes setting them on each
text node cheap. A renderer that does inherit must set them explicitly
anyway, so behavior matches.

## 4. The hd side: `Style` and the builders

`Style` is a struct of optional fields, one per key above (edges as four
fields each). `None` means "not set", so one value serves both "the whole
style of this node" and "only these changes":

```hd
@derive(Eq, Debug)
pub struct Style:
    pub direction: Direction?
    pub gap: f32?
    pub padding: Edges?
    pub width: Size?
    pub background: Color?
    pub color: Color?
    # ...

impl Style:
    pub fn empty() -> Style: ...
    pub fn gap(self, px: f32) -> Style:
        Style { ...self, gap: .Some(px) }
    pub fn padding(self, all: f32) -> Style: ...
    pub fn bg(self, color: Color) -> Style: ...
    # one method per field, GPUI-style chaining
```

Usage: `column(style=Style::empty().gap(8.0).padding(12.0).bg(theme.surface)):`.
The constructor is a static method because a parameter named `style`
hides a function named `style` in its own default (probed:
`binding-not-yet-visible`).

Builders:

- `box(style: Style = Style::empty(), children)`; `column` and `row` are
  `box` with `direction` preset and replace today's `gap` parameter, so
  there is one way to write a gap.
- `text(content, style=)`, `button(label, on_click, style=)`,
  `input(value, style=)`.
- **Lowering at create**: for each `Some` field, one `SetProp` after
  `Create`. `Edges` lowers to its four keys. `Direction.Row` lowers to
  `Text("row")`.
- **`style_live:`** inside a container's children block restyles the
  enclosing container, which is the scope's `parent` node. The block
  returns a `Style` under `Track`; the computation keeps the last `Style`
  and emits `SetProp` only for fields that changed, `Unset` for a field
  that went to `None` (the `diff` of the probe). Equal styles emit
  nothing, as `text_live` does for text. A live style on a leaf wraps the
  leaf in a `box`; a `text_live`-style variant for leaves can follow if
  examples want it.
- `dom:class` is reachable through `Style.dom_class: string?` so the
  non-portable key is spelled out where it is used.

## 5. Theme replaces the cascade

CSS's cascade exists to carry values from an ancestor to deep nodes. hd
already has that: a requirement key. After roadmap phase 10 makes the
builders row-polymorphic:

```hd
pub trait Theme:
    fn palette(self) -> ReadSignal[Palette]

fn card() -> void $ Ui + Theme:
    theme := $.use(Theme).palette()
    column(style=Style::empty().bg(theme.peek().surface).padding(12.0)):
        style_live:
            Style::empty().bg(theme.get().surface)
        text("hello", style=Style::empty().color(theme.peek().on_surface))
```

A component that needs a theme says so in its row; forgetting to provide
one is `missing-requirement` at compile time. `peek` gives a static
style, `get` inside `style_live` follows the palette signal, so dark mode
is one signal write. What the browser loses is `prefers-color-scheme` as
a CSS feature; the host sends it as an event instead.

## 6. What a renderer implements

A provider keeps a node table, implements the eight commands, and the
kind and key tables as far as it can. The DOM provider is the
react-native-web of this design: `direction: row` becomes
`flex-direction: row`. A frame-based renderer keeps the retained tree the
commands describe and draws it each frame; the command stream carries
changes, drawing is the renderer's cadence. Unknown kinds render as
`box`; unknown keys are dropped; a renderer may log both once.

## 7. Decisions recorded

- Protocol generic, vocabulary typed in hd, not the reverse: adding a
  property touches `Style` and the renderers that want it, never the host
  trait.
- Flexbox subset only, box is flex column by default, no inheritance
  promised.
- Static `style=` plus `style_live:` on the container; no per-property
  live setters.
- `Theme` as a requirement key with a `ReadSignal[Palette]`, not a
  stylesheet.
- No `Raw`; renderer-prefixed keys instead.
- `f32` logical pixels; a renderer applies its own scale factor.

Open: whether `Edges` should also cross the boundary as one value (fewer
commands) or stay four keys (smaller `PropValue`); whether `button` and
`input` should be boxes with a `role` key instead of kinds; the first
non-DOM renderer decides both.

## 8. Probe (2026-11-02, `cf5040b4a`, `hd test`: 3 passed)

Established: `@derive(Eq)` works on structs and enums with `f32` payloads
and optional fields; a chained builder over `Style { ...self, gap: .Some(px) }`
works; a default argument may be a call (`style: Style = Style::empty()`);
a field-by-field diff to `(key, PropValue)` pairs is a plain function;
`match` arms must be on their own lines (an inline `match x: .A => 1, .B => 2`
is `syntax-error`).

```hd
@derive(Eq, Debug)
pub enum Size:
    Px(f32)
    Pct(f32)
    Auto
    Fill

@derive(Eq, Debug)
pub struct Color:
    pub r: u8
    pub g: u8
    pub b: u8
    pub a: u8

@derive(Eq, Debug)
pub struct Style:
    pub gap: f32?
    pub width: Size?
    pub background: Color?
    pub row: bool?

impl Style:
    pub fn empty() -> Style:
        Style { gap: .None, width: .None, background: .None, row: .None }

    pub fn gap(self, px: f32) -> Style:
        Style { ...self, gap: .Some(px) }

    pub fn width(self, size: Size) -> Style:
        Style { ...self, width: .Some(size) }

    pub fn bg(self, color: Color) -> Style:
        Style { ...self, background: .Some(color) }

@derive(Eq, Debug)
pub enum PropValue:
    Number(f32)
    Text(string)
    Flag(bool)
    Paint(Color)
    Extent(Size)
    Unset

pub fn diff(last: Style, next: Style) -> List[(string, PropValue)]:
    let mut out: List[(string, PropValue)] = []
    if last.gap != next.gap:
        value := match next.gap:
            .Some(v) => PropValue.Number(v)
            .None => PropValue.Unset
        out.push(("gap", value))
    if last.width != next.width:
        value := match next.width:
            .Some(v) => PropValue.Extent(v)
            .None => PropValue.Unset
        out.push(("width", value))
    if last.background != next.background:
        value := match next.background:
            .Some(v) => PropValue.Paint(v)
            .None => PropValue.Unset
        out.push(("background", value))
    out

fn column(style: Style = Style::empty(), children: fn() -> void) -> f32:
    children()
    match style.gap:
        .Some(g) => g
        .None => 0.0

tests:
    it("Eq on f32 fields and chained style"):
        s := Style::empty().gap(8.0).width(.Fill)
        assert_equal(s.gap, .Some(8.0), reason="gap set")
        assert_equal(s == Style::empty().gap(8.0).width(.Fill), true, reason="structural Eq")
    it("diff emits only changed keys"):
        a := Style::empty().gap(8.0).bg(Color { r: 1, g: 2, b: 3, a: 255 })
        b := Style::empty().gap(8.0)
        assert_equal(diff(a, b), [("background", .Unset)], reason="one change")
    it("call default and trailing block"):
        g := column:
            pass
        assert_equal(g, 0.0, reason="default style")
        h := column(style=Style::empty().gap(4.0)):
            pass
        assert_equal(h, 4.0, reason="named style")
```
