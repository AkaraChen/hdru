// The browser demo: runs the example named by <body data-app> on the main
// thread over the platform-neutral core host, binding ui-dom/providers/dom.mjs to
// the package host trait through the glue `hd build` generated. Every
// example shares one glue file because the trait is the ui package's.
import { createWebHost } from "../../hd-lang/host/web.ts";
import { createPackageRuntime } from "../../hd-lang/host/package-providers.ts";
import * as generated from "../examples/counter/build/debug/counter.host.mjs";
import surface from "../ui-dom/providers/dom.mjs";

const app = document.body.dataset.app ?? "counter";
const status = document.getElementById("status");
const say = (text) => {
  status.textContent = text;
  console.log(`ui: ${text}`);
};

async function main() {
  const bytes = await fetch(`./dist/${app}.wasm`).then((response) => response.arrayBuffer());
  const module = await WebAssembly.compile(bytes);
  const root = generated.interfaces.find((item) => !item.handle);
  const providers = new Map([[root.module, surface]]);
  const host = createWebHost(
    { out: (text) => console.log(text), err: (text) => console.error(text) },
    {
      program: app,
      args: [],
      module,
      grants: { [root.selectors[0]]: true, Console: true },
      createPackageRuntime,
      packageBindings: (runtime) => generated.bind(runtime, providers),
    },
  );
  say("running");
  try {
    const instance = await WebAssembly.instantiate(module, host.imports);
    const result = await host.run(instance, "hd.init", "hd.poll");
    say(`exited with status ${result.status}${result.trapped ? " (trapped)" : ""}`);
  } catch (error) {
    say(`failed: ${error && error.message ? error.message : error}`);
    throw error;
  } finally {
    host.close();
  }
}

main();
