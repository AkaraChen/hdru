# Packages

The workspace and why it is split this way. It uses hd's module system
(`spec/lang/10-modules.md`: workspaces, path requirements, `pub use` facades, package host
traits).

```
hdru/
  hd.toml      [workspace]
  reactive/    layer 1: signals, owners, context
  ui/          layer 2 types and layer 3 vocabulary
  ui-dom/      the DOM renderer: host trait, loop, provider
  ui-tui/      the terminal renderer: the same shape on Node
  examples/    counter, todos, fetcher: apps on either renderer
  web/         browser pages for the examples
  docs/
```

## Why split

- **The layers are enforceable.** hd has no package-private visibility
  (`module.vis.no-package-private`): inside one package, every helper another file needs is
  `pub`. A package boundary is the only real encapsulation hd offers.
- **The core does not depend on JavaScript.** A package declaring an `@host` trait must map it
  to a provider file, and that provider runs only on JavaScript hosts. With the host trait in
  the renderer package, `reactive` and `ui` have none.
- **One host trait maps to one provider file,** so a second renderer needs its own trait in its
  own package. This is React's shape: `react` plus `react-dom` or `react-native`. The terminal
  renderer came exactly this way, with no change in `reactive` or `ui`.
- **Apps name what they depend on.** The capability path is spelled with the app's own dependency
  key (`cli.cap.package.path`), and a path through a re-exporting package does not work. So an app
  depends on the renderer directly.

## The packages

| Package | Key | Holds | Host trait |
| --- | --- | --- | --- |
| `reactive` | `dep.reactive` | the `Owner`, `Track` and `Mutate` keys and the `Reactive` alias, the graph, `signal`, `memo`, `effect`, `sync`, `batch`, `untrack`, owners (`root`, `owned`, `on_cleanup`), `given`/`use_given`, `provide`/`use_context` | none |
| `ui` | `dep.ui` | the `Parent` key and `type Ui = $ Owner + Parent`; `Command`, `PropValue`, `Color`, `Size`, `UiEvent`; `Style`; `Theme`; builders, `show`, `for_each`, inputs, `resource`; `mount`, `dispatch`, `take_commands`, `run_job!`. Re-exports `reactive`'s user-facing names | none |
| `ui-dom` | `dep.ui_dom` | `surface.hd` (`@host trait Surface`), `app.hd` (`run_app!`), `recorder.hd` (`Recorder`, `scripted`), `providers/dom.mjs` and its Node test | `surface.Surface` → `providers/dom.mjs` |
| `ui-tui` | `dep.ui_tui` | the same three files, `providers/tui.mjs` and its Node test | `surface.Surface` → `providers/tui.mjs` |
| `examples/*` | | an app in `src/lib.hd`, with entries `src/main.hd` (DOM) and `src/tui.hd` (terminal) | |

A renderer's `app.hd` and `recorder.hd` are per-renderer on purpose: the loop is the suspending glue, and the
recorder implements that package's trait. `Recorder` is not the core's: core tests use `mount`, `dispatch` and
`take_commands`, which need no host.

### `reactive`'s low-level API

Builders create computations directly, and across a package boundary that needs a named API. It is the extension
point a renderer or third-party primitive uses, as Solid exposes `createComputed`. `graph()` itself is not exported.

```hd
pub use pkg.graph.{
    Computation, Kind, State,
    cleanup_on, dispose, flush,
    new_computation, new_owner,
    reset_graph_for_test,
    run_computation, run_effect,
}
```

### `ui`'s facade

`ui/src/lib.hd` re-exports `reactive`'s user-facing names, so an app writes `use dep.ui.{signal, column}` and depends
on `ui` alone for building. An app that wants the low-level API adds `reactive` as its own dependency. Transitive
dependencies are not visible: `use dep.reactive` without a direct requirement is `unknown-module`.

## Manifests

```toml
# hd.toml
[workspace]
members = ["reactive", "ui", "ui-dom", "ui-tui", "examples/counter", "examples/todos", "examples/fetcher"]
```

```toml
# ui-tui/hd.toml
[package]
name = "ui-tui"

[dependencies]
ui = { path = "../ui", version = "0.1.0" }

[host]
"surface.Surface" = "providers/tui.mjs"

[dev-capabilities]
Clock = true
```

```toml
# examples/counter/hd.toml
[package]
name = "counter"

[dependencies]
ui = { path = "../../ui", version = "0.1.0" }
ui-dom = { path = "../../ui-dom", version = "0.1.0" }
ui-tui = { path = "../../ui-tui", version = "0.1.0" }

[capabilities]
"dep.ui_dom.surface.Surface" = true
"dep.ui_tui.surface.Surface" = true

[[executable]]
name = "counter"
module = "main"

[[executable]]
name = "counter-tui"
module = "tui"
```

- **An app may consent to several renderers.** `hd` binds only the host trait the entry's row names
  (`cli.host.entry-binding`), so `counter-tui` never loads `dom.mjs`. The app lives in `src/lib.hd` because an entry
  module cannot be imported (`cli.exe.entry-no-use`). With two executables `hd run` needs the name
  (`cli.run.default.one`).
- **Path requirements carry a `version`,** so a tagged release needs no manifest edit
  (`module.version.no-bare-path-release`). `[package]` takes no `version` key, because the tag is the only version
  (`module.version.tag-only`). Tags are per package directory: `ui-tui/v0.1.0`.
- **A key with `-` is spelled with `_`** in source and in capability paths: `ui-tui` is `dep.ui_tui`.
- **`[dev-capabilities]`** gives tests a real `Clock`: `ui` for `tests/policy.hd`, whose timeout must really wait, and
  each renderer for its loop tests.
- **A test file that imports nothing from a host-mapped package fails** (hd-lang#1190), so it imports one name.
- The examples are workspace members, so `hd test` at the root runs everything.

## Commands

| What | Command |
| --- | --- |
| everything | `hd test` at the root |
| one package | `hd test -p reactive` (or `ui`, `ui-dom`, `ui-tui`) |
| provider tests | `node --test ui-dom/providers/dom.test.mjs ui-tui/providers/tui.test.mjs` |
| an app in the terminal | `hd run -p counter counter-tui`, from anywhere in the tree |
| an app under Node, DOM provider | `cd examples/counter && UI_CLICKS=2,2,1 hd run counter --engine node` |
| the browser pages | `./web/build.sh`, which takes the provider from `ui-dom/providers/dom.mjs` |
