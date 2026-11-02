# The playground

Edit an hdru program, see its type errors as you type, and run it beside the commands it sends. It is live at
<https://hdru-playground.pages.dev/>, and it is static: everything runs in the visitor's browser.

## How it fits together

```
Shell: an hdru app on the main thread          Compiler worker
  editor, examples, problems, commands  <--->    hd_web.wasm, with ui, ui-dom and reactive registered
  Workbench host trait
       |  commands and events, by postMessage
       v
Sandboxed iframe                        <--->  Run worker
  createDomSurface, the real DOM renderer        the user's wasm, whose Surface posts its commands
```

| Part | Where | Why it is there |
| --- | --- | --- |
| The shell | `playground/src/lib.hd` | the UI, in hdru. DOM-only, so it may import `ui-dom`'s words (`layering.md`) |
| `Workbench` | `playground/src/workbench.hd`, `providers/workbench.mjs` | what hd cannot do: compile, run, show a place in the editor |
| The wire format | `playground/providers/compiler.mjs` | how to talk to `hd_web`, for the worker and the build |
| The editor | `web/playground/editor.mjs` | what an hdru event cannot: colors, and preventing Tab's default |
| The command log | `web/playground/log.mjs` | colors, and staying at the newest line |
| The pages | `web/playground/` | the HTML, the stylesheet, the workers and `build.mjs` |

**The program runs in a worker,** so one that never yields cannot freeze the page, and Stop or Run can terminate it.
This works because a `ui` program only emits commands: the worker forwards them, and the iframe applies them with the
same renderer any page uses. Tapping that stream is the command log.

**The preview is a sandboxed iframe** (`sandbox="allow-scripts"`), because `dom:attr:` lets a program set any attribute,
and a shared program should not get the page's origin that way. The program's other reach is limited by its wasm grants:
`Surface`, `Console` and `Clock`.

**The shell and the program are separate wasm instances,** as `ui` holds one UI per program.

## The editor

A textarea edits and shows the caret, with its text transparent. Behind it, an hdru `text` holds the same text, colored
with hd-lang's `classify` through the CSS Custom Highlight API, so coloring adds no DOM nodes. `::highlight()` can only
set colors and decoration, which keeps both layers' glyphs the same width, and problems are wavy underlines on the same
layer.

- The compiler's columns count characters, and JavaScript offsets count UTF-16 units. `rangeOf` converts, so an emoji
  earlier in a line does not shift what is underlined.
- An edit drops the underlines at once, since their places are stale. The problem rows stay until the next report, so
  the panel does not blink.
- Colors follow `classify`, which marks a name as a function only before `(`, so `column(...)` and `column:` differ. To
  change that, change `classify`.

## The compiler

The official playground compiles single packages. This one needs `ui` and its host trait, so it uses a wire goal that
registers packages with a session. The goal is not upstream yet: it is on `hd-web-packages` in
[Eric-Song-Nop/hd-lang](https://github.com/Eric-Song-Nop/hd-lang/tree/hd-web-packages), rebased on hd-lang's `main`.

Registered packages have fixed identities (`hdru:ui-dom`), so their host traits have fixed ABI names, and one generated
glue file serves every compile. `build.mjs` compiles a sample with the real compiler and runs `host_glue` on it. It
also compiles every example, so a broken example fails the build.

Measured once under Node on one machine: about 1.3 to 1.5 s for the first build, about 500 ms for a build after an edit,
and 15 to 20 ms for a check after an edit. The download has not been measured, at 5.7 MB raw and 1.9 MB gzipped.

## Build and run

You need `../hd-lang` on that branch, the `hd` binary built from it, cargo with the `wasm32-unknown-unknown` target, and
pnpm.

```sh
node web/playground/build.mjs                       # REBUILD_COMPILER=1 after changing hd-lang
python3 -m http.server -d web/playground/dist 8799
```

`build.mjs` reuses `hd-lang/website/playground/assets/hd_web.wasm` when it exists, so without `REBUILD_COMPILER=1` a
changed compiler is not picked up.

## Deploy

It is one static directory on Cloudflare Pages, deployed by hand. The project is not connected to Git, so pushing
changes nothing.

```sh
node web/playground/build.mjs
export CLOUDFLARE_ACCOUNT_ID=...   # the account that holds the hdru-playground project
bunx wrangler pages deploy web/playground/dist --project-name hdru-playground --branch main
```

The project already exists. If it ever has to be created again, `wrangler pages project create` needs `--force`: without
it, Wrangler hands new projects to Workers, which fails here for want of a configuration file.

Wrangler leaves a `.wrangler/` cache in the working directory, which can be deleted.

## Limits

- One file per program, and no REPL, formatting, autocomplete or share links.
- The browser path has been checked in Chrome only. A real Cmd+Z and an input method have not been checked.
- Warnings are drawn in yellow, but no program tried so far has produced one in a browser.
- Fonts come from Google Fonts. Offline, the stacks in `style.css` should fall back to system fonts; this has not been
  checked.
