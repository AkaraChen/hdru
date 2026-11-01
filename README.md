# ui: a Solid-style reactive UI library for hd

Run-once components, signal handles, memos, effects, an owner tree, keyed
collections, and a command stream over the Wasm boundary to a small DOM
adapter. `docs/bootstrap.md` is the plan that built phases 0 to 8,
`docs/design.md` the record of what was built and why, `docs/roadmap.md`
what comes next, `docs/rendering.md` the renderer protocol and style
design, and `docs/packages.md` the planned split into `reactive`, `ui`
and `ui-dom` packages.

```hd
use dep.ui.{Surface, Ui, button, column, row, run_app, signal, text_live}

fn counter() -> void $ Ui:
    count := signal(+0)
    column(gap=8):
        text_live:
            "Count: ${count.get()}"
        row(gap=4):
            button("-", fn(): count.update(fn(n): n - 1))
            button("+", fn(): count.update(fn(n): n + 1))

pub fn main!() -> void $ Surface:
    run_app!(counter)
```

The three requirement keys are the phases: `Track` to read a signal,
`Mutate` to write one, `Ui` to build. A write inside a memo or an eager
read inside a component body is a compile error.

Builders take the caller's whole row, so a component that names a context
key, `$ Ui + Provided[Theme]`, reads it anywhere in its body, and a missing
provider is a compile error. `class=` on `column`, `row`, `text` and
`button`, `attr` / `attr_live` on the last node, and `input` / `checkbox`
bound to signals cover attributes and forms.

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
| library tests (node) | `hd test` |
| provider tests | `node --test providers/dom.test.mjs` |
| the counter under Node, three scripted clicks | `cd examples/counter && UI_CLICKS=2,2,1 hd run --engine node` |
| the todos demo under Node | `cd examples/todos && UI_CLICKS=1,8=milk,10 hd run --engine node` (toggle, type "milk" and press Enter, reverse) |
| the fetcher demo under Node (a resource with a delayed loader) | `cd examples/fetcher && UI_CLICKS=2,2 hd run --engine node` |
| the browser pages | `./web/build.sh`, then serve `web/` (for example `python3 -m http.server -d web 8765`) and open `index.html` or `todos.html` |

## Layout

- `src/keys.hd` ids, the `Track`/`Mutate`/`Ui` traits and their providers
- `src/graph.hd` the program-wide dependency graph and owner tree
- `src/reactive.hd` `signal`, `memo`, `effect`, `sync`, `batch`, `untrack`
- `src/owner.hd` `root`, `owned`, `on_cleanup`; `src/context.hd` `given`, `use_given` (typed), `provide`, `use_context` (owner tree)
- `src/builders.hd` `column`, `row`, `text`, `text_live`, `button`, `show`, `attr`, `attr_live`, `last_node`; `src/collections.hd` `for_each`; `src/inputs.hd` `input`, `checkbox`, `on`
- `src/resource.hd` `resource` and `resource_with`: a value loaded by a `fn!` whenever a tracked key changes, on a worker task, optionally under a `std.task` policy
- `src/surface.hd` `DomCommand`, `UiEvent`, the `@host Surface` trait; `src/runtime.hd` `mount`, `dispatch`, `run_app!`, `run_jobs!`
- `src/recorder.hd` an hd `Surface` fake for tests
- `providers/dom.mjs` the one provider: real DOM in a browser, a printing in-memory tree elsewhere; `providers/dom.test.mjs` its Node test
- `examples/counter`, `examples/todos`, `examples/fetcher`, `web/` (pages share `web/style.css`)
