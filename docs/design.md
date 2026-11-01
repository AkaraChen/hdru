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
