# Design

How the library works and why it is built this way. `rendering.md` covers the
protocol, the vocabulary and the renderers; `packages.md` covers the workspace.
Everything here was checked against the `hd-lang` checkout at commit
`717b76ad8`. Earlier plans and the phase-by-phase record are in git history.

## What it is

A fine-grained reactive UI library in the shape Solid uses: components run
once, signals are explicit handles, and a change reruns only the computations
that read it. There is no virtual DOM. Building and updating a tree emit a
stream of commands, which a renderer package applies across the Wasm boundary.

The effect system carries the rules. Reading a signal needs `Track`, writing
one needs `Mutate`, and building needs `Ui`, so a write inside a memo or an
eager read in a component body is a compile error, not a runtime check.

## Language rules the signatures follow

Every public signature follows these. They come from probing the compiler, and
they explain most of what looks odd in the API.

1. **A closure passed to an `Fn` or `FnMut` bound takes the bound's row,** whether it is written
   as a closure or as a trailing block (`fn.trait.bound-closure`), so `button(fn(): pass): ...` and
   `text: "hello"` both work. Each bound lists only the row the library re-installs at run time; a
   callback that needs another key follows "Keys in retained callbacks" below.
2. **A concrete `fn` parameter cannot be stored.** Storing one is
   `local-reference-escapes`, whatever the caller passed. Every retained callback
   is a bare type parameter bounded by `'static & Fn/FnMut`, which the library
   erases into a concrete closure of its own.
3. **An `Fn` bound takes only an inline closure or a function name.** A closure
   first bound to a variable implements only `FnMut`
   (`fn.trait.read-only.values`). `memo`, `text`, `show` and `for_each` take
   their callbacks inline; `button` and `effect` use `FnMut` and accept either.
4. **Row-polymorphic builders thread keys only through synchronous callbacks.**
   `fn column[$R](children: fn() -> void $ Ui + R) -> void $ Ui + R` passes any
   extra key of the caller through nested blocks. A callback the library retains
   and runs later (`text`, `show`'s branch, `for_each`'s render, handlers,
   loaders) runs under `Track + Mutate` or less, cannot carry `R`, and captures
   providers lexically. `reactive/tests/rows.hd` is the smallest example.
5. **No provider method may run user code.** `ref.excl.alias.call-loan` makes a
   method call through `*mut` a run-time loan for the whole call, so a provider
   that called back into user code would panic with `borrow-conflict` when that
   code used the provider again. `Track` and `Mutate` providers are leaves that
   only record, and flushing is a free function on the graph.

Smaller facts worth keeping in mind:

- `box` is hd's allocation builtin, so the box builder is `view`.
- A method doc test is not collected by `hd test`, only an item-level one, and a
  doc test body cannot declare a `struct`.
- A private function with no written row has its row inferred, so a compile-fail
  example must spell out the outer row (`fn app() -> void $ Ui`).
- Destructuring is `let (a, b) = ...`, and match arms go on separate lines.

## The reactive core

**One program-wide graph.** A top-level `GRAPH := box(Graph { ... })` persists
across calls, so `signal(initial)` needs no graph argument, as Solid's
`createSignal` needs none. Sources, computations and owners live in maps keyed
by one id counter.

**Lazy memos with versions, not heights.** Each source has a version, and each
computation records the version it saw of each source. A write bumps the version,
marks direct observers `Dirty` and transitive ones `Check`, and queues effects
when first marked. Reading a `Check` memo refreshes the memos it depends on and
reruns only if a seen version moved. So a diamond's join runs once, and a memo
that recomputes an equal value stops propagation. This is the Reactively
algorithm; it needs no ordering of the dirty set.

**Writes.** `set` writes unconditionally, because `Signal[T < 'static]` has no
`Eq` bound. `set_if_changed`, in a second impl block with `T < Eq`, compares
first. `memo` requires `Eq` and suppresses equal values. `set` flushes after its
`invalidate` returns, a flush from inside an effect only queues, and `batch`
defers the flush to its end, with its depth kept on the graph.

**`effect` and `sync`.** `effect` is `FnMut() -> void $ Track` and `sync` adds
`Mutate`. They are separate because a single row of `$ Track + Mutate` would
reject the common read-only trailing block (rule 1). Both run at creation and again
at flush when a dependency moved. Stored bodies are `fn() -> bool $ Reactive`, where `type Reactive
= $ Track + Mutate`, and run under a collector plus a `Mutate` provider, so a
`sync` may write while a memo, bounded `$ Track`, cannot.

**Lifetimes.** Signal sources have no owner and are never freed. Memo sources are
removed when their owner is disposed.

**`Mutate` is a capability token and an observation hook; the graph owns
scheduling.** `dispatch` installs a `WriteLog`, and `last_writes()` returns what
the last handler wrote, each source once, in first-write order. A `sync`'s writes
during the flush are not listed. `assert_no_writes(body)` installs a provider that
panics on a write, and checks only the body's own writes, since effects a flush
runs have their own `Mutate`. Moving `batch_depth` into the provider would gain
nothing, because a flush runs effects and rule 5 forbids that in a provider.

## Owners and context

`root` and `owned` make owners; `on_cleanup` attaches to the current one. A
container such as `column` makes no owner, so a `provide` inside one lands on the
enclosing owner. `owned:` is the component boundary, as `show` and `for_each`
rows are.

There are three ways to hand a value down, cheapest first:

- **Lexical capture**: `clock := $.use(Clock)` before a block. The only choice for
  a retained callback (rule 4), and always available.
- **A typed key**: `given(value): body` installs `Provided[T]`, and
  `use_given::[T]()` reads it. A missing one is `missing-requirement` at compile
  time. `Theme` is a dedicated key of this kind, with a palette signal.
- **The owner tree**: `provide(key, value)` and `use_context::[T](key)`, keyed by
  string, recovered by `downcast_ref` and returned as a copy. Shared state goes
  through as a handle: a `Signal` is a declared struct and so inspectable. This is
  for a value a re-running computation needs and cannot capture.

The phase guarantee is per row. An eager `count.get()` in a `column:` block makes
the block's row `$ Ui + Track`, so `R = Track`, which a component of row `$ Ui`
lacks: `missing-requirement` at the `column` call. A component that names `Track`
itself may read eagerly, which is an honest untracked read.

### Keys in retained callbacks

A handler or loader runs after the component has returned, so the `$.with` that
satisfied the component's row is gone, and `$.use` in the callback does not compile
(rule 4). The pattern is to capture the provider in the component, keep the business
function's row honest, and install the provider at the callback's edge:

```hd
fn save_flow(name: string) -> void $ Api + Log:
    $.use(Api).save(name)
    $.use(Log).info("saved $name")

fn panel() -> void $ Ui + Api + Log:
    let api: *mut dyn Api = $.use(Api)
    let log: *mut dyn Log = $.use(Log)
    name := signal("")
    button(fn():
        $.with(Api=api, Log=log):
            save_flow(name.peek())
    ):
        text(fn(): "save")
```

`save_flow` can be tested alone with fakes. A key missing from the component's row is
`missing-requirement`, and a callback that calls `save_flow` without installing the keys
is `type-mismatch`. The capture needs the counted type: `api := $.use(Api)` is a local
reference, and capturing it is `local-reference-escapes`. What is lost is seeing a single
callback's keys in its own row, and the cost is these few lines. `examples/fetcher` uses
it for its loader.

Two alternatives were tried and left out. An app-level helper over `type AppRow = $ Api +
Log` removes about three lines from this example, but then a component that uses only
`Log` must also name `Api`. A helper generic over the row would need `$.Context[$ R]`,
which hd forbids (`req.row.param.context`). Removing that check alone is not enough: the
row fails to infer from the context argument, and `$.with(providers...)` does not satisfy
`R`.

## Building

**`Ui` is a row alias: `type Ui = $ Owner + Parent`.** `memo`, `effect` and the
like need the current owner, a `reactive` concept, and builders need the current
node, a `ui` one. Containers re-install only `Parent`; `owned` and `root` only
`Owner`. An alias is not a key, so the library writes `$.use(Owner).owner()` and
`$.use(Parent).parent()`.

**Providers are read-only data.** The provider is `Scope { owner, parent }`, and a
container runs its block under a fresh one. Everything mutable (the pending
commands, the handler table, the id counters) is one program-wide `Runtime` box,
so no provider method ever runs user code.

**Command order is `Create`, `SetProp`s, `Append`, then content.** A node is
attached before its text or children are set, and a `style_live`'s props come after
the `Append`, since its block runs inside the container's. Node 0 is the host's
mount point, and handler 0 means stop.

**Handlers take a string payload.** The table holds `fn(string) -> void $ Mutate`.
`button` ignores the payload and inputs use it. `register_handler` erases its
callback (rule 2), and a cleanup on the owner drops it. `dispatch` runs the handler
inside `batch`, then flushes, so a handler writing several signals produces one
round of effects.

**Builders return `void`.** A function's final expression must match its result
type, so if builders returned a `NodeId`, every component ending in `text(...)`
would be a `type-mismatch`. Instead the runtime records the node of the builder
that finished last. `last_node()` returns it, and `on`, `prop` and
`ui-dom`'s `attr` apply to it.

**`text` takes no style.** Its block is usually trailing, and a trailing block must be
the last parameter. Text is styled by a wrapping `view`, which is why both renderers
inherit `color` and `font_weight` (`rendering.md`).

### `show`

`show` renders into a fragment that stays in its parent. Hiding emits
`Clear(fragment)` and disposes the branch owner, a child of the component's, and
showing rebuilds into the same fragment, so the branch keeps its place among its
siblings. Handlers and bindings inside a hidden branch are gone, inner signals
start over, and outer signals show their current value. Forcing the condition to
the value it already has reruns the computation and emits nothing.

### `for_each`

The reconciler is one effect whose only tracked read is `items.get()`. Rows render
under `NoTrack`, so a row's bindings are separate computations. Each row has a
child owner, a fragment, and a `Signal[T]` whose read half `render` receives.

- A retained row gets its new item through `set_if_changed`, which is why `T < Eq`:
  an unrelated change to the list reruns nothing inside that row.
- For order, the old order minus removed keys, plus new keys, is walked against the
  wanted order. Where they differ, the wanted row moves before the row there. An
  append emits no move, and a prepend or a reverse of two emits one.
- Two items with one key panic with `ui: for_each: duplicate key <debug of key>`.
- `render` takes a parameter, so it is an explicit closure, not a trailing block
  (`fn.trailing.parameterized`).

### Inputs

`input(value)` and `checkbox(checked)` keep a signal and a host control in step.
The handler records the payload as what the control shows, then writes the signal
with `set_if_changed`. An effect sends a `SetProp` only when the signal differs from
what the control shows. So a keystroke is never echoed back, and a write from
elsewhere, such as clearing after a submit, reaches the control. `on(event, handler)`
listens on `last_node()`.

## Resources

A `resource` loads a value with a suspending function whenever its tracked key
changes. It is a `ReadSignal[Resource[T, E]]` of `Loading`, `Ready` or `Failed`.

**Loads run on a pool of workers.** The loop must serve events while loaders run, and
there is no way to start a task later, so `run_on!` starts a fixed set of workers beside the
event loop, with `join!` and `map_join!`.

**Jobs wait in a plain list, and a channel only wakes workers.** `std.task`'s usual pool sends
items down a shared channel (`std-task.channel.pool`), but here that capacity would be a trap: a
worker hands over the jobs its own load made, so with the channel full every worker could wait on
`send!` at once, and the program would die of `suspension-deadlock`. So a token is sent only for a
worker counted idle, the tokens never outnumber the capacity, and `send!` never waits. Hosts stay out
of it, so `Renderer` has only `apply!` and `next_event!`.

**A loader has the empty row.** Its providers are bound when the cold suspension is
made, inside the resource's tracking computation, which cannot carry a row
parameter. So it captures what it needs before the `fn!`, as `req.with.lexical`
describes.

**Landing.** Each job is a cold suspension that awaits the loader and writes the
resource's signal under the `Mutate` captured at construction. A generation counter
makes a result for an old key, or for a disposed owner, a no-op. A queued job not yet
taken is simply removed, which costs nothing for a cold suspension
(`req.discard.cold`). An in-flight load is not cancelled: abandoning a suspension
another task awaits cancels that task (`req.cancel.await`), which would kill the
worker, so its result is dropped at landing.

**Policies.** `resource_with(key, load, policy)` wraps each load in a `std.task` layer
such as `timeout(ms(5000))` or `retry(...)`. It is a separate function, not a default
argument, because every layer adds `Clock` to the row and `timeout` needs `E <
From[TimedOut]`, which would then burden every resource. It captures the clock at
creation and installs it around `apply!(policy, work)` on the worker.
`tests/policy.hd` uses a real clock for its timeout case, because on a `ManualClock`
every sleep completes at once and a sleeping loader always beats the deadline.

## The run loop

`run_on!(root)` lives in `ui`, on the `Renderer` trait, and each renderer package adapts its host trait to it in `run_app!`.
It mounts, sends the first batch, then runs `join!(event_loop(), workers())`.

- `event_loop!` takes `next_event!`, dispatches, and sends, until an event names
  handler 0. Then it posts job 0. It calls `$.use(Renderer)` fresh each time, so no
  reference into the provider is live while a handler runs.
- `worker!` takes a job from the pool, runs it with `run_job!`, and sends what it emitted. With no
  job it waits on the channel, and once the loop has ended and no job is left it stops. So a load in
  flight at shutdown still lands, as do any loads it leads to.
- There are four workers, so at most four loads are in flight at once.

`Recorder` implements `Renderer` in hd for tests: `apply!` logs, and `next_event!` pops a scripted event
or answers handler 0, so the loop's tests in `ui` need no host at all. Tests below the loop use `mount`,
`dispatch` and `take_commands`.

## Known limits

- **One UI per program.** `GRAPH` and `RUNTIME` are program-wide, by the rule that no
  provider method may run user code. Making the graph a provider value is possible,
  since every flush already happens outside provider methods, but it touches every file.
- **The boundary is a pull loop.** hd has no export registration
  (`HOST_EMBEDDING.md`), so the host cannot call `dispatch` directly.
- **No in-flight cancellation.** As above. Each load would need a task of its own to cancel, and
  there is no way to start one later.
- **A fixed pool of four,** for the same reason. The number is one constant.
- **Signals are never freed**, as above. That includes the signal `for_each` makes for each
  row, so a list that keeps mounting new keys grows the graph for as long as the program runs.
- **`hd` runs on Node here.** This build has no wasmtime engine, so nothing has run on
  it, including `reactive` and `ui`, which have no host trait to stop them.

## Upstream issues

| Issue | State at `9af95bd2f` | What it means here |
| --- | --- | --- |
| [hd-lang#1191](https://github.com/HerringtonDarkholme/hd-lang/issues/1191) | design accepted, not built | no native renderer (`rendering.md`) |
| [hd-lang#1190](https://github.com/HerringtonDarkholme/hd-lang/issues/1190) | fixed | a test file may import nothing from a host-mapped package |
| [hd-lang#1193](https://github.com/HerringtonDarkholme/hd-lang/issues/1193) | fixed | `hd fmt` no longer breaks a long `if` in a struct field. The tree has not been reformatted since |
| [hd-lang#1194](https://github.com/HerringtonDarkholme/hd-lang/issues/1194) | fixed | a trailing block takes an `Fn` bound's row (rule 1) |
