# Roadmap: from bootstrap to library

Status: phases 9 to 15 implemented on 2026-11-02 (11 and 12 after the
renumbering); `design.md` records where each departed from this plan. Written as a plan the same day after a
review of the phase 0 to 8 code against `../hd-lang` at `cf5040b4a`. `bootstrap.md` is the plan that got
us here and `design.md` the record of what was built. This file says what
comes next and why, in the order to do it.

## 1. Where the bootstrap stands

Working: a correct lazy reactive core (versions plus Clean/Check/Dirty),
owner tree with cleanups, `show`, keyed `for_each`, `resource` on a worker
pool, a command stream to one JavaScript provider that serves Node and the
browser, 30 tests, three examples. The design record is unusually complete.

Not yet a library, for three kinds of reason:

- **Correctness and hygiene gaps** found in review (section 3, phase 9).
- **Half of hd's effect system is unused.** The three phase keys and
  provider swapping are used well. Row polymorphism (`[$R]`, the extension
  pattern of `req.poly.extension`) is used only by `mount` and `run_app!`,
  so a component with `$ Ui + Clock` cannot call `$.use(Clock)` inside a
  `column:` block, and context is a string-keyed `Inspectable` map instead
  of requirement keys checked at compile time (phase 10).
- **Missing surface area**: attributes and classes, input controls, a
  README that lets a stranger run it (phases 11 to 13).

Four items are hd's, not ours, and are filed upstream (section 5).

## 2. Rules carried forward

The three rules of `design.md` phase 0 still hold at `cf5040b4a`:

1. A closure's row must equal an `Fn`/`FnMut` bound's row exactly
   (#1163 upstream would relax this).
2. A concrete `fn` parameter cannot be stored; retained callbacks are a
   bare `F < 'static & Fn...` erased into a concrete closure.
3. An `Fn` bound takes only an inline closure or a function name.

Two new ones from this review, both verified with `hd check` / `hd test`
on 2026-11-02:

4. **Row-polymorphic builders compile and work.** A container
   `fn column[$R](children: fn() -> void $ Ui + R) -> void $ Ui + R` that
   re-installs `Ui` and calls `children()` threads any extra key of the
   caller through nested blocks. `req.poly.one-body` says such a body is
   compiled once. This holds only for callbacks that run *synchronously
   inside the builder*. A callback the library retains and runs later from
   `run_computation` (`text_live`, `show`'s branch, `for_each`'s render)
   runs under `Track + Mutate` only and cannot carry `R`; it captures
   providers lexically, as loaders already do.
5. **`hd fmt` is not safe to run blindly** (#1165). A closure argument
   whose body is a trailing-block call is collapsed into a form the parser
   rejects. Until #1165 lands, write such bodies as `live(fn(): ...)`, as
   `tests/for_each.hd` does, and run `hd check` after every `hd fmt`.

## 3. Phases

Each phase ends with `hd test` green on Node and, where it touches a
builder, the three examples re-run under Node (`UI_CLICKS=...`) and the
browser pages rebuilt once. Each phase adds its section to `design.md`.

### Phase 9: hygiene (half a day)

Small fixes from the review, done first because phases 11 and 12 make
every one of them fire more often.

- `Signal.set` writes unconditionally. Add an `Eq`-bounded
  `set_if_changed` (or make `set` compare when `T < Eq`; probe which the
  checker allows on `impl[T < 'static] Signal[T]`), and use it in
  `for_each` for retained rows so an unrelated list change no longer
  reruns every row's `text_live`.
- `providers/dom.mjs` leaks its `nodes` map: `Remove` deletes only the top
  node's entry and `Clear` deletes none. Walk `[data-hd]` descendants on
  both. Same for the scripted tree.
- `for_each` with two items of one key silently overwrites a row. Panic
  with the key.
- `WORKERS := 4` and `all!(worker(), worker(), worker(), worker())` are
  two copies of one number. Keep one; a comment that `all!` is fixed
  arity (#1164) explains why it is not a loop.
- `reset_for_test` leaves `sources`, `computations` and `owners` from
  earlier cases in the graph. Clear them too.
- `text_live` uses `Last { text: "yes" }` as a boolean. Make it a `bool`.
- `type Reactive = $ Track + Mutate` row alias for the six
  `fn() -> bool $ Track + Mutate` signatures (`req.row.alias`).
- README gains a Prerequisites section: the sibling `../hd-lang` checkout
  at a named commit, `cargo install --path crates/hd_cli`, `pnpm` for
  esbuild, and that nothing runs under wasmtime.

Gate: tests green, plus one new test per bullet that has observable
behavior (equality skip emits nothing; duplicate key panics; a `show`
toggled 100 times leaves the provider's map at its mount size, checked
from a Node test over `dom.mjs`).

### Phase 10: row-polymorphic builders and typed context (1 day)

The flagship pattern of `spec/lang/11` applied to the synchronous build
path.

- `column`, `row`, `owned`, `root` take `[$R]` and have row `$ Ui + R`
  (`root`: `$ Ui + Track + Mutate + R`). `mount` and `run_app!` already do.
- A component may then write `fn themed_text() -> void $ Ui + Theme` and
  read `$.use(Theme)` anywhere in its body, and a provider helper is the
  spec's extension form:

  ```hd
  fn themed[$R](theme: *mut Dark, body: fn() -> void $ R + Theme) -> void $ R:
      $.with(Theme=theme):
          body()
  ```

  A missing provider is `missing-requirement` at compile time, where
  `use_context` today returns `.None` at run time.
- Probe a generic key for one-off values, `trait Provided[T]: fn value(self) -> T`,
  so `$.with(Provided[Theme]=box(...))` and `$.use(Provided[Theme]).value()`
  need no trait per context type (`req.key.binding.identity`; watch
  `generic-requirement-key-collision` in generic bodies).
- Keep `provide` / `use_context` for the one case `$.with` cannot serve:
  a value read inside a retained callback (`text_live`, `show`, `for_each`
  render), which runs later under `Track + Mutate` only. Document the
  rule: static context is a key in the row; context read from a
  re-running computation is captured lexically or fetched through the
  owner tree.
- `examples/fetcher`: move `$.use(Clock)` from the top of `app` into the
  `row:` that builds the buttons, to show it now compiles.

Gate: `tests/context.hd` gains a Theme-through-two-columns case and a
compile-fail doc test (`# error: missing-requirement`) for a component
whose row names `Theme` under a `mount` that provides none. The probe
that proved rule 4 is the first test; its text is in section 6.

### Phase 11: the package split (1 day)

Implements `packages.md`: one workspace, three library packages along
the layers of `rendering.md`, examples as members.

- Root `hd.toml` with `[workspace]`; `reactive/`, `ui/`, `ui-dom/` with
  the manifests of `packages.md` section 3; files move as its table says.
- `reactive/src/lib.hd` exports the low-level computation API
  (`new_computation`, `run_computation`, `new_owner`, `dispose`,
  `cleanup_on`) and nothing else from `graph.hd`; builders stop touching
  `graph()`.
- `ui/src/lib.hd` re-exports `reactive`'s user-facing names; `ui-dom`
  gets `Surface`, `run_app!`, the workers, `Recorder`, the provider.
- `runtime.hd` splits: synchronous parts stay in `ui`, the suspending
  loop goes to `ui-dom`; `tests/resource.hd` drives jobs with `run_job!`
  and `take_commands`.
- Examples depend on `ui` and `ui-dom` and consent to
  `dep.ui_dom.surface.Surface`; `web/build.sh` reads the provider from
  `ui-dom/providers/`.

Gate: `hd test` at the root is green with the same case count as before;
each example runs under Node with the same command stream; the browser
pages rebuild. `hd test -p reactive` and `-p ui` pass with no `[host]`
table in either package.

### Phase 12: the renderer protocol and typed style (2 days)

Implements `rendering.md`: a vocabulary-free protocol (layer 2) and a
typed flexbox vocabulary in hd (layer 3), so the DOM provider becomes
one of several renderers instead of the definition of the protocol.

- `DomCommand` becomes `Command` in `ui`: `SetAttr` is replaced by
  `SetProp(node, key, PropValue)`, with `PropValue`, `Color` and `Size`
  as in the design. Node kinds stay strings; `"div"` becomes `"box"`
  (flex column by default), `"text"`, `"button"`, `"input"`. The `attr`
  and `attr_live` builders already in the tree become `dom:`-prefixed
  `SetProp`s.
- `Style` struct with optional fields, `Style::empty()` and one chain
  method per field; `box / column / row / text / button` take
  `style: Style = Style::empty()` and lower each `Some` field to one
  `SetProp` after `Create`. The `gap` parameter goes away.
- `style_live:` inside a container block restyles the enclosing container
  by diffing against the last `Style` and emitting only changed keys.
- `providers/dom.mjs` implements the key table of `rendering.md` section
  3 and the `dom:` prefix; unknown keys are dropped. `web/*.html` keep
  only a reset stylesheet, the demos style themselves through `Style`.
- Depends on phase 10 for the `Theme` requirement key; the theme itself
  (`Palette`, `provide_theme`) lands here.

Gate: command-list tests for lowering (one `SetProp` per set field, in
key order), for `style_live` (changed keys only, `Unset` on a field that
went to `None`, nothing on an equal style), and a Node test over
`dom.mjs` that each key in the table produces the CSS the table names.

### Phase 13: input controls (1 day; `input`, `checkbox` and
`tests/inputs.hd` are already in the working tree, so what remains is the
todos example and the payload rules below)

- `UiEvent.payload` and `fn(string) -> void $ Mutate` handlers exist; add
  `input(value: Signal[string], class="")` that emits
  `Listen(node, "input", h)` and writes the payload into the signal, and
  `SetAttr(node, "value", ...)` when the signal changes from elsewhere
  (guard against echoing the user's own keystroke by comparing to the
  last payload).
- `checkbox(checked: Signal[bool])` the same way over `"change"`; the
  provider sends `"true"` / `"false"` as payload.
- `on_key(node, key, handler)` is out until a real example needs it.
- `examples/todos` gains the "new todo" input and an Enter-or-button add.

Gate: `tests/inputs.hd` drives `dispatch` with payloads through `Recorder`;
the browser todos page adds a todo typed by hand.

### Phase 14: resource policies (half a day)

`std.task` layers (`timeout`, `retry`, `fallback`, `hedged`) compose over
`fn!() -> T $ R`. `resource(key, load, policy=timeout(ms(5000)))` wraps
the loader with `apply!` inside `land`. No new machinery; one parameter
and a test with `ManualClock` that a slow loader lands as `Failed`.

### Phase 15: make `Mutate` earn its place (optional, half a day)

`Scheduler` only counts writes and `batch` lives on a graph counter. Two
cheap uses of the hook that is already there: a `Mutate` provider for
tests that panics on any write (`assert_no_writes:`), and one installed by
`dispatch` that records the written sources so a devtools panel can show
"this click wrote `count`". Either make `batch_depth` a field of the
provider or state in `design.md` that `Mutate` is a capability token and
the graph owns scheduling. Decide when writing the section.

### Later, gated on upstream

- **Multi-instance / no globals.** `GRAPH` and `RUNTIME` are program-wide
  by `req.with`'s rule that no provider method may run user code. Making
  the graph a provider value (`$ Graph`) is possible only if every flush
  happens outside provider methods, which is the structure today, so the
  change is mechanical but touches every file. Do it when a second
  instance is needed (two apps on one page, or a server-rendered pass).
- **Push-mode boundary.** When hd ships export registration
  (`HOST_EMBEDDING.md`), register `dispatch` and drop the pull loop.
- **In-flight cancellation and a dynamic pool** wait on #1164.

## 4. Order and cost

| Phase | Days | Unlocks |
| --- | --- | --- |
| 9 hygiene + README | 0.5 | strangers can run it; phases 11 and 12 stop amplifying bugs |
| 10 row-polymorphic builders | 1 | compile-time context; `$.use` anywhere in a component |
| 11 package split | 1 | real encapsulation; core testable on wasmtime; a renderer is a package |
| 12 protocol + typed style | 2 | renderer-neutral protocol; demos look like UI; a non-DOM renderer becomes an implementation task |
| 13 inputs | 1 (mostly done) | todos is a real app |
| 14 resource policies | 0.5 | timeout and retry for free |
| 15 `Mutate` uses | 0.5 | optional |

Six and a half days. 9 precedes everything; 10 precedes 12 (the theme
key) and 13 (the input API should be designed with typed context
available); 11 precedes 12 because 12 edits `surface.hd`, which 11
moves; 14 is independent of the rest.

## 5. Upstream issues and what each changes here

| Issue | What it is | When it lands |
| --- | --- | --- |
| [hd-lang#1163](https://github.com/HerringtonDarkholme/hd-lang/issues/1163) | a closure for an `Fn`-bounded parameter does not take the bound's row, although `fn.trait.bound-closure` says it should | `button("x", fn(): pass)` works; `effect` and `sync` can merge into one `effect` bounded `$ Track + Mutate` (a read-only block then fits); drop rule 1 from `design.md` |
| [hd-lang#1164](https://github.com/HerringtonDarkholme/hd-lang/issues/1164) | no in-language wait: one task cannot block until another signals it | remove `post_job` / `next_job!` from `Surface`; the pool becomes a channel consumer; a disposed resource can `cancel!` its in-flight load; the `Recorder` needs no `run_jobs!` |
| [hd-lang#1165](https://github.com/HerringtonDarkholme/hd-lang/issues/1165) | `hd fmt` collapses a closure with a trailing-block body into code its parser rejects | write `fn(todo): text_live: ...` again; add `hd fmt --check` to the test command |
| [hd-lang#1166](https://github.com/HerringtonDarkholme/hd-lang/issues/1166) | `hd fmt` puts a lone `,` on its own line after a multi-line closure argument | examples become readable without hand formatting |

Check these at each phase boundary together with the `hd` rebuild, as
`bootstrap.md` section 5 says.

## 6. The phase 10 probe

Checked and run on 2026-11-02 at `cf5040b4a` (`hd test`: 1 passed). The
`Ui` here is a stand-in with a depth counter; the library's `Scope` takes
its place.

```hd
use std.function.FnMut

trait Ui:
    fn depth(self) -> i32

trait Theme:
    fn name(self) -> string

struct Scope:
    depth: i32

impl Ui for Scope:
    fn depth(self) -> i32: self.depth

struct Dark: pass

impl Theme for Dark:
    fn name(self) -> string: "dark"

fn column[$R](children: fn() -> void $ Ui + R) -> void $ Ui + R:
    d := $.use(Ui).depth()
    $.with(Ui=box(Scope { depth: d + 1 })):
        children()

fn themed[$R](body: fn() -> void $ R + Theme) -> void $ R:
    $.with(Theme=box(Dark {})):
        body()

fn themed_text() -> string $ Ui + Theme:
    "${$.use(Theme).name()} at ${$.use(Ui).depth()}"

fn app() -> string $ Ui:
    out := box([""])
    themed:
        column:
            column:
                out.push(themed_text())
    out[1]

tests:
    it("row-polymorphic builders thread Theme through nested columns"):
        out := $.with(Ui=box(Scope { depth: 0 })):
            app()
        assert_equal(out, "dark at 2", reason="Theme reached the leaf through two columns")
```
