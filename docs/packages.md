# Package layout

Status: design, 2026-11-02. Splits the one `ui` package into a workspace
of layered packages along the three layers of `rendering.md`, using hd's
module system (`spec/lang/10-modules.md`: workspaces, path requirements,
`pub use` facades, package host traits). Probed at `cf5040b4a`; section 6
lists what was checked. `roadmap.md` phase 11 does the move.

## 1. Why split

- **The layers become enforceable.** hd has no package-private visibility
  (`module.vis.no-package-private`): inside one package every helper that
  another file needs is `pub`, so `graph.hd`'s internals are as public as
  `signal`. A package boundary is the only real encapsulation hd offers,
  and `module.package.public-surface` makes it a checked rule.
- **The core stops depending on JavaScript.** A package that declares an
  `@host` trait must map it to a provider file (`cli.host.declaration.marker-mapped`),
  and that provider runs only on JavaScript hosts
  (`cli.host.package.javascript`). Today `ui` declares `Surface`, so the
  whole library is a JavaScript-host package and nothing in it can run
  under wasmtime. With the host trait moved to the renderer package, the
  reactive core and the builders have no host trait at all and can be
  tested on both engines.
- **One host trait maps to one provider file.** A second JavaScript
  renderer (canvas, a terminal) cannot reuse `ui`'s `Surface` with a
  different provider; it needs its own trait in its own package. That is
  React's shape anyway: `react` plus `react-dom` or `react-native`, with
  `render` living in the renderer package.
- **Apps name what they depend on.** The capability path in an app's
  manifest is spelled with the app's own dependency key
  (`cli.cap.package.path`, probed: `"dep.dom.surface.Surface" = true`
  works, a path through a re-exporting package does not). So an app
  depends on the renderer package directly, as it imports `react-dom`
  directly.

## 2. The packages

```
hdru/
  hd.toml                  [workspace] members = ["reactive", "ui", "ui-dom", "examples/..."]
  reactive/                layer 1
  ui/                      layer 2 types and layer 3 vocabulary
  ui-dom/                  the DOM renderer: host trait, loop, provider
  examples/counter ...     apps: depend on ui and ui-dom
  web/                     browser pages for the examples
  docs/
```

| Package | Dependency key | Holds | Host trait | Engines |
| --- | --- | --- | --- | --- |
| `reactive` | `dep.reactive` | `Track`, `Mutate`, `Reactive` alias, graph, `signal`/`memo`/`effect`/`sync`/`batch`/`untrack`, owners, `on_cleanup`, `Provided`/`given` | none | node, wasmtime |
| `ui` | `dep.ui` | `Ui` key and `Scope`; the protocol types `Command`, `PropValue`, `Color`, `Size`, `UiEvent`; `Style`; builders, `show`, `for_each`, inputs, `resource`; `mount`, `dispatch`, `take_commands`, the handler and job tables; `Theme`. Re-exports `reactive` | none | node, wasmtime |
| `ui-dom` | `dep.ui_dom` | `@host trait Surface`, `run_app!` with the event loop and worker pool, `Recorder` and `scripted`, `providers/dom.mjs` | `surface.Surface` → `providers/dom.mjs` | node only |
| `examples/*` | | one app each; `[dependencies] ui, ui_dom`; `[capabilities] "dep.ui_dom.surface.Surface" = true` | | node, browser |

Later siblings, each a package with its own host trait and loop:
`ui-canvas` (JavaScript, when a second renderer is wanted), `ui-gpui` or
another native one (blocked on native package providers in hd-lang), and
`ui-kit` for components built on `ui` with no host trait.

### What moves where

From today's `src/`:

| File | Goes to | Note |
| --- | --- | --- |
| `keys.hd` | `reactive` (`Track`, `Mutate`, `Reactive`, `Collector`, `NoTrack`, `Scheduler`, ids) and `ui` (`Ui`, `Scope`, `NodeId`, `HandlerId`) | the one file that splits |
| `graph.hd`, `reactive.hd`, `owner.hd`, `context.hd` | `reactive` | `context.hd`'s `Provided`/`given` are pure requirement-key code; the owner-tree `provide`/`use_context` go with them |
| `surface.hd` | `ui` keeps `Command`, `PropValue`, `Color`, `Size`, `UiEvent`; `ui-dom` gets the `@host trait Surface` | the trait is four lines; the types are the protocol |
| `builders.hd`, `collections.hd`, `inputs.hd`, `resource.hd` | `ui` | unchanged except imports |
| `runtime.hd` | `ui` keeps `emit`, `create_node`, handlers, jobs, `mount`, `dispatch`, `take_commands`, `run_job!`, `reset_for_test`; `ui-dom` gets `send!`, `event_loop!`, `worker!`, `run_app!` | the suspending glue is the renderer's; everything synchronous stays in the core |
| `recorder.hd` | `ui-dom` | it implements `ui-dom`'s `Surface` |
| `providers/dom.mjs`, `providers/dom.test.mjs` | `ui-dom/providers/` | `cli.host.package.provider-containment`: the provider file must live inside its declaring package |
| `tests/*.hd` | by subject: `core`, `context`, `rows` → `reactive`; `builders`, `show`, `for_each`, `attrs`, `inputs`, `resource` → `ui`; `loop` → `ui-dom` | `resource.hd` drives jobs with `run_job!` and `take_commands` instead of `run_jobs!` under `Surface` |

### The interface the split forces out of `reactive`

`ui`'s builders create computations directly today through `graph.hd`'s
`new_computation` and `run_computation`. Across a package boundary that
needs a named low-level API in `reactive`'s `lib.hd`, which is a good
thing: it is the extension point a renderer or a third-party primitive
uses, as Solid exposes `createComputed` and `createRenderEffect`. First
cut:

```hd
# reactive/src/lib.hd, the low-level section
pub use pkg.graph.{Computation, Kind, ComputationId, OwnerId, SourceId}
pub use pkg.graph.{new_owner, dispose, new_computation, run_computation, flush}
pub use pkg.owner.{cleanup_on}   # cleanup_on(owner, action), the form builders need
```

Nothing else from `graph.hd` is exported; in particular `graph()` is not.
Every present use of `graph().owners[owner].cleanups.push(...)` in the
builders becomes `cleanup_on(owner, ...)`.

### `ui`'s facade

`ui/src/lib.hd` re-exports `reactive`'s user-facing names
(`Signal`, `ReadSignal`, `signal`, `memo`, `effect`, `sync`, `batch`,
`untrack`, `on_cleanup`, `given`, `use_given`, `Track`, `Mutate`) so an
app writes `use dep.ui.{signal, column}` and depends on `ui` alone for
building. Probed: `pub use dep.reactive.{...}` works, and a third package
can reach `reactive`'s types through `ui`'s re-export. An app that also
wants the low-level API adds `reactive` as its own dependency; `ui` does
not re-export it.

## 3. Manifests

```toml
# hdru/hd.toml
[workspace]
members = ["reactive", "ui", "ui-dom", "examples/counter", "examples/todos", "examples/fetcher"]
```

```toml
# ui/hd.toml
[package]
name = "ui"

[dependencies]
reactive = { path = "../reactive", version = "0.1.0" }
```

```toml
# ui-dom/hd.toml
[package]
name = "ui-dom"

[dependencies]
ui = { path = "../ui", version = "0.1.0" }

[host]
"surface.Surface" = "providers/dom.mjs"
```

```toml
# examples/counter/hd.toml
[package]
name = "counter"

[dependencies]
ui = { path = "../../ui", version = "0.1.0" }
ui-dom = { path = "../../ui-dom", version = "0.1.0" }

[capabilities]
"dep.ui_dom.surface.Surface" = true
```

- Path requirements carry a `version` so a tagged release needs no
  manifest edit (`module.version.no-bare-path-release`,
  `module.workspace.path-version`). Locally the path wins; in a fetched
  copy the version does.
- Tags are per package directory: `reactive/v0.1.0`, `ui/v0.1.0`,
  `ui-dom/v0.1.0` (`module.version.tag-prefix`). The three move together
  at first; they can diverge once `reactive` is stable.
- A dependency key with `-` is spelled with `_` in source and in
  capability paths: `ui-dom` is `dep.ui_dom`.
- One `hd.sum` at the root, empty while every dependency is a path.
- The examples are members so `hd test` at the root runs everything and
  `hd run -p counter counter` works from anywhere in the tree.

## 4. Commands after the split

| What | Command |
| --- | --- |
| everything | `hd test` at the root |
| one package | `hd test -p reactive` |
| the core on wasmtime, once that engine is built | `hd test -p reactive --engine wasmtime`, same for `ui` |
| an example under Node | `cd examples/counter && UI_CLICKS=2,2,1 hd run --engine node` |
| the browser pages | `./web/build.sh`, which now takes the provider from `ui-dom/providers/dom.mjs` |

## 5. Decisions recorded

- The host trait belongs to the renderer package, not the protocol
  package. One trait, one provider file, one loop per renderer; the
  protocol types are shared through `ui`.
- `Recorder` is `ui-dom`'s test double, not the core's. Core tests use
  `mount`, `dispatch` and `take_commands`, which need no host.
- `reactive` exports a small named low-level API instead of `graph()`.
- Three packages now, not five: `Style` and the vocabulary stay inside
  `ui` until a second renderer shows which parts it does not share;
  components (`ui-kit`) start only when an example needs one.
- `web/` stays at the root because it is about the examples, not about
  `ui-dom`.

## 6. Probed (2026-11-02, `cf5040b4a`)

A four-member workspace (`reactive`, `ui`, `dom`, `app`) in the scratch
directory:

- `hd check`, `hd test`, `hd test -p ui` at the workspace root work; `hd
  run --engine node app` loads `dom/providers/dom.mjs` and prints the
  commands.
- `pub use dep.reactive.{Collector, Signal, signal, Track}` in `ui`'s
  `lib.hd` works, and `dom` uses `Collector` through `dep.ui`: a
  re-export chain across two packages resolves.
- `dom` writing `use dep.reactive.{...}` without its own requirement on
  `reactive` is `unknown-module`: transitive dependencies are not visible.
- The app's consent must be spelled with its direct key:
  `"dep.dom.surface.Surface" = true` works; naming the trait through a
  re-exporting package does not (and a re-export from `ui` of `dom`'s
  trait would be a dependency cycle anyway).
- Destructuring a tuple result is `let (v, deps) = ...`, not `(v, deps) :=`.
- Known quirk carried from today's tree: a test module that imports
  nothing from its package fails with `invalid-manifest` about the
  package's `[host]` entry (`tests/rows.hd` imports one unused name to
  avoid it). After the split only `ui-dom` has a `[host]` table, so only
  its tests can hit it. Worth an upstream issue once reproduced in
  isolation.
