// Runs one user program. Its Surface forwards commands to the page and waits
// for events from it; the page ends a run by terminating this worker.
import { createWebHost } from "../../../hd-lang/host/web.ts";
import { createPackageRuntime } from "../../../hd-lang/host/package-providers.ts";
import * as generated from "./gen/run.host.mjs";

const events = [];
let waiting = null;
const surface = {
  apply(commands) {
    self.postMessage({ type: "apply", commands });
  },
  next_event() {
    if (events.length) return events.shift();
    return new Promise((resolve) => {
      waiting = resolve;
    });
  },
};

async function run(wasm) {
  const module = await WebAssembly.compile(wasm);
  const root = generated.interfaces.find((item) => !item.handle);
  const say = (text) => self.postMessage({ type: "out", text });
  const host = createWebHost(
    { out: say, err: say },
    {
      program: "playground",
      args: [],
      module,
      grants: { [root.selectors[0]]: true, Console: true, Clock: true },
      createPackageRuntime,
      packageBindings: (runtime) => generated.bind(runtime, new Map([[root.module, surface]])),
    },
  );
  const instance = await WebAssembly.instantiate(module, host.imports);
  const result = await host.run(instance, "hd.init", "hd.poll");
  self.postMessage({ type: "exit", status: result.status, trapped: result.trapped });
}

self.onmessage = ({ data }) => {
  if (data.wasm) {
    run(data.wasm).catch((error) => self.postMessage({ type: "out", text: `failed: ${error?.message ?? error}` }));
  } else if (waiting) {
    const resolve = waiting;
    waiting = null;
    resolve(data.event);
  } else {
    events.push(data.event);
  }
};
