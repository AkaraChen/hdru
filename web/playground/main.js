// Runs the playground's shell, itself an hdru program, on the main thread.
import { createWebHost } from "../../../hd-lang/host/web.ts";
import { createPackageRuntime } from "../../../hd-lang/host/package-providers.ts";
import * as generated from "../../playground/build/debug/playground.host.mjs";
import { createDomSurface } from "../../ui-dom/providers/dom.mjs";
import { createWorkbench } from "../../playground/providers/workbench.mjs";
import { createEditor } from "./editor.mjs";
import { attachLog } from "./log.mjs";
import sources from "./gen/examples.json";

const here = (path) => new URL(path, import.meta.url).href;
const editor = createEditor();
// The element table the renderer fills, which is how a node id finds its element.
const nodes = new Map();
const workbench = createWorkbench({
  editor,
  nodes,
  onBound(role, element) {
    if (role === "commands") attachLog(element);
    else if (role.startsWith("editor-")) editor.bind(role, element);
  },
  examples: sources.examples,
  compilerUrl: here("./compiler-worker.js"),
  runnerUrl: here("./run-worker.js"),
  previewUrl: here("./preview.js"),
});

// The Commands panel shows the preview's commands; the shell's own need no trace.
const surface = createDomSurface(document.getElementById("app"), nodes, undefined, () => {});

const roots = generated.interfaces.filter((item) => !item.handle);
const providerOf = (item) => (item.identity.trait_path.endsWith("Workbench") ? workbench : surface);
const grants = { Console: true };
for (const item of roots) grants[item.selectors[0]] = true;

const bytes = await fetch(here("./playground.wasm")).then((r) => r.arrayBuffer());
const module = await WebAssembly.compile(bytes);
const host = createWebHost(
  { out: (text) => console.info(text), err: (text) => console.error(text) },
  {
    program: "playground",
    args: [],
    module,
    grants,
    createPackageRuntime,
    packageBindings: (runtime) => generated.bind(runtime, new Map(roots.map((item) => [item.module, providerOf(item)]))),
  },
);
const instance = await WebAssembly.instantiate(module, host.imports);
await host.run(instance, "hd.init", "hd.poll");
