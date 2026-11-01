# Bootstrap plan: a Solid-style reactive UI library for hd

Status: implementation plan, 2026-11-01; phases 0 to 7 were implemented
the same day and phase 8 on 2026-11-02 (see `design.md` for what each
phase actually became and the `Outcome` column below). The wasmtime
engine is out of scope for now: this `hd` build has none, and every gate
runs on the Node engine. Derived from the review doc
"A Solid-style reactive UI for hd: review and counter-proposal" (the
"review" below) and checked against the `hd-lang` checkout at commit
`cf5040b4a` (2026-11-01), which lives beside this repo at `../hd-lang`.

This repo (`hdru`) is empty today. The plan below turns it into one hd
library package named `ui`, with a JavaScript provider for its host trait,
a Node test harness, and one browser demo. Nothing in the plan needs a
language change; every mechanism it uses is a rule the spec already states.

## 1. What is being built

A fine-grained reactive UI library in the shape Solid uses: run-once
components, explicit signal handles, memos, effects, an owner tree for
disposal, keyed collections, and a command stream over the Wasm boundary to
a small DOM adapter. The review's API is adopted as written, with these
additions it argued for over the original proposal:

- a second requirement key, `Mutate`, so a write inside a memo is a
  compile error, not a runtime check;
- `effect:`, `batch:`, `untrack`, `on_cleanup:`, and an owner-tree context
  (`provide` / `use_context`);
- `for_each` takes `ReadSignal[List[T]]` rather than an accessor closure;
- three runtime rules that hd forces: erase every retained callback into a
  concrete `fn` closure (there is no `dyn Fn`), never hold a reference into
  the graph while user code runs (run-time borrow checks), and keep `Track`
  out of every loader's row (a `fn!` binds providers at construction).

### 1.1 Corrections to the review found against the repo

Three facts in the checkout change the review's phase order and its
boundary story. They do not change the API.

| Review says | Checkout says | Consequence |
| --- | --- | --- |
| Ship the push loop first: register `dispatch(event) -> List[DomCommand]` as a boundary function. | `module.register.explicit`: registration is "provided by its library", and `docs/future-work/HOST_EMBEDDING.md` states "a general export registration API needs its own approved design". No such API exists. | The pull loop (`main!` looping on `Surface.next_event!`) is the only boundary available. It comes first. The sync core is still tested with no boundary at all. |
| The JavaScript adapter sits beside the playground. | `cli.host.package.javascript`: package providers run only on JavaScript hosts; `host/web.ts` and `website/playground` bind no package runtime, while `host/core-package.ts` and `host/package-providers.ts` are platform-neutral. | Day-one host is `hd run --engine node` with a fake DOM. The browser demo is a standalone page over `host/core.ts` plus the generated `NAME.host.mjs`, not a playground change. Wasmtime cannot run the app (`cli.host.package.native-refusal`); it can run the library tests. |
| `Cell[T]` holds a signal's value. | `Cell[T]` appears in the spec only as an example in chapters 04 and 05; `lib/std` declares no such type. | The library declares its own `Slot[T]` (name chosen to avoid the spec example), boxed to `*mut Slot[T]`. |

## 2. Layout of this repo

```
hdru/
  hd.toml                 [package] name = "ui"; [host] "surface.Surface" = "providers/dom.mjs"
  src/
    lib.hd                re-exports the public API
    keys.hd               SourceId/ComputationId/OwnerId; Track, Mutate, Ui traits; Collector, NoTrack, Scheduler, Scope
    graph.hd              the program-wide Graph: sources, computations, owners; mark/ensure_fresh/run/flush/dispose
    reactive.hd           Slot, Signal, ReadSignal, signal, memo, effect, sync, batch, untrack
    owner.hd              root, under, on_cleanup, current_owner
    builders.hd           Ui builder methods, column, row, text, text_live, button, show
    collections.hd        for_each and its keyed reconciler
    surface.hd            NodeId, NodeKind, DomCommand, UiEvent, @host Surface
    runtime.hd            mount, dispatch; the main! event loop helper (run_app!)
    recorder.hd           Recorder: an hd Surface fake that logs commands (pub, used by tests and apps)
  providers/
    dom.mjs               the browser provider: node table, listeners, a switch over DomCommand
    fake-dom.mjs          a Node provider over an in-memory tree, for hd run --engine node
  tests/
    core.hd               signals, memos, scheduler order, diamond and conditional dependencies
    builders.hd           command lists from mounting and clicking, via Recorder
    show.hd               disposal and state retention
    for_each.hd           identity, moves, per-row updates
    effects.hd            effect, batch, untrack, on_cleanup, context
    loop.hd               run_app! against a scripted Surface
  examples/
    counter/              hd.toml depends on ui by path; src/main.hd is the review's counter
    todos/                for_each demo
  web/
    index.html, main.js   the browser demo page (phase 7)
  docs/
    bootstrap.md          this plan
    design.md             the design record, written at the end of phase 2
```

Conventions, taken from `../hd-lang/AGENTS.md` and its `write-hd` and
`hd-cli` skills: every `.hd` file is written on a full-capacity model, each
compiler mistake made along the way is logged in
`../hd-lang/docs/audit/hd-writing-log.md`, and `hd check` runs after every
edit. The `hd` binary is at `~/.cargo/bin/hd` (built from the sibling
checkout, Node engine by default).

## 3. Phases

Each phase ends with its tests green under `hd test` (Node engine) and, for
phases 0 to 5, under `hd test --engine wasmtime` too, since nothing there
needs a JavaScript host.

### Phase 0: toolchain spike (half a day)

Goal: prove each compile-time claim the design rests on before writing any
library code. Each probe is one file under `spikes/` that `hd check` must
accept or reject exactly as predicted, then the folder is deleted.

| Probe | Must | Spec rule |
| --- | --- | --- |
| A method `fn get(self) -> T $ Track` on `impl[T < 'static] Signal[T]`, and a `'static` bound on a struct type parameter | compile | `ref.generic.static.bound-only`, `req.row` |
| A trailing block on `memo:` whose body calls `count.get()`, with bound `F < 'static & Fn() -> T $ Track` | compile | `fn.trailing.fn-bound` |
| The same block calling `count.set(0)` | fail with `type-mismatch` | `req.row.subsume.missing` |
| An eager `count.get()` in a `column:` block bounded by `Fn() -> void $ Ui` | fail with `type-mismatch` | same |
| `let erased: fn() -> string $ Track = fn() -> string $ Track: compute()` stored in a struct field, and the struct pushed into a `List` inside a `*mut` graph | compile | `ref.generic.outlives.written` |
| An `FnMut` handler with a mutating capture, erased the same way | compile | `fn.trait.read-only` |
| A trailing block on `effect:` bounded by `FnMut() -> void $ Track + Mutate` | compile | `fn.trailing.fn-bound` |
| `$.with(Track=collector)` where `collector: *mut Collector` and `Track` has `&mut self` methods | compile; `$.with(Track=*Collector)` fails with `mutable-upgrade` | `req.mut.install-writable-counted` |
| A nested `$.with(Track=...)` inside a callback whose row keeps `Track` uses the inner provider | run and assert | `req.with.nearest.forced` |
| `fn batch[F < FnMut() -> void $ Mutate](body: F) -> void $ Mutate` that installs a different `Mutate` for the body | compile | `req.with` |
| An `@host pub trait Surface` with `apply!` and `next_event!`, mapped in `hd.toml`, and an hd struct implementing it bound via `$.with` in a `tests:` block | compile and run on both engines | `module.host.package.fake` |
| A doc test with `# error: type-mismatch` | pass under `hd test` | `module.test.doc.compile-fail` |

Exit: a short table in `docs/design.md` recording which probes passed on
the first try and which needed a rewrite, so the library's signatures start
from known-good forms.

### Phase 1: reactive core, no UI (2 days)

Files: `signal.hd`, `track.hd`, `graph.hd`, `memo.hd` (memo only),
`tests/core.hd`.

- `Slot[T]` holds `value: T`, `id: SourceId`. `Signal[T]` is a copyable
  handle holding `*mut Slot[T]` plus `*mut Graph`. `ReadSignal[T]` wraps the
  same and exposes `get`/`peek`.
- `Graph` (one per program, boxed) holds: for each `SourceId` its observer
  list, for each `ComputationId` its dependency list, the stored
  `Computation { run: fn() -> void $ Track }`, dirty flags, and a
  topological height so recomputation runs in dependency order.
- `Track` provider: `Collector { current: ComputationId?, deps: List[SourceId] }`,
  one boxed instance reused and reset per evaluation.
- `Mutate` provider: `Scheduler { graph: *mut Graph, queue: List[SourceId], depth: i32 }`.
  `invalidate` marks observers dirty and, at depth 0, flushes: memos first
  by height, then effects. `batch` raises depth, runs the body, lowers it,
  flushes once.
- `memo` requires `T < Eq`; a recompute that yields an equal value marks no
  observer dirty.
- Aliasing rules, enforced by code review and one test each: copy a slot's
  value out before calling user code; copy an observer list before walking
  it; never keep a `&`/`&mut` into `Graph` across a call into a closure.

Tests: set/get round trip; memo recomputes once per change; a diamond
(`a -> b, c -> d`) recomputes `d` once; a conditional dependency drops a
source when the branch no longer reads it; `batch` of two sets flushes once;
equal-value suppression; a subscribe from inside a running computation does
not panic (`borrow-conflict`). Two compile-fail doc tests: eager `get()` in
a `Fn() -> void $ Ui` block, and `set()` inside `memo:`.

### Phase 2: owners and four builders with a recording Surface (2 days)

Files: `owner.hd`, `builders.hd` (column, row, text, text_live, button),
`surface.hd`, `recorder.hd`, `runtime.hd` (mount, dispatch, flush only),
`tests/builders.hd`.

- `Owner` holds computations, handler ids, child owners, cleanups. Disposal
  is recursive and unsubscribes every computation from the graph.
- `Ui` provider: `Builder { owner: OwnerId, parent: NodeId, out: List[DomCommand], graph, scheduler }`.
  Every builder reads `$.use(Ui)` into a local and never captures it.
- `text_live` erases its callback and retains a `TextBinding`; the runtime
  later runs it under its own `$.with(Track=collector)` and emits `SetText`.
- `button` erases an `FnMut` handler into `HandlerId -> fn() -> void $ Mutate`;
  `dispatch(event)` looks it up and runs it under `$.with(Mutate=scheduler)`.
- `Recorder` implements `Surface` in hd: `apply!` appends to a list,
  `next_event!` pops a scripted queue. It is `pub` so apps can test with it.

Tests assert exact command lists: mounting the counter emits N `Create`,
N-1 `Append`, one `Listen` per button; one click emits exactly one
`SetText`; a second click with the same text emits nothing. Exit: write
`docs/design.md` sections for the core and the owner tree.

### Phase 3: `show` (1 day)

Condition is a boolean memo; its change mounts the branch under a fresh
child owner (with `Ui` and `Mutate` installed by the runtime) or disposes it;
a repeat does nothing. Tests: a nested counter inside a toggled branch loses
its state on hide and keeps it on an unrelated update; the hidden branch's
bindings no longer run.

### Phase 4: `for_each` (2 days)

Keyed reconciler over `ReadSignal[List[T]]`: reads the list once per
reconciliation, keeps `Map[K, Row]` where `Row { owner, signal: Signal[T], first_node }`.
Persisting key: `row.signal.set(item)` under the runtime's `Mutate`. New
key: mount under a child owner. Missing key: dispose. Order changes emit
`MoveBefore`. Tests: replacing a `Todo` with the same id and new title keeps
the row's nodes and emits one `SetText`; a reorder emits only `MoveBefore`;
a removal emits `Remove` and runs the row's cleanups.

### Phase 5: effects, batching, cleanup, context (1 day)

`effect` (tracked, may write, runs after memos settle), `on_cleanup`,
`untrack` (a `NoTrack` provider), `batch` (done in phase 1, re-tested with
effects), and the owner-tree context: `provide[T < 'static](value: T)` on
the current owner and `use_context[T]() -> T?` walking up. The three
app-level context answers from the review go into `docs/design.md`, with
lexical capture (`theme := $.use(Theme)` before the block) as the
recommended one and `provide`/`use_context` as the library fallback.

### Phase 6: the host trait and the Node loop (2 days)

- `run_app![F < Fn() -> void $ Ui](root: F) -> void $ Surface`: mounts, sends
  the initial command list through `apply!`, then loops `next_event!` →
  `dispatch` → `flush` → `apply!`. Every provider the loop installs is a
  local; nothing from `$ Surface` is captured.
- `providers/fake-dom.mjs`: an in-memory node tree that applies commands and
  exposes `click(nodeId)`; `next_event!` returns a Promise that the test
  harness resolves (`cli.host.package.completion-forms`).
- `examples/counter` runs with `hd run --engine node` and its
  `tests/counter.hd` drives it through `Recorder`, so the hd side needs no
  JavaScript to test. A Node test file (`node --test`) drives
  `fake-dom.mjs` through the generated `.host.mjs`, after the pattern of
  `../hd-lang/packages/server-sdk/test/application.test.ts`.

Exit: `hd run --engine node` in `examples/counter` prints the command stream
of a scripted click sequence.

### Phase 7: the browser page (1 day)

`web/main.js` imports `../hd-lang/host/core.ts`'s `createCoreHost`,
`host/package-providers.ts`, the built `counter.wasm` and `counter.host.mjs`,
and binds `providers/dom.mjs`. The page runs the program on the main
thread, so `apply!` touches the DOM directly and `next_event!` resolves from
`addEventListener`. The adapter is a node-id table and a `switch` over the
seven commands. Exit: the counter and the todos demos run in a browser; one
click produces one `SetText` in the console log.

### Phase 8: resources and cancellation (deferred, after a design note)

`resource[T, E](key: fn() -> K $ Track, load: fn!(K) -> Result[T, E])`: the
key is read synchronously under `Track`, the loader is constructed with a
row that excludes `Track`, and its result lands through a signal under
`Mutate`. A disposed owner cancels its pending suspensions with `cancel!`.
This phase needs the pull loop's driver to interleave `next_event!` with
loader completions (`all!` / `race!`), so it waits until phase 6 has
shown what the loop looks like with one suspending source.

## 4. Schedule and gates

| Phase | Days | Gate | Outcome (2026-11-01) |
| --- | --- | --- | --- |
| 0 spike | 0.5 | every probe matches its prediction | done; 2 predictions wrong on the error code, 3 rules learned (design.md) |
| 1 core | 2 | core tests green on node and wasmtime; two compile-fail doc tests pass | done on node (this build has no wasmtime); 11 cases + 2 doc tests |
| 2 owners + builders | 2 | command-list tests green; `docs/design.md` started | done; `effect`/`sync` split, `Clear` command added |
| 3 show | 1 | disposal tests green | done first try |
| 4 for_each | 2 | identity and move tests green | done first try |
| 5 effects + context | 1 | effect ordering and cleanup tests green | done; `use_context` returns a copy, `owned` added |
| 6 host trait + Node | 2 | `hd run --engine node` counter works | done; one provider file for both hosts |
| 7 browser | 1 | both demos run in a browser | done; verified by clicking in a real browser |
| 8 resources | later | design note approved first | done 2026-11-02; loaders run on a worker pool under `all!`, cancellation drops stale results instead of cancelling in-flight loads (design.md) |

Eleven and a half working days to a browser demo, with the library usable
from phase 2 on. Phases 3, 4 and 5 are independent of each other and can run
in parallel once phase 2 lands.

## 5. Risks and how each is retired

- A signature form the checker rejects (rows on `self` methods, `fn` types
  with rows in struct fields, `'static & FnMut` conjunctions). Phase 0
  exists to find these before they are load-bearing; a rewrite there costs
  an hour, in phase 2 it costs a day.
- A `borrow-conflict` panic from the runtime holding a loan into the graph
  during a callback. Every graph walk copies its list out first; phase 1
  has a test that subscribes from inside a running memo.
- Provider capture by accident: a builder that stores `$.use(Ui)` fails with
  `local-reference-escapes`, which is the right outcome; the fix is always to
  erase the callback and let the runtime re-install `Ui` at mount time.
- The pull loop's `next_event!` and a future loader both suspending in one
  `main!`: unproven until phase 8, which is why resources are deferred.
- `hd` toolchain drift: the sibling checkout moves daily. Pin the commit
  this plan was checked against (`cf5040b4a`) in `docs/design.md`, and
  rebuild `hd` only at phase boundaries.

## 6. Out of scope for the bootstrap

A `view!`-style macro (hd has no macros; trailing blocks cover it), a
virtual DOM, server rendering, routing, styling beyond `SetAttr`, and the
playground integration. The push-loop boundary stays out until hd ships an
export registration API; when it does, `dispatch` in `runtime.hd` is already
the function to register.

## 7. Sources

- The review doc: https://claude.ai/artifact/55PkPDs76WoyZZFixPstmE
- `../hd-lang/spec/lang/07-functions.md` (trailing blocks, closure bounds, capture rules)
- `../hd-lang/spec/lang/10-modules.md` (package host traits, boundary values, registration, doc tests)
- `../hd-lang/spec/lang/11-requirements-and-suspension.md` (rows, `$.with`, nearest provider, mutable requirements, construction-time binding)
- `../hd-lang/spec/lang/13-values-and-references.md` (`box`, `'static`, no `dyn Fn`, run-time borrow checks)
- `../hd-lang/spec/cli/command-line.md` (package host declarations and bindings, `hd new`, build output)
- `../hd-lang/packages/server-sdk` (the model for a package-owned host trait with a JavaScript provider and an hd fake)
- `../hd-lang/host/core.ts`, `core-package.ts`, `package-providers.ts` (what a browser adapter can reuse)
- `../hd-lang/docs/future-work/HOST_EMBEDDING.md` (export registration not yet designed)
