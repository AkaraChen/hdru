# ui: a Solid-style reactive UI library for hd

Run-once components, signal handles, memos, effects, an owner tree, keyed
collections, and a command stream over the Wasm boundary to a small DOM
adapter. `docs/bootstrap.md` is the plan, `docs/design.md` the record of
what was built and why.

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

A `resource` loads a value with a suspending function whenever its key
changes; the load runs on one of `run_app!`'s worker tasks while the
event loop keeps serving clicks. The loader captures any provider it
needs lexically, `let clock: *mut dyn Clock = $.use(Clock)` before the
`fn!`, because its row is empty.

Tests run on the Node engine only; wasmtime is out of scope for now.

## Commands

| What | Command |
| --- | --- |
| library tests (node) | `hd test` |
| the counter under Node, three scripted clicks | `cd examples/counter && UI_CLICKS=2,2,1 hd run --engine node` |
| the todos demo under Node | `cd examples/todos && UI_CLICKS=1,7,2 hd run --engine node` |
| the fetcher demo under Node (a resource with a delayed loader) | `cd examples/fetcher && UI_CLICKS=2,2 hd run --engine node` |
| the browser pages | `./web/build.sh`, then serve `web/` (for example `python3 -m http.server -d web 8765`) and open `index.html` or `todos.html` |

`hd` comes from the sibling `../hd-lang` checkout (`cargo install --path
crates/hd_cli`, or `~/.cargo/bin/hd`); `web/build.sh` also needs `pnpm`
for esbuild.

## Layout

- `src/keys.hd` ids, the `Track`/`Mutate`/`Ui` traits and their providers
- `src/graph.hd` the program-wide dependency graph and owner tree
- `src/reactive.hd` `signal`, `memo`, `effect`, `sync`, `batch`, `untrack`
- `src/owner.hd` `root`, `owned`, `on_cleanup`; `src/context.hd` `provide`, `use_context`
- `src/builders.hd` `column`, `row`, `text`, `text_live`, `button`, `show`; `src/collections.hd` `for_each`
- `src/resource.hd` `resource`: a value loaded by a `fn!` whenever a tracked key changes, on a worker task
- `src/surface.hd` `DomCommand`, `UiEvent`, the `@host Surface` trait; `src/runtime.hd` `mount`, `dispatch`, `run_app!`, `run_jobs!`
- `src/recorder.hd` an hd `Surface` fake for tests
- `providers/dom.mjs` the one provider: real DOM in a browser, a printing in-memory tree elsewhere
- `examples/counter`, `examples/todos`, `examples/fetcher`, `web/`
