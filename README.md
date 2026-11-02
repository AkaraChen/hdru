# ui: Solid's model, with its rules in the type system

A fine-grained reactive UI library for [hd](https://github.com/HerringtonDarkholme/hd-lang).
Components run once, a change updates only what read it, and there is no virtual DOM.

What makes it different is that the rules you normally keep in your head, or in a lint
config, are compile errors here. The same UI renders to a browser or a terminal.

**Status: an experiment, not ready for production.** See [Limits](#limits).

## At a glance

If you have written Solid, this will look familiar. Indentation does what JSX nesting does.

```hd
fn counter() -> void $ Ui:
    count := signal(+0)
    doubled := memo:
        count.get() * 2

    column(style=Style::empty().gap(8.0).padding(12.0)):
        text:
            "${count.get()} x 2 = ${doubled.get()}"
        button(fn(): count.update(fn(n): n + 1)):
            text(fn(): "+1")
```

| React / Solid | Here |
| --- | --- |
| `useState` / `createSignal` | `signal` |
| `useMemo` / `createMemo` | `memo:` |
| `useEffect` / `createEffect` | `effect:` |
| `<div style={...}>` | `column(style=...):` |
| `{count()}` | `text:` |
| `<button onClick={...}>` | `button(on_click):` |
| `{list.map(...)}` / `<For>` | `for_each` |
| `{cond && ...}` / `<Show>` | `show` |

`$ Ui` is a **row**: what a function needs in order to run. Everything below follows from it.

A click updates one text node and nothing else. This is a real test, and it needs no browser
and no jsdom, because the UI is a stream of commands:

```hd
it("a click updates one text node, nothing else"):
    reset_for_test()
    _ := mount(counter)
    _ := take_commands()
    dispatch(UiEvent { handler: 1, payload: "" })
    assert_equal(take_commands(), [Command.SetText(2, "1 x 2 = 2")], reason="one command")
```

## The rules are types

Reading a signal in a component body is Solid's classic trap: it runs fine and silently never
updates. Here it does not compile.

```hd
fn bad() -> void $ Ui:
    count := signal(+0)
    n := count.get()
    column:
        text(fn(): "$n")
```

```
error: missing-requirement: this needs `$ Track`, which the enclosing function's
row does not name; `$ Ui` is `$ Owner + Parent`
```

The reason is one signature. Reading needs `Track`, and only `text`, `memo` and `effect` provide
it:

```hd
pub fn get(self) -> T $ Track:
```

Writing needs `Mutate`, so a write inside a `memo:` is a compile error too. "Render is pure, memos
compute, handlers write" stops being a convention.

Context works the same way. Forgetting a provider is not an `undefined` at run time:

```hd
fn card() -> void $ Ui + Theme:
    theme := $.use(Theme).palette()
    column(style=Style::empty().padding(12.0).radius(8.0)):
        style_live:
            p := theme.get()
            Style::empty().bg(p.surface).color(p.on_surface)
        text(fn(): "hello")

fn app() -> void $ Ui:
    palette := signal(Palette::light())
    provide_theme(palette):
        card()
        button(fn(): palette.set(Palette::dark())):
            text(fn(): "dark")
```

Without `provide_theme`, this is `missing-requirement: this needs $ Theme`. Style is a typed value
rather than a CSS string, there is no cascade, and dark mode is one signal write that sends only the
properties that changed.

## No magic

Solid tracks dependencies through a global "current observer". Here it is ordinary code: reading a
signal calls the current `Track`, and running a computation installs one that collects.

```hd
collector := box(Collector { deps: [] })
changed := $.with(Track=collector, Mutate=box(Scheduler { writes: 0 })):
    (comp.run)()
subscribe(id, collector.deps)
```

`untrack` is not a special mechanism either. It installs a `Track` that records nothing:

```hd
pub fn untrack[T](body: fn() -> T $ Track) -> T:
    $.with(Track=box(NoTrack {})):
        body()
```

The one idea, `$.with`, also covers the rest:

- A `Mutate` that logs is how `last_writes()` reports what a click wrote.
- A `Mutate` that panics is `assert_no_writes`.
- A `Renderer` that records is `Recorder`, which runs the whole event loop in a test with no JavaScript.
- A `Clock` you control makes time-based tests instant.

## Lists, conditions and inputs

```hd
fn todos() -> void $ Ui:
    items := signal([Todo { id: 1, title: "learn hd", done: false }])
    draft := signal("")
    column:
        input(draft)
        for_each(items.read(), fn(todo): todo.id, fn(todo): text(fn(): todo.get().title))
        show(fn(): items.get().is_empty()):
            text(fn(): "all done")
```

- `for_each` is keyed. A row whose key stays gets its new item through its own signal, so an unrelated
  change to the list reruns nothing inside it, and reordering emits only the moves it needs.
- `show` disposes its branch when hidden and rebuilds it in the same place.
- `input(draft)` binds to a signal, with no `value` and `onChange` to wire up.

## Async

A `resource` loads whenever its key changes. A result for an old key is dropped, so there is no race
to clean up by hand.

```hd
fn fetch_user!(id: i32) -> Result[string, string] $ Clock:
    $.use(Clock).sleep!(ms(400))
    if id == 13: .Err("unlucky") else: .Ok("user $id")

fn profile() -> void $ Ui + Clock:
    let clock: *mut dyn Clock = $.use(Clock)
    id := signal(+1)
    user := resource(
        fn(): id.get(),
        fn!(key: i32) -> Result[string, string]:
            $.with(Clock=clock):
                fetch_user!(key)
        ,
    )
    column:
        text:
            match user.get():
                .Loading => "loading…"
                .Ready(name) => name
                .Failed(why) => "failed: $why"
        button(fn(): id.update(fn(n): n + 1)):
            text(fn(): "next")
```

`fetch_user!` says in its row that it needs a clock, so a test swaps in a fake without mocking a module.
`resource_with(key, load, policy)` wraps each load in a `std.task` policy such as
`with_timeout(ms(5000), retry(Backoff {}))`.

## One UI, two renderers

The UI only emits commands, so an app chooses a renderer in its entry, and the rest of it stays the same.

```hd
# src/main.hd: the browser
use dep.ui_dom.{Surface, run_app}
use pkg.app

pub fn main!() -> void $ Surface:
    run_app!(app)
```

```hd
# src/tui.hd: the terminal
use dep.ui_tui.{Surface, run_app}
use pkg.app

pub fn main!() -> void $ Surface:
    run_app!(app)
```

```
  ╭──────────────────────────────────────╮
  │                                      │
  │  Count: 0                            │
  │                                      │
  │  ╭─────╮ ╭─────╮                     │
  │  │  -  │ │  +  │                     │
  │  ╰─────╯ ╰─────╯                     │
  │                                      │
  ╰──────────────────────────────────────╯

  ╭──────────────────────────────────────╮
  │           toggle dark mode           │
  ╰──────────────────────────────────────╯
```

A renderer is two methods, `apply!` and `next_event!`, and `ui` holds the loop that drives them. The terminal one was added without changing a
line of `reactive` or `ui`. In a terminal, Tab and Shift-Tab move the focus, Enter and Space click, a left
press focuses and clicks, typing edits a focused field, Space toggles a checkbox, and `q` (outside a field)
or Ctrl-C quits.

## Limits

- **Handlers take a few more lines than in React.** A handler runs after its component has returned, so a
  key it needs is captured first and installed around the call. Forgetting either step is a compile error.

  ```hd
  let api: *mut dyn Api = $.use(Api)
  button(fn():
      $.with(Api=api):
          save_flow(name.peek())
  ):
      text(fn(): "save")
  ```
- **Untested at scale.** The examples are about 270 lines, and performance has not been measured.
- **Signals are never freed,** including the one `for_each` makes per row, so a list that keeps mounting new
  keys grows memory for as long as the program runs.
- **Not included:** routing, virtualized lists, animation, accessibility beyond the DOM's own, and more than one
  UI in a program.
- **A native renderer is blocked.** Host providers run only on JavaScript for now
  ([hd-lang#1191](https://github.com/HerringtonDarkholme/hd-lang/issues/1191)), so the terminal renderer runs on Node.
- **A compiler bug rejects some valid blocks.** A `text:` that reads no signal fails until
  [hd-lang#1194](https://github.com/HerringtonDarkholme/hd-lang/issues/1194) is fixed. Write `text(fn(): "x")`.

## Try it

You need:

- The `hd-lang` checkout beside this repo at `../hd-lang`, last checked at commit `717b76ad8`. The browser build
  imports its `host/*.ts` directly.
- The `hd` binary built from it: `cargo install --path crates/hd_cli` inside `../hd-lang`. The Node engine is the
  default, and the renderers cannot run under wasmtime.
- Node 24 (`hd-lang` pins 24.19.0), and `pnpm` (for `pnpm dlx esbuild`) if you build the browser pages.

```sh
cd examples/todos && hd run todos-tui
```

| What | Command |
| --- | --- |
| every package's tests, from the root | `hd test` |
| one package | `hd test -p reactive` (or `ui`, `ui-dom`, `ui-tui`) |
| provider tests and the layering rules | `node --test ui-dom/providers/dom.test.mjs ui-tui/providers/tui.test.mjs layering.test.mjs` |
| the examples in a terminal | `hd run counter-tui`, `hd run todos-tui`, `hd run fetcher-tui`, each in its `examples/` folder |
| a terminal app driven by keys, printing plain frames | `cd examples/counter && printf '\t\rq' \| hd run counter-tui` |
| an example under Node, DOM provider, scripted clicks | `cd examples/counter && UI_CLICKS=2,2,1 hd run counter --engine node` |
| the todos example, typing "milk" and pressing Enter | `cd examples/todos && UI_CLICKS=1,8=milk,10 hd run todos --engine node` |
| the playground | `node web/playground/build.mjs`, then serve `web/playground/dist/`; needs the `hd_web` package goal in `../hd-lang` |
| the browser pages | `./web/build.sh`, then serve `web/` (for example `python3 -m http.server -d web 8765`) and open `index.html`, `todos.html` or `fetcher.html` |

Run `hd check` after `hd fmt`, which can still produce code the parser rejects
([hd-lang#1193](https://github.com/HerringtonDarkholme/hd-lang/issues/1193)).

## Where things are

| Package | What it holds |
| --- | --- |
| `reactive/` | signals, memos, effects, owners, context; no nodes and no host |
| `ui/` | the `Ui` row, builders, `show`, `for_each`, inputs, resources, `Style`, `Theme`, the command protocol, the `Renderer` trait and its loop, `Recorder` |
| `ui-dom/` | the browser renderer: the `Surface` host trait, `run_app!`, the JavaScript provider, and what only the DOM has (`attr`, `dom_class`, `dom_on`, `textarea`) |
| `ui-tui/` | the terminal renderer: the `Surface` host trait, `run_app!`, the JavaScript provider |
| `playground/` | an hdru playground written in hdru, DOM-only |
| `examples/` | `counter`, `todos` and `fetcher`, each with its app in `src/lib.hd` and an entry per renderer |
| `web/` | browser pages for the examples and the playground |

An app depends on `ui` and a renderer, and consents to the renderer's host trait in its manifest, such as
`"dep.ui_dom.surface.Surface" = true`.

Read next:

- [`docs/design.md`](docs/design.md): how it works and why
- [`docs/layering.md`](docs/layering.md): what belongs in which package, and how to add a component
- [`docs/rendering.md`](docs/rendering.md): the protocol, the vocabulary, and writing a renderer
- [`docs/packages.md`](docs/packages.md): the workspace and manifests
