# Design record: the `ui` package

Checked against the `hd-lang` checkout at commit `cf5040b4a` (2026-11-01).
The implementation plan is `bootstrap.md`; this file records what the code
actually does and why, phase by phase.

## Phase 0: toolchain spike (2026-11-01)

Twelve probes under a temporary `spikes/` folder, each checked with
`hd check`, run with `hd FILE`, or tested with `hd test`. The folder was
deleted after this table was written.

| Probe | Predicted | Result | First try? |
| --- | --- | --- | --- |
| Rows on `self` methods; `'static` bound on a struct type parameter; `impl[T < 'static] Signal[T]` | compile | compile, ran | yes |
| Trailing block on `memo:` with `F < 'static & Fn() -> T $ Track` | compile | compile, ran | yes |
| `count.set(0)` inside that block | `type-mismatch` | fails with `unsatisfied-trait-bound` | prediction wrong on the code |
| Eager `count.get()` in a `column:` block bounded by `Fn() -> void $ Ui` | `type-mismatch` | fails with `unsatisfied-trait-bound` | prediction wrong on the code |
| Erase `F` into `fn() -> string $ Track`, store in a struct field, push into a `List` behind `*mut`, run later | compile | compile, ran | no: a field holding a function is called as `(binding.run)()`, and a struct named by a `pub` signature must be `pub` |
| `FnMut` handler with a mutating capture, erased into `fn() -> void $ Mutate`, kept in a `Map` | compile | compile, ran | no: see the row rule below |
| Trailing block on `effect:` bounded by `FnMut() -> void $ Track + Mutate` | compile | compile, ran | yes |
| `$.with(Track=c)` with `c: *mut Collector` | compile | compile, ran | yes |
| `$.with(Track=c)` with `c: *Collector` | `mutable-upgrade` | `mutable-upgrade` | yes |
| Callee's `$.with(Track=...)` wins for a callback whose row keeps `Track`; a `$.use` capture is fixed lexically | run, assert | 2 tests pass | no: see the `Fn` value rule below |
| `batch` installs a different `Mutate` for its body and forwards to the outer one | compile | compile, ran | yes |
| `@host pub trait Surface` mapped in `hd.toml`, hd fake bound with `$.with` in `tests/` | compile, run | 2 tests pass on node | no: `pub use pkg.surface.{Surface}` needs the braces |
| Doc test with `# error: type-mismatch` | pass | pass | yes |

Three rules the probes established that the plan did not state, and that
every signature in the library now follows:

1. **A closure's row must equal the bound's row exactly.** `Fn(...) $ R`
   and `FnMut(...) $ R` bounds match a function value's exact row
   (`fn.trait.function-values`); row subsumption applies only to concrete
   `fn` types. An unannotated closure takes its row from its body, so
   `button("x", fn(): pass)` fails against `FnMut() -> void $ Mutate` and
   must be written `fn() -> void $ Mutate: pass`. A trailing block is the
   same closure and fails the same way. Consequences: a callback that uses
   another requirement (say `Console`) must capture it lexically
   (`console := $.use(Console)` before the block) rather than list it, and
   every bound in the public API lists the one row the library will
   re-install at run time, nothing more.
2. **A concrete `fn` parameter cannot be stored.** `on_click: fn() -> void $ Mutate`
   stored into a map is `local-reference-escapes` whatever the caller
   passed, because the parameter has a fresh lifetime. So every retained
   callback is a bare type parameter bounded by `'static & Fn/FnMut`, and
   the library erases it into a concrete `fn` closure of its own.
3. **An `Fn` bound takes only an inline closure or a function name.** A
   closure first bound to a variable is a plain `fn` value and implements
   only `FnMut` (`fn.trait.read-only.values`). `memo`, `text_live`, `show`
   and `for_each` therefore take their callbacks inline; `button` and
   `effect` use `FnMut` and accept either.

Smaller facts: `$.with(K=v):` is an expression and may be the right-hand
side of `:=`; a single file with a `tests:` block runs under
`hd test FILE`; this `hd` build has no wasmtime engine (`--features
wasmtime` would add it), so every gate in the plan runs on node only; the
compile-fail code for a row violation is `unsatisfied-trait-bound`.

## Phase 1: reactive core (2026-11-01)

Files: `src/keys.hd`, `src/graph.hd`, `src/reactive.hd`, `src/owner.hd`,
`tests/core.hd`. Gate: 13 cases green under `hd test` on node (11
integration cases and 2 doc tests, one of them compile-fail).

What the code does, where it departs from the plan, and why:

- **One program-wide graph.** A top-level `GRAPH := box(Graph { ... })`
  persists across calls (probed), so `signal(initial)` needs no creation
  key or graph argument, as Solid's `createSignal` needs none. Sources,
  computations and owners live in three maps keyed by one id counter.
- **Lazy memos with versions, not heights.** Each source has a version;
  each computation records `(source, version seen)`. A write bumps the
  version and marks direct observers `Dirty` and transitive observers
  `Check`; effects enter a queue when first marked. A read of a `Check`
  memo refreshes the memos it depends on and reruns only when a seen
  version moved, so a diamond's join runs once and an equal memo value
  stops propagation without a height table. This is the Reactively
  algorithm. The plan's topological height was dropped because the
  version check gives equal-value suppression for free and needs no
  ordering of the dirty set.
- **Providers never run user code.** `ref.excl.alias.call-loan` makes a
  method call through `*mut` a run-time loan for the whole call, so a
  provider method that called back into user code would panic with
  `borrow-conflict` when that code used the same provider again. `Track`
  and `Mutate` providers are therefore leaves (`Collector` records,
  `Scheduler` counts), and flushing is a free function on the graph.
  `set` flushes after its `invalidate` call returns, and a nested flush
  from inside an effect only queues. `batch` depth lives on the graph.
- **Retained callbacks are `'static` bounds, non-retained ones are
  concrete `fn` types.** `batch`, `untrack`, `root` and `under` take
  `fn(...) $ Row` parameters so a narrower closure fits by row
  subsumption; `memo`, `effect`, `sync` and `on_cleanup` take bounded type
  parameters, erase them into concrete closures, and so need the exact
  row (phase 0, rule 1).
- **`effect` and `sync`.** The review's one `effect` with row
  `$ Track + Mutate` would reject the common read-only trailing block,
  which cannot carry a row annotation. `effect` is `FnMut() -> void $ Track`
  and `sync` is `FnMut() -> void $ Track + Mutate`; both run once at
  creation and again at flush when a dependency's version moved. A block
  that reads only through `untrack` has the empty row and is written as an
  explicit closure, `effect(fn() -> void $ Track: ...)`; `tests/core.hd`
  has one.
- **`set` does not compare.** `Signal[T < 'static]` has no `Eq` bound, so
  every write marks; `memo` requires `Eq` and suppresses. Signal sources
  are never freed (no owner); memo sources are removed on dispose.
- **Computation bodies are stored as `fn() -> bool $ Track + Mutate`** and
  run under a collector plus a throwaway `Scheduler`, so a `sync` body may
  write while a memo body, bounded `$ Track`, cannot.

## Phase 2: owners, builders and the command stream (2026-11-01)

Files: `src/surface.hd`, `src/runtime.hd`, `src/builders.hd`,
`src/recorder.hd`, `tests/builders.hd`. Gate: command-list tests green
(mount order, one `SetText` per click, nothing for an equal text, nothing
for an unknown handler) plus the compile-fail doc test for an eager read
in a `column:` block.

- **`Ui` is read-only data.** The provider is `Scope { owner, parent }`;
  a container runs its children block under a fresh `Scope` whose parent
  is the new node. Everything mutable (the pending command list, the
  handler table, the node and handler counters) is a program-wide
  `Runtime` box, as the graph is, so no provider method ever runs user
  code and no builder captures a provider.
- **Command order is Create, Append, then content.** A node is attached
  before its text or children are set, so a host that applies commands
  one by one never holds a detached subtree.
- **`show` renders into a fragment node that stays put.** Hiding emits
  `Clear(fragment)` and disposes the branch owner; showing again rebuilds
  into the same fragment, so the branch keeps its place among its
  siblings. `DomCommand.Clear` was added for this; `for_each` will use the
  same fragment-per-row shape so a row has one node to move or remove.
- **Handlers take a payload.** The table holds
  `fn(string) -> void $ Mutate`; `button` ignores the payload, an input
  builder will pass the value. `register_handler` is generic with an
  erasing closure because a concrete `fn` parameter cannot be stored
  (phase 0, rule 2). A handler is dropped by a cleanup on its owner.
- **`dispatch` runs the handler inside `batch`** under a throwaway
  `Scheduler`, then flushes, so a handler that writes several signals
  produces one round of effects. Node 0 is the host's mount point; handler
  0 means stop.
- **`Recorder`** implements `Surface` in hd: `apply!` logs, `next_event!`
  pops a scripted event or returns handler 0. It is public so an app's
  own tests can drive the loop without JavaScript.

## Phase 3: `show` (2026-11-01)

`tests/show.hd`, green first try. The branch owner is a child of the
component's owner, so disposing the component disposes the branch. A
handler inside a hidden branch is gone (its owner's cleanup dropped it),
a binding inside it no longer emits, an inner signal starts over when the
branch is shown again, and an outer signal read inside the branch shows
its current value. Forcing the condition to the value it already has
reruns the `show` computation (writes do not compare) but emits nothing.

## Phase 4: `for_each` (2026-11-01)

`src/collections.hd`, `tests/for_each.hd`, green first try.

- The reconciler is one effect whose only tracked read is `items.get()`;
  rows render under `NoTrack` so a row's own bindings are separate
  computations. Each row has a child owner, a fragment node of class
  `item`, and a `Signal[T]` whose read half is what `render` receives.
- Order: the old order minus removed keys, plus new keys in creation
  order, is walked against the wanted order; at each index where they
  differ the wanted row is moved before the row currently there, so an
  append emits no move and a prepend or a reverse of two emits one.
- `render` takes a parameter, so it is an explicit closure argument, not
  a trailing block (`fn.trailing.parameterized`); the test shows the
  shape. Duplicate keys are not diagnosed: the last item wins.

## Phase 5: context and the component boundary (2026-11-01)

`src/context.hd`, `tests/context.hd`; `owned` in `src/owner.hd`.

- Context is owner-scoped, as Solid's is: `provide(key, value)` stores a
  boxed value on the current owner, `use_context::[T](key)` walks the
  owner chain. A container such as `column` makes no owner, so a
  `provide` inside one lands on the enclosing owner; `owned:` is the
  component boundary that makes a child owner (as `show` and `for_each`
  rows do) and so scopes a `provide` and the cleanups inside it.
- Values are keyed by string and recovered with `downcast_ref` on a
  `*mut dyn Inspectable`. `downcast_ref`/`downcast_mut` yield a local
  reference, so `use_context` returns a copy (`T?`). Shared state goes
  through context as a handle: a `Signal` is a declared struct and so
  inspectable; `tests/context.hd` provides one and two readers see one
  write.
- The other three app-level context answers from the review stand:
  lexical capture of a `$.use` value before a block is the cheapest, an
  app-level adapter over `root` the most explicit, and `provide` the
  library fallback.

## Phase 6: the host trait and the Node loop (2026-11-01)

`run_app!` in `src/runtime.hd`, `tests/loop.hd`, `providers/dom.mjs`,
`examples/counter`.

- `run_app!(root) $ Surface` mounts, sends the first batch through
  `apply!`, then loops on `next_event!` → `dispatch` → `apply!` until an
  event names handler 0. It calls `$.use(Surface)` fresh for each call so
  no reference into the provider is live while a handler runs.
- The scripted-surface test drives the counter through `Recorder` with
  no JavaScript. The example app's manifest grants
  `"dep.ui.surface.Surface" = true`; `hd build` writes
  `counter.host.mjs` beside the wasm, whose schema shows how values cross:
  an enum is `{ tag, fields }`, an optional is a value or `null`, `usize`
  is a 32-bit `Number`, and a `wait: "may"` method may return a Promise.
- One provider file serves both hosts. `providers/dom.mjs` picks the DOM
  backend when `document` exists and otherwise an in-memory tree that
  prints each batch and answers the clicks in `UI_CLICKS`, then handler
  0. `UI_CLICKS=2,2,1 hd run --engine node` in `examples/counter` prints
  the mount batch of 19 commands, then one `SetText` per click.

## Phase 7: the browser page (2026-11-01)

`web/index.html`, `web/todos.html`, `web/main.js`, `web/build.sh`,
`examples/todos`.

- The page bundles `../hd-lang/host/web.ts` (`createWebHost` over the
  platform-neutral core), `host/package-providers.ts`
  (`createPackageRuntime`), the generated `counter.host.mjs`, and
  `providers/dom.mjs` with esbuild (`pnpm dlx esbuild@0.28.2`, the
  version `hd-lang/package.json` pins). It passes the glue's first
  selector as a grant, `createPackageRuntime`, and
  `packageBindings: (runtime) => generated.bind(runtime, providers)` in
  the host env, exactly as `host/run.ts` does for Node. One glue file
  serves both examples because the trait belongs to the ui package.
- The program runs on the main thread; `next_event` returns a Promise
  that a DOM listener resolves, which the `wait: "may"` method allows.
- Verified with a real browser: the counter mounts with the same 19
  commands as under Node, and each click produces one `SetText` batch in
  the console; the todos page toggles a row and adds one with the
  expected batches.
- The gap: `hd fmt` rewrote `tests/for_each.hd`'s render closure, which
  holds a trailing `text_live:` block inside a call's brackets, into a
  form the parser rejects (`trailing-block-position`). The test now
  writes that block as an explicit closure. Logged in the hd writing log.

## Phase 8: resources (2026-11-02)

`src/resource.hd`, `tests/resource.hd`, job methods on `Surface`,
workers in `run_app!`, `examples/fetcher`.

- **Why not `race!`.** The plan wanted the loop to interleave
  `next_event!` with loader completions. `race!` cancels its losers
  (`req.combinator.race-losers-disposed`), `all!` has fixed arity, and
  user code can neither construct a `PollContext` nor implement
  `Suspend` (`req.protocol.builtin`, `req.poll-context.user`), so no
  user-written combinator can poll a changing set of loaders. The only
  thing that can suspend is a host wait.
- **So loads go through a host-mediated queue.** `Surface` gained
  `post_job(id)` and `next_job!() -> id`. `run_app!` is
  `all!(event_loop(), workers())` with four workers; each worker loops on
  `next_job!`, drives the job, and sends what it emitted. The event loop
  posts four zeros when it ends, so every worker stops and `all!`
  completes. A worker that is mid-load takes its zero afterwards, so a
  load in flight at shutdown still lands. The JavaScript provider answers
  `next_job` with a Promise; the hd `Recorder` answers 0 at once, so
  tests drive posted jobs with `run_jobs!` on the test task instead.
- **A loader has the empty row.** Its providers are bound when the cold
  suspension is constructed, inside the resource's tracking computation,
  which runs under `Track + Mutate` only; a row parameter cannot be
  carried there (`$.Context` takes no row parameter). So the loader
  captures what it needs lexically, `clock := $.use(Clock)` before
  `fn!(key) ...`, as `req.with.lexical` describes. The bound is
  `L < 'static & Fn(K) -> mut Suspend[Result[T, E]]`, which a `fn!`
  closure satisfies by `fn.trait.suspend-weaken`.
- **Landing.** Each job is a cold `land(...)` suspension that awaits the
  loader and writes the resource's signal under the `Mutate` captured at
  construction. A generation counter on the resource makes a result for
  an old key, or for a disposed owner, a no-op. A queued job that has not
  been taken is removed from the table, which costs nothing for a cold
  suspension (`req.discard.cold`).
- **What is not done.** An in-flight load is not cancelled: abandoning a
  suspension another task awaits cancels that task
  (`req.cancel.await`), which would kill the worker, so the result is
  dropped at landing instead. The pool size is fixed at four.

## Phase 9: hygiene (2026-11-02)

The review fixes of `roadmap.md` phase 9. Gate: `hd test` green (33 at the
end of the phase) plus `node --test providers/dom.test.mjs`.

- **`set_if_changed`.** A second impl block, `impl[T < 'static & Eq]
  Signal[T]`, is accepted, so the comparing write is a method beside `set`
  rather than a change to `set`, which stays unconditional for types
  without `Eq`. `for_each` now requires `T < Eq` and writes a retained row
  with it, so an unrelated list change reruns nothing inside that row
  (`tests/for_each.hd` counts the row's runs). Method doc tests are not
  collected by `hd test`, only item-level ones, so the example lives in
  `tests/core.hd`.
- **Provider maps.** `Remove` and `Clear` in both trees of
  `providers/dom.mjs` now forget every runtime node under the removed or
  cleared subtree (`[data-hd]` descendants in the DOM, a recursive walk in
  the scripted tree). The factories are exported and take the map as an
  optional argument, so `providers/dom.test.mjs` checks with a minimal fake
  DOM that a `show` toggled 100 times leaves the map at its mount size; the
  test fails on the old provider. No method was added to the provider
  object, because the glue checks it against the trait's schema.
- **Duplicate keys** in `for_each` panic with `ui: for_each: duplicate key
  <debug of key>`; `K` gained a `Debug` bound for that.
- **One worker count.** The pool is still `all!(started(), started(),
  started(), started())`, fixed arity (#1164), but the number appears
  once: `started()` counts a worker live when its cold suspension is made,
  before any task runs, and a worker that takes the stop marker re-posts it
  while others are live. The event loop posts one 0.
- **`reset_for_test`** also clears sources, computations and owners, and
  resets the id counter. `text_live`'s first-run flag is a `bool`.
- **`type Reactive = $ Track + Mutate`** (`req.row.alias`) names the row of
  every stored computation body.

## Phase 10: row-polymorphic builders and typed context (2026-11-02)

- `column`, `row`, `owned` take `[$R]` with row `$ Ui + R`, and `root`
  `$ Ui + Track + Mutate + R` returning `OwnerId $ R`. Nothing else
  changed: every existing caller infers `R` as empty. A component with
  `$ Ui + Palette` reads `$.use(Palette)` inside nested blocks, and the
  extension form `fn themed[$R](theme, body: fn() -> void $ R + Palette)
  -> void $ R` provides it (`tests/context.hd`). `tests/rows.hd` is the
  probe of `roadmap.md` section 6, unchanged.
- **The phase guarantee is now per row.** An eager `count.get()` in a
  `column:` block makes the block's row `$ Ui + Track`, so `R = Track`,
  which a component of row `$ Ui` does not have: `missing-requirement` at
  the `column` call (the doc test on `column`; the code was
  `unsatisfied-trait-bound` before). A component that names `Track` itself
  may read eagerly, which is an honest untracked read.
- **`Provided[T]`**, one generic key for one-off values:
  `given(value): body` installs `Given { value }` as `Provided[T]` and
  passes the caller's row through; `use_given::[T]()` reads it. No
  `generic-requirement-key-collision` arose: `R` is a row variable, not a
  key expression. A missing `given` is `missing-requirement` (doc test on
  `mount`).
- **The rule for retained callbacks.** `text_live`, `show`'s branch,
  `for_each`'s render, handlers and loaders run later under `Track +
  Mutate` or less and cannot carry `R`. Static context is a key in the
  row; a value a re-running computation needs is captured lexically
  (`theme := use_given::[Theme]()` before the block) or fetched through
  the owner tree with `provide` / `use_context`, which stay for that case.
- `examples/fetcher` moved the clock and the resource into a
  `profile(id) $ Ui + Clock` component called inside `app`'s `column:`.
  The roadmap said to move `$.use(Clock)` into the buttons' `row:`, but
  the clock feeds the loader, not the buttons; the component shows the
  same thing.
- Three hd facts found on the way, none filed yet:
  - A test module that imports nothing from the package fails to build
    with `invalid-manifest` for the `surface.Surface` host entry, and a
    doc test whose module does not reach `surface.hd` fails the same way.
    `tests/rows.hd` imports `pkg.Surface` unused; the compile-fail doc
    test lives on `mount` in `runtime.hd`.
  - A doc test body cannot declare a `struct` (`unsupported: statement
    DataDecl`), so that doc test uses `Provided[string]`.
  - A private function with no row written has its row inferred, so a
    compile-fail example must make the outer function's row explicit
    (`fn app() -> void $ Ui`) or the error never appears.

## Phase 11: the package split (2026-11-02)

Implements `packages.md`. The root `hd.toml` is a `[workspace]` of
`reactive`, `ui`, `ui-dom` and the three examples. Gate met: `hd test` at
the root runs the same 55 cases (15 in `reactive`, 37 in `ui`, 3 in
`ui-dom`); `hd test -p reactive` and `-p ui` pass with no `[host]` table
in either package; the three examples print byte-identical output under
Node against the checkpoint `8ce8304`; `web/build.sh` rebuilds, and in a
real browser the todos page adds a typed todo and the fetcher loads.

- **`Ui` became a row alias: `type Ui = $ Owner + Parent`.** `packages.md`
  puts `Ui` in `ui`, but `memo`, `effect`, `sync`, `on_cleanup`,
  `provide` and `resource` all read the current owner through
  `$.use(Ui).owner()`, and `reactive` cannot depend on `ui`. So
  `reactive` declares the key `Owner` (`fn owner`), with the provider
  `OwnedBy`, and `ui` declares `Parent` (`fn parent`) and the alias. Every
  `$ Ui` row in user code is unchanged, because an alias expands before
  row solving (`req.row.alias.expand.first`). Internally an alias is not a
  key, so every `$.use(Ui)` became `$.use(Owner)` or `$.use(Parent)` and
  every `$.with(Ui=...)` names the keys it changes: containers install
  `Parent` only, `owned` and `root` `Owner` only, and `mount`, `show` and
  `for_each` rows both, from one `Scope` that implements both traits. The
  graph's own record struct was renamed `OwnerRecord`. `reactive`'s
  functions now have rows `$ Owner`, which a `$ Ui` caller satisfies.
- **`reactive`'s low-level API.** Exported: `Computation`, `Kind`,
  `State`, `new_computation`, `run_computation`, `new_owner`, `dispose`,
  `flush`, `cleanup_on(owner, action)`, and two additions:
  `run_effect(owner, run)`, which makes an effect computation and runs it
  (the six copies of that block in the builders collapsed into it), and
  `reset_graph_for_test`, which `ui`'s `reset_for_test` calls. `graph()`
  is not exported; no file in `ui` touches the graph directly.
- **`ui`'s runtime** keeps everything synchronous plus `run_job!`.
  `take_new_jobs()` replaces the loop's direct read of the unposted list,
  and the runtime struct is now private. `run_jobs!` is gone: `ui`'s
  tests run `take_new_jobs` / `run_job!` / `take_commands` in a small
  `run_pending!` helper, and `tests/policy.hd` mounts under the clock
  instead of running `run_app!`. The runtime accessor for the last built
  node is `built_last()`, so it does not collide with the public
  `last_node()` builder.
- **`ui-dom`** holds `surface.hd` (the four-method trait), `app.hd`
  (`send!`, the event loop, the pool with its own live-worker counter,
  `run_app!`), `recorder.hd`, and `providers/`. Its `hd.toml` has the
  `[host]` table and `Clock` in `[dev-capabilities]` for the moved run_app
  case of `tests/resource.hd`. The two cases that exercise `run_app!`
  itself (the suspending loader, payloads through the loop) moved from
  `ui`'s tests into `ui-dom/tests/loop.hd`, which is why `ui` has 37 and
  not 39.
- **Tests by package.** `core` and `rows` went to `reactive`; `rows.hd`
  dropped its unused `pkg.Surface` import, which a `[host]`-less package no
  longer needs. `context.hd` went to `ui`, not `reactive` as `packages.md`
  says, because it mounts builders.
- **Manifests.** `[package]` takes no `version` key
  (`unknown-manifest-key`); versions come from tags. Path requirements
  carry `version = "0.1.0"` as planned. Each package writes its own
  `build/`, so `.gitignore` now ignores `build/` at any depth.
- The surface file in `ui` is `protocol.hd`, not `surface.hd`, since the
  trait it was named for moved out.

## Phase 12: the renderer protocol and typed style (2026-11-02)

Implements `rendering.md`. Gate met: `hd test` at the root, 60 cases
(the 55 of phase 11, less the four `attrs.hd` cases, plus eight in
`ui/tests/style.hd` and the `style_live` doc test); `node --test
ui-dom/providers/dom.test.mjs`, 4 cases, one of which checks every key
of section 3 against the CSS the table names, with `Unset` clearing each;
the three examples under Node; the browser pages in a real browser,
including the counter's dark-mode switch.

- **Protocol.** `DomCommand` is `Command`, with `SetProp(node, key,
  PropValue)` instead of `SetAttr`. `PropValue`, `Color` and `Size` are as
  designed, but every variant payload has a field name (`Number(value:
  f32)`, `Paint(color: Color)`, `Size.Px(value: f32)`) because enum
  fields cross the ABI by name (`{ tag, fields }`). `rgb` and `rgba` build
  colors.
- **`Style`** (`ui/src/style.hd`) has one optional field per key of the
  table, edges as four fields, plus `dom_class`. The file is generated
  from one field table, so field order, lowering order and diff order are
  the same: the order of `rendering.md`'s table. `entries(style)` lists
  every key with its value or `.None`; `lower` keeps the set ones; `diff`
  compares two entry lists index by index and gives `Unset` for a key that
  went to `.None`. Besides one chain method per field there are
  `padding`, `padding_x`, `padding_y`, `margin`, `border(px, color)` and
  `merge`. The background setter is `bg`, as designed.
- **The box builder is `view`, not `box`.** `box(...)` is hd's allocation
  builtin, used all through the library (`box(Scope { ... })`); a public
  `box` builder would shadow it in every importing module. The kind is
  still `"box"`. `column` and `row` are `view` with `direction` set, which
  they always emit, so a column's direction is explicit for renderers that
  do not default to column. `gap` the parameter is gone.
- **Lowering order**: `Create`, one `SetProp` per set field in key order,
  `Append`, then content. `style_live`'s props come after the container's
  `Append`, since its block runs inside the container's.
- **`style_live`** restyles `$.use(Parent).parent()`. Its first run is
  compared with an empty style, so the keys a live style sets are its own;
  mixing a static and a live value for one key would let `Unset` remove
  the static one, which the doc comment says. A block that reads no signal
  needs its row written out (rule 1), as `text_live`'s does.
- **Two kinds the design did not list.** `show` and `for_each` render into
  wrapper nodes that only group; with the stylesheet reduced to a reset,
  their old `display: contents` classes had to become protocol. They are
  kind `"fragment"`: a node that lays its children out as if they were its
  parent's. And `checkbox` is kind `"checkbox"` with a `checked` flag,
  since the table had only a text `input`. Both are vocabulary, not
  protocol changes.
- **`attr` / `attr_live`** lower to `dom:attr:<name>`. `text_live` has no
  `style` (positional block), so a live text is styled by a wrapping
  `view`; the demos do that.
- **Theme** (`ui/src/theme.hd`): `trait Theme: fn palette(self) ->
  ReadSignal[Palette]`, `SignalTheme`, `provide_theme(palette_signal,
  body)` in the extension form, and `Palette::light()` / `dark()` with
  roles `background`, `surface`, `on_surface`, `muted`, `line`, `accent`,
  `on_accent`. The test `a theme switch is one signal write` shows a
  switch emitting only the changed key.
- **Provider.** `cssFor(key, value)` is the key table as a pure function
  (exported, and tested without a DOM); `width: Fill` maps to `flex: 1 1
  0; align-self: stretch`. `value`, `checked` and `disabled` set element
  properties; `dom:class` sets `className`; `dom:attr:NAME` sets or
  removes an attribute. Unknown kinds render as `box`, and unknown keys
  are dropped, each logged once. The provider also reports the `key`
  event (payload: the key name) and keeps the `enter` event from phase 13.
  The scripted tree prints props as `key="value"`.
- **Inheritance.** The vocabulary promises none, but the demos set
  `color` on containers through `style_live` and rely on the DOM to pass
  it to text, because a live text cannot take a style. A non-inheriting
  renderer would need text-level styles; `rendering.md` already names a
  `text_live` variant with a style as the follow-up.
- `web/style.css` is a reset; the demos style themselves. The counter has
  a dark-mode button.

## Superseded: attributes and styles (2026-11-02, old phase 11)

Built under the first numbering of `roadmap.md`, where phase 11 was
"attributes and styles". The renumbered roadmap replaces it with phase 12,
the renderer protocol and typed style (`rendering.md`), which removes the
`class` and `style` strings and `SetAttr` below. Kept as the record of
what existed until then.

- `class: string = ""` is a named parameter of `column`, `row`, `text` and
  `button`. Containers emit `class="column card"`; `text` and `button`
  emit a `class` attribute only when one is given, between `Create` and
  `Append`, so every earlier command list is unchanged. `button`'s `class`
  comes after the handler (`button("save", save, class="primary")`)
  because a positional argument cannot skip a default. `text_live` has no
  `class` for the same reason: its block is usually positional.
- **Builders still return `void`.** The roadmap wanted them to return
  their `NodeId`, but a function's final expression must match its result
  type, so every component ending in `text(...)` would fail with
  `type-mismatch`. Instead the runtime records the node of the builder
  that finished last (a container after its block has run), `last_node()`
  returns it, and `attr(name, value)` and `attr_live(name, compute)` apply
  to it. `attr_live` shares `text_live`'s computation through a private
  `follow`: one `SetAttr` per change, none for an equal value.
- `web/style.css` is one stylesheet for the three pages, keyed on
  `.column`, `.row`, `.card` and a few app classes, with a dark variant.

## Phase 13: input controls (2026-11-02)

`src/inputs.hd`, `tests/inputs.hd`.

- `input(value: Signal[string], class="")` emits `Create(input)`,
  `type=text`, the initial `value`, and `Listen(node, "input", h)`. The
  handler records the payload as what the field shows and writes it with
  `set_if_changed`; an effect sends `SetAttr(value)` only when the signal
  differs from what the field shows, so a keystroke is never echoed and a
  write from elsewhere (clearing after a submit) is.
  `checkbox(checked: Signal[bool])` is the same over `change`, with
  payload `"true"`/`"false"`.
- `on(event, handler)` listens on `last_node()`. The provider synthesizes
  `"enter"` (a keydown filtered on Enter, payload the field's text), which
  is what "Enter-or-button add" needed without `on_key`. `button` and
  `on` share `listen(owner, node, event, handler)`.
- Provider: `SetAttr` of `value` or `checked` sets the DOM property, the
  only thing a field shows once edited; a checkbox's payload is its
  `checked`. `UI_CLICKS` items may carry a payload, `4=milk`.
- `examples/todos` gained the field, an `add` button and Enter, both
  through one `add` that ignores a blank title and clears the draft.
  Verified in a real browser: typing "buy milk" and Enter adds a row and
  clears the field; typing and clicking `add` does the same.

## Phase 14: resource policies (2026-11-02)

`resource_with(key, load, policy)` in `src/resource.hd`,
`tests/policy.hd`.

- **A separate function, not a default argument.** Every `std.task`
  layer wraps `fn!() -> Result[T, E] $ R` into one of row `$ R + Clock`,
  and `timeout` also needs `E < From[TimedOut]`. A default
  `policy=timeout(ms(5000))` on `resource` would put both on every
  resource, including ones with `E = string`. So `resource` is unchanged
  and `resource_with` takes `P < Layer[fn!() -> Result[T, E], Wrapped =
  fn!() -> Result[T, E] $ Clock]`, has row `$ Ui + Clock`, captures the
  clock at creation and installs it around `apply!(policy, work)` on the
  worker. Compositions such as `with_timeout(ms(5000), retry(...))` fit
  the same bound.
- `resource` and `resource_with` share `follow_key` (generation, stale-job
  drop, cleanup) and `settle` (the landing).
- **The timeout test uses a real clock.** On a `ManualClock` every sleep
  completes at once and work is polled first (`std-task` timeout example),
  so a sleeping loader always beats the deadline. `hd.toml` now grants
  `Clock` under `[dev-capabilities]`; the test's loader sleeps 2s against a
  20ms timeout and lands `Failed(.Slow)` in well under a second. The retry
  and composition tests use `ManualClock`, whose time shows the backoff
  (100ms, then 200ms).

## Phase 15: `Mutate` uses (2026-11-02)

- `assert_no_writes[T, $R](body)` installs `NoWrites`, whose `invalidate`
  panics. It checks only the body's own writes: effects a flush runs have
  their own `Mutate` from `run_computation`.
- `dispatch` installs a `WriteLog` instead of a throwaway `Scheduler`, and
  `last_writes()` returns the sources the handler wrote, each once, in
  first-write order. A `sync`'s writes during the flush are not listed.
- **Decision: `Mutate` is a capability token and an observation hook; the
  graph owns scheduling.** `batch_depth` stays on the graph. Moving it
  into the provider would not let the provider flush, because a flush runs
  effects and no provider method may run user code (phase 1), so the
  provider would only hold a counter the graph reads.

## Phase 16: a terminal renderer (2026-11-02)

The first non-DOM renderer, and the test of `packages.md`'s claim that a
second renderer is one more package. It was: nothing in `reactive/` or
`ui/` changed. Gate met: `hd test` at the root, 64 cases (the 60 before and
4 in `ui-tui/tests/loop.hd`); `node --test ui-tui/providers/tui.test.mjs`,
44 cases, one of which runs `hd run counter-tui` over pipes; the three
examples driven by scripted keys in a real terminal (tmux, truecolor and 256
colors, resize, a 40 by 12 window); the three DOM examples byte-identical
under Node against `56a41aa`; `web/build.sh` rebuilt and the pages checked in
a real browser.

- **`ui-tui` mirrors `ui-dom`.** `surface.hd` has its own `@host trait
  Surface` with the same four methods; `app.hd` and `recorder.hd` are copies,
  because the loop is per renderer and the recorder implements this package's
  trait. The dependency key is `dep.ui_tui`. The copy is about 100 lines and
  has not yet wanted to differ.
- **One app, two executables, not `examples/*-tui`.** `spec/cli`'s
  `[[executable]]` (`cli.exe.several`) fits, and it answers the open question
  of whether an app can consent to one `Surface` at a time. Probed: a manifest
  may consent to both, and `hd` binds only the trait the entry's row names
  (`cli.host.entry-binding`), so neither provider loads under the other. Each
  example's app moved to `src/lib.hd`; `src/main.hd` and `src/tui.hd` are a few
  lines each, since an entry module cannot be imported (`cli.exe.entry-no-use`).
  The cost: `hd run` with two executables needs the name
  (`cli.run.default.one`), so the old `hd run --engine node` is now `hd run
  counter --engine node`. `counter.wasm` and `counter.host.mjs` keep their
  names, so `web/` is untouched.
- **Layout is an embedded flexbox pass, about 300 lines of `tui.mjs`**, not
  yoga-layout or taffy-wasm. Those are asynchronous Wasm to load, would be the
  repo's first npm or vendored binary dependency, and calculate in floats that
  a cell grid has to round anyway; integer layout is also what makes the
  shares add up (`share`). `place` is pure and memoized per pass, since a box
  measures a child and then lays it out, which is exponential in depth
  otherwise. Followed: `direction`, `gap`, `padding_*`, `margin_*`,
  `border_width`, `width`/`height` with all four `Size`s, `min_*`/`max_*`,
  `grow`, `shrink`, `justify`, `align`. Sizes are border box, as React
  Native's. Text wraps at its box.
- **Units.** A cell is taken as 8 by 16 logical pixels, the scale
  `rendering.md` section 7 leaves to the renderer, so `padding(16)` is two
  columns and one row. `padding_y(4)` rounds to no rows, which is why a bordered
  button is three rows and not five. Any nonzero border is one cell.
- **Keys wait until hd asks.** A key is read in `next_event!`, not when it
  arrives, so each sees the tree the previous key's event left. Read eagerly, a
  key could append to a value a batch still in flight is about to replace, or
  act on a row a click is about to remove (reasoned, not observed; the test
  pins the order). The exception is
  Ctrl-C, which puts the terminal back at once, whatever hd is doing.
- **The host's end signal.** A panic leaves `next_event!` pending forever, and
  stdin held the process open: raw mode, no exit, and neither `q` nor Ctrl-C
  was read, which would strand a user's shell. A tmux run found this. The provider now listens to the
  method context's `instanceSignal` (`package-providers.ts`), which the host
  aborts when the program ends for any reason, and releases the terminal then.

Deviations from `rendering.md`:

- **`color` and `font_weight` inherit.** Section 3 promises no inheritance, but
  phase 12 already noted that `text_live` takes no style, so the examples style
  live text through a wrapping `view` and rely on the DOM passing it down. The
  fetcher's red failure would be lost otherwise. Section 3's "a renderer that
  does inherit" now describes both renderers; the vocabulary's promise is what
  should change if a third inherits too.
- **Text with no color contrasts with its background.** The DOM's default is
  black on a white page; a terminal's may be light. The fetcher sets
  `bg(p.surface)` and no color, which would be light on white on a dark
  terminal. Over no background the terminal's own color stands.
- **`Fill` across the main axis stretches.** The DOM column says `width: Fill`
  is `flex: 1 1 0; align-self: stretch` whichever axis the key is on, so in a
  column it also grows the height, which is a quirk of mapping onto one CSS
  shorthand. Here `Fill` on the main-axis key grows and on the cross-axis key
  stretches.
- **Not followed, and dropped silently:** `wrap` (one line only), `font_size`,
  `font_family`, `cursor`. `overflow: scroll` clips like `hidden`; the screen
  itself scrolls to keep the focus in view, since an unreachable button in a
  long list is a bug and a scrolling box is a feature. `opacity` under 1 is the
  terminal's dim attribute, not a blend. `radius` above 0 picks rounded corners.
- **Unknown keys are not logged.** Section 6 allows a log; there is no screen
  line to spare for one.
- **`enter` joined the event table.** It was the DOM provider's own since phase
  13 and the todos example needs it, so a second renderer makes it vocabulary.
  No property or kind was added.

What the terminal adds that the vocabulary does not name, all inside the
provider:

- The focus: the first node with a listener has it from the start, since a
  terminal has no pointer. It is reverse video inside the border, or a cursor
  in a field. When its node goes it passes to whatever holds its position.
- A button with neither border nor background is drawn `[label]`, standing in
  for the DOM's native chrome. Its label is centered, as a DOM button's is.
- Events bubble to ancestors' listeners, as the DOM's do. `key` payloads are
  `KeyboardEvent.key` names.
- `q` ends the loop except in a field, where it is a letter; Ctrl-C always ends
  it. This narrows the brief's "`q` or Ctrl-C", which would make a todo with a
  q in it untypable.
- Off a TTY it prints each changed frame as plain text, and the end of a piped
  stdin ends the loop, so `printf '\t\rq' | hd run counter-tui` is a test.

Handled in the provider, once it was clear none of them waits on upstream:

- **A panic's message survives.** A panic stub writes `panic: ...` through
  `hd:rt` before it traps, and the host closes the instance only after the run
  (`run.ts`, in a `finally`), so the line used to land on the alternate screen
  and vanish with it. A provider cannot intercept the host's write, but it can
  move what the write reaches: for the time of the screen, fd 2 is an unlinked
  file (close 2, and POSIX gives the next open the lowest free descriptor, which
  is how Node can do `dup2`). Leaving the screen puts the terminal back on fd 2
  and prints the file. So the message comes first and `hd`'s stack after it, and
  anything else on stderr no longer scribbles on the screen. Only when stderr
  is a terminal; `2>file` is left alone.
- **`--time-limit` is interactive.** A supervised run puts the guest in a worker,
  whose `process.stdin` is not the real one, so the provider opens fds 0 and 1
  itself, as `host/input.ts` does. A worker hears no SIGWINCH, so it polls the
  size. If the deadline passes while it waits for a key, the host ends the run
  and the terminal comes back.
- **A field has a cursor:** Left, Right, Home, End, Backspace and Delete, by
  grapheme, and the visible part follows it. hd replacing the text puts it at
  the end.
- **The mouse:** a left press focuses the nearest listening node under it and
  clicks it; a field only takes the focus. It counts the screen's scroll. Mouse
  reporting takes selection from the terminal, which most give back under Shift.
- **A wide glyph half overwritten** blanks its other half.
- **A stuck program can be stopped, and any death restores the terminal.** A
  handler in an endless loop blocks the main thread. In raw mode Ctrl-C is only a
  byte, so nothing read it: Ctrl-C and `q` did nothing, and the program had to be
  killed from elsewhere (reproduced). `stty isig` is no answer, since it would
  turn every Ctrl-C into a signal and lose handler 0. Instead keys are read on a
  thread of their own; if a second passes after Ctrl-C with no sign of the main
  thread, it sends SIGKILL. Then a guard, a small `sh` in its own session, waits on
  a pipe from the provider: if the pipe closes while it still runs, the provider
  died without cleaning up, and it leaves the alternate screen, restores `stty`
  and says so. A clean exit kills it first. This also covers a busy loop past
  `--time-limit`, where the host terminates the worker and no provider code runs;
  an earlier note here that this left the terminal raw was wrong, since libuv
  resets the mode at exit. It was the alternate screen, wrapping, cursor and mouse
  reporting that stayed. A `q` is not honored while stuck, only Ctrl-C.

Known limits:

- **Under `--time-limit`, a panic's first line is still lost on a real screen,
  unless stderr is redirected.** Closing fd 2 from a worker makes Node print a
  warning onto the screen, so there is no capture there, and the main thread
  writes the line while the screen is up. The stack and status 3 survive, and
  `2>file` keeps the line.
- No scrolling inside a box, and no text selection in a field.
- The fd 2 swap, the worker path, the key thread, the guard and real mouse input
  were checked by hand in tmux. The unit tests cannot reach them, since they need a real terminal.

### Plan B: what a GPUI renderer would need

Time-boxed reading at `cf5040b4a`, no code written. `hd` here has no wasmtime
engine, so the two facts about wasmtime's behavior come from its source and its
tests, not from a run.

**`hd_run_wasmtime` is closed, in two independent places.**
`WasmtimeEngine::load` refuses any module with an `hd.capabilities` section
before anything else happens (`engine.rs:240`; this is
`cli.host.package.native-refusal`). Past that, the `Linker` is made and filled
inside `instantiate_host` (`engine.rs:141`), imports dispatch through a closed
`Kind` enum (`host/call.rs`), and the store's `Host` type is private (`mod
host`). No public API takes an extra import. An embedder cannot get in without a
change upstream.

**A raw `wasmtime` embedder is possible but is not an open path.** The module
is small: `counter-tui.wasm` imports exactly seven `hd:pkg:<hash>` functions
(`apply`, `next_event`, `next_job` as `.start`/`.finish` pairs, and `post_job`)
and four from `hd:rt` (`abort`, `hash_seed`, `panic`, `stderr`), and exports
`hd.init`, `hd.poll`, `hd.wake`. `hd_host_abi::schema::from_wasm` is public and
returns the checked `Contract` for those imports. So a Rust program using the
`wasmtime` crate directly could link them and drive the poll loop, skipping
`hd_run_wasmtime` and with it the refusal. What it would have to own:

- The exchange-buffer codec for `Value`, which exists only as generated
  JavaScript (`hd_host_abi/src/javascript.rs`, `Enc`/`Dec` in
  `host/package-providers.ts`). This is the bulk of it.
- The driver: `hd.poll`, wakes, pending operations, the deadlock report.
- Every other host trait the app names, reimplemented: the fetcher adds
  `hd:Clock`, which is private to `hd_run_wasmtime` too.
- Consent, since `cli.host.package.invoker` would now be the embedder.

The schema is "toolchain ABI v1" with `RUNTIME_ABI_REVISION`, the crates are
path-only, and the `<hash>` in the module name is a directory hash. All of it
would break silently on a toolchain update. That is not "clearly open", so no
crate was started.

**What hd-lang#1191 should decide.** In its order:

1. **Binding shape: a generated Rust trait plus codec, passed to an engine API
   at instantiation.** This is the analogue of `NAME.host.mjs`, and the
   generator already has its input (`Contract`). A dylib loaded from a manifest
   path adds loading and ABI-stability problems that a GUI does not need,
   because a GPUI app is a Rust binary that owns `main` anyway; it embeds hd, not
   the reverse. So the entry point is `hd_run_wasmtime` as a library, with one
   new public hook, and the load refusal scoped to "no provider registered".
2. **Consent stays as it is.** `[capabilities] "dep.ui_gpui.surface.Surface" =
   true`, checked by the embedder as the invoker. Nothing about a native
   provider changes what an app agrees to.
3. **Value conversion: mirror `module.host.package.js-values`.** Enums with
   named payload fields become Rust enums with the same names, which is why
   `rendering.md` named those fields. Optionals, lists and handles map directly.
4. **How a native provider's completions reach the guest.** Who owns the loop
   is already answered: `hd_run::Instance` is public, with `init`, `poll`, `wake`
   and `completed`, `WasmtimeInstance` implements it, and the JS core has
   `createDriver` (`cli.host.driver.*`, "Synchronous Host Driver"), so an embedder
   can run turns from GPUI's foreground executor. What is missing is narrower:
   `completed()` returns the engine's own reactor batch, and on a first look there
   is no way to add to it from outside. A provider's pending `next_event.start`
   needs one. This belongs with the binding shape in point 1. Not checked by a run.
5. **A smaller first step:** a public `hd_run::Engine`-level way to run a module
   with extra imports, even unstable, would let `ui-gpui` start without settling
   generated traits, at the cost of a hand-written codec.

What `ui-tui` shows for such a renderer: the protocol needed no change, and
the provider's split (retained tree, then pure layout, then paint) is the shape
a GPUI provider would keep, with taffy in place of `place` and GPUI's own focus
in place of the provider's. The vocabulary's units and `Fill` rule apply as they
stand. The unknowns left are all on the host side.
