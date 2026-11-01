# Package layout

Status: design, 2026-11-02; implemented the same day as roadmap phase 11
(commit `81b6755`), with the deviations in section 7 and their reasons in
`design.md`. Splits the one `ui` package into a workspace of layered
packages along the three layers of `rendering.md`, using hd's module
system (`spec/lang/10-modules.md`: workspaces, path requirements,
`pub use` facades, package host traits). Probed at `cf5040b4a`; section 6
lists what was checked.

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
| `reactive` | `dep.reactive` | the `Owner`, `Track`, `Mutate` keys and the `Reactive` alias, graph, `signal`/`memo`/`effect`/`sync`/`batch`/`untrack`, owners (`root`, `owned`, `on_cleanup`), `Provided`/`given` and the owner-tree `provide`/`use_context` | none | node, wasmtime |
| `ui` | `dep.ui` | the `Parent` key, `Scope`, and the row alias `type Ui = $ Owner + Parent`; the protocol types `Command`, `PropValue`, `Color`, `Size`, `UiEvent` (`protocol.hd`); `Style` (`style.hd`); `Theme` (`theme.hd`); builders, `show`, `for_each`, inputs, `resource`; `mount`, `dispatch`, `take_commands`, `run_job!`, the handler and job tables. Re-exports `reactive`'s user-facing names | none | node, wasmtime |
| `ui-dom` | `dep.ui_dom` | `surface.hd` (`@host trait Surface`), `app.hd` (`run_app!` with the event loop and worker pool), `recorder.hd` (`Recorder`, `scripted`), `providers/dom.mjs` and its Node test | `surface.Surface` → `providers/dom.mjs` | node only |
| `examples/*` | | one app each; `[dependencies] ui, ui_dom`; `[capabilities] "dep.ui_dom.surface.Surface" = true` | | node, browser |

Later siblings, each a package with its own host trait and loop:
`ui-canvas` (JavaScript, when a second renderer is wanted), `ui-gpui` or
another native one (blocked on native package providers in hd-lang), and
`ui-kit` for components built on `ui` with no host trait.

### What moves where

From today's `src/`:

| File | Goes to | Note |
| --- | --- | --- |
| `keys.hd` | `reactive` (`Owner`, `Track`, `Mutate`, `Reactive`, `Collector`, `NoTrack`, `Scheduler`, ids) and `ui` (`Parent`, `Scope`, `NodeId`, `HandlerId`, `type Ui = $ Owner + Parent`) | the one file that splits; see "The `Ui` alias" below |
| `graph.hd`, `reactive.hd`, `owner.hd`, `context.hd` | `reactive` | `context.hd`'s `Provided`/`given` are pure requirement-key code; the owner-tree `provide`/`use_context` go with them |
| `surface.hd` | `ui` keeps `Command`, `PropValue`, `Color`, `Size`, `UiEvent`; `ui-dom` gets the `@host trait Surface` | the trait is four lines; the types are the protocol |
| `builders.hd`, `collections.hd`, `inputs.hd`, `resource.hd` | `ui` | unchanged except imports |
| `runtime.hd` | `ui` keeps `emit`, `create_node`, handlers, jobs, `mount`, `dispatch`, `take_commands`, `run_job!`, `reset_for_test`; `ui-dom` gets `send!`, `event_loop!`, `worker!`, `run_app!` | the suspending glue is the renderer's; everything synchronous stays in the core |
| `recorder.hd` | `ui-dom` | it implements `ui-dom`'s `Surface` |
| `providers/dom.mjs`, `providers/dom.test.mjs` | `ui-dom/providers/` | `cli.host.package.provider-containment`: the provider file must live inside its declaring package |
| `tests/*.hd` | by subject: `core`, `rows` → `reactive`; `context`, `builders`, `show`, `for_each`, `style`, `inputs`, `resource`, `policy`, `mutate` → `ui`; `loop` → `ui-dom` | `context.hd` mounts builders, so it is `ui`'s; `resource.hd` drives jobs with `run_job!` and `take_commands` instead of `run_jobs!` under `Surface`; the two `run_app!` cases live in `ui-dom/tests/loop.hd` |

### The `Ui` alias

`memo`, `effect`, `on_cleanup`, `provide` and `resource` need the current
owner, and the builders need the current parent node. The owner is a
`reactive` concept and the node a `ui` one, so the one `Ui` trait became
two keys and a row alias: `reactive` declares `trait Owner` (`fn owner`),
`ui` declares `trait Parent` (`fn parent`) and `type Ui = $ Owner + Parent`
(`req.row.alias`). Every `$ Ui` row in user code is unchanged. Inside the
library, `$.use(Ui)` is gone, since an alias is not a key
(`req.row.alias.type-or-key`): the reactive primitives write
`$.use(Owner).owner()`, the builders `$.use(Parent).parent()`. Containers
re-install only `Parent`; `owned` and `root` only `Owner`, through the
provider `OwnedBy`. The graph's record struct was renamed `OwnerRecord`
so the trait can be `Owner`.

### The interface the split forces out of `reactive`

`ui`'s builders create computations directly today through `graph.hd`'s
`new_computation` and `run_computation`. Across a package boundary that
needs a named low-level API in `reactive`'s `lib.hd`, which is a good
thing: it is the extension point a renderer or a third-party primitive
uses, as Solid exposes `createComputed` and `createRenderEffect`. First
cut:

```hd
# reactive/src/lib.hd, the low-level section (as built)
pub use pkg.graph.{
    Computation, Kind, State,
    cleanup_on, dispose, flush,
    new_computation, new_owner,
    reset_graph_for_test,
    run_computation, run_effect,
}
```

Nothing else from `graph.hd` is exported; in particular `graph()` is not.
Every former `graph().owners[owner].cleanups.push(...)` in the builders is
`cleanup_on(owner, ...)`.

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
  copy the version does. `[package]` itself takes no `version` key (the
  tag is the only version, `module.version.tag-only`), so only the
  requirements name one.
- `ui` and `ui-dom` carry `[dev-capabilities] Clock = true`: `ui` for
  `tests/policy.hd`, whose timeout must really wait, and `ui-dom` for its
  loop tests.
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

See also section 7 for what the implementation changed.

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

## 7. Deviations in the implementation (commit `81b6755`)

Recorded with their reasons in `design.md`, phase 11:

- `Ui` is a row alias over two keys, `Owner` in `reactive` and `Parent`
  in `ui` (section 2, "The `Ui` alias"). The design had one trait in `ui`.
- `tests/context.hd` lives in `ui`, not `reactive`: its cases mount
  builders.
- The `run_app!` cases are `ui-dom/tests/loop.hd`.
- `[package]` rejects a `version` key; only path requirements carry one.
- `reactive`'s low-level export list is the one in section 2, with
  `State`, `run_effect` and `reset_graph_for_test` added for `ui`'s
  runtime and tests.
