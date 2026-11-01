# ui: a Solid-style reactive UI library for hd

Run-once components, signal handles, memos, effects, an owner tree, keyed
collections, and a command stream over the Wasm boundary to a small DOM
adapter. `docs/bootstrap.md` is the plan that built phases 0 to 8,
`docs/design.md` the record of what was built and why, `docs/roadmap.md`
what comes next, `docs/rendering.md` the renderer protocol and style
design, and `docs/packages.md` the split into three packages:

- `reactive`: signals, memos, effects, owners, context. No nodes, no host.
- `ui`: the `Ui` row, builders, `show`, `for_each`, inputs, resources,
  the command protocol, `mount` and `dispatch`. Re-exports `reactive`'s
  user-facing names. No host trait.
- `ui-dom`: the `Surface` host trait, `run_app!` with its event loop and
  worker pool, `Recorder`, and the JavaScript provider.

An app depends on `ui` and `ui-dom` and consents to
`"dep.ui_dom.surface.Surface" = true` in its manifest.

```hd
use dep.ui.{Style, Ui, button, column, row, signal, text_live}
use dep.ui_dom.{Surface, run_app}

fn counter() -> void $ Ui:
    count := signal(+0)
    column(style=Style::empty().gap(8.0).padding(12.0)):
        text_live:
            "Count: ${count.get()}"
        row(style=Style::empty().gap(4.0)):
            button("-", fn(): count.update(fn(n): n - 1))
            button("+", fn(): count.update(fn(n): n + 1))

pub fn main!() -> void $ Surface:
    run_app!(counter)
```

The requirement keys are the phases: `Track` to read a signal, `Mutate`
to write one, `Ui` (the row `$ Owner + Parent`) to build. A write inside a memo or an eager
read inside a component body is a compile error.

Builders take the caller's whole row, so a component that names a context
key, `$ Ui + Provided[Theme]`, reads it anywhere in its body, and a missing
provider is a compile error. `input` and `checkbox` are bound to signals.

Style is typed and renderer-neutral (`docs/rendering.md`): builders take
`style: Style = Style::empty()` with chain methods (`.gap(8.0)`,
`.padding(12.0)`, `.bg(color)`), each set field crossing the protocol as
one `SetProp(node, key, PropValue)`; `style_live:` inside a container's
block restyles it by changed keys only; `Theme` is a requirement key
whose palette is a signal, so dark mode is one write. `attr` and
`Style.dom_class` reach DOM-only `dom:` keys.

A `resource` loads a value with a suspending function whenever its key
changes; the load runs on one of `run_app!`'s worker tasks while the
event loop keeps serving clicks. The loader captures any provider it
needs lexically, `let clock: *mut dyn Clock = $.use(Clock)` before the
`fn!`, because its row is empty. `resource_with(key, load, policy)` wraps
each load in a `std.task` policy such as `timeout(ms(5000))` or
`retry(Backoff {})`.

Tests run on the Node engine only; wasmtime is out of scope for now.

## Prerequisites

- The `hd-lang` checkout beside this repo at `../hd-lang`, last checked at
  commit `cf5040b4a`. The browser build imports its `host/*.ts` directly.
- The `hd` binary built from it: `cargo install --path crates/hd_cli`
  inside `../hd-lang` (lands in `~/.cargo/bin/hd`). The Node engine is the
  default; this package does not run under wasmtime.
- Node 20 or newer, and `pnpm` (for `pnpm dlx esbuild`) if you build the
  browser pages.
- Do not run `hd fmt` without `hd check` after it: see
  [hd-lang#1165](https://github.com/HerringtonDarkholme/hd-lang/issues/1165).

## Commands

| What | Command |
| --- | --- |
| every package's tests (node), from the root | `hd test` |
| one package | `hd test -p reactive` (or `ui`, `ui-dom`) |
| provider tests | `node --test ui-dom/providers/dom.test.mjs` |
| the counter under Node, three scripted clicks | `cd examples/counter && UI_CLICKS=2,2,1 hd run --engine node` |
| the todos demo under Node | `cd examples/todos && UI_CLICKS=1,8=milk,10 hd run --engine node` (toggle, type "milk" and press Enter, reverse) |
| the fetcher demo under Node (a resource with a delayed loader) | `cd examples/fetcher && UI_CLICKS=2,2 hd run --engine node` |
| the browser pages | `./web/build.sh`, then serve `web/` (for example `python3 -m http.server -d web 8765`) and open `index.html` or `todos.html` |

## Layout

- `hd.toml` the workspace: `reactive`, `ui`, `ui-dom` and the three examples
- `reactive/src/keys.hd` ids, the `Track`/`Mutate`/`Owner` keys and their providers
- `reactive/src/graph.hd` the program-wide dependency graph and owner tree, and the low-level API (`run_effect`, `cleanup_on`, `new_owner`, `dispose`)
- `reactive/src/reactive.hd` `signal`, `memo`, `effect`, `sync`, `batch`, `untrack`, `assert_no_writes`
- `reactive/src/owner.hd` `root`, `owned`, `on_cleanup`; `reactive/src/context.hd` `given`, `use_given` (typed), `provide`, `use_context` (owner tree)
- `ui/src/keys.hd` `Parent`, `Scope`, `type Ui = $ Owner + Parent`; `ui/src/protocol.hd` `Command`, `PropValue`, `Color`, `Size`, `UiEvent`
- `ui/src/style.hd` `Style` and its lowering and diff; `ui/src/theme.hd` `Theme`, `Palette`, `provide_theme`
- `ui/src/builders.hd` `view`, `column`, `row`, `text`, `text_live`, `button`, `show`, `style_live`, `attr`, `attr_live`, `last_node`; `ui/src/collections.hd` `for_each`; `ui/src/inputs.hd` `input`, `checkbox`, `on`
- `ui/src/resource.hd` `resource` and `resource_with`: a value loaded by a `fn!` whenever a tracked key changes, optionally under a `std.task` policy
- `ui/src/runtime.hd` `mount`, `dispatch`, `take_commands`, the handler and job tables, `run_job!`
- `ui-dom/src/surface.hd` the `@host Surface` trait; `ui-dom/src/app.hd` `run_app!` and the worker pool; `ui-dom/src/recorder.hd` an hd `Surface` for tests
- `ui-dom/providers/dom.mjs` the provider: real DOM in a browser, a printing in-memory tree elsewhere; `ui-dom/providers/dom.test.mjs` its Node test
- `examples/counter` (with a dark-mode switch), `examples/todos`, `examples/fetcher`, `web/` (pages share a reset, `web/style.css`)
