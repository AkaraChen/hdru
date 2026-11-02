// Runs the compiler off the page. A compiler panic kills its instance, so the
// next request builds a fresh one.
import { createCompiler } from "../../playground/providers/compiler.mjs";
import sources from "./gen/sources.json";

const wasm = fetch(new URL("./hd_web.wasm", import.meta.url)).then((r) => r.arrayBuffer());
let compiler = null;

self.onmessage = async ({ data: { id, source, goal } }) => {
  try {
    compiler ??= await createCompiler(await wasm, sources.packages);
    const answer = compiler.compile(source, goal);
    self.postMessage({ id, ...answer }, [answer.wasm.buffer]);
  } catch (error) {
    compiler = null;
    self.postMessage({ id, failed: String(error?.message ?? error) });
  }
};
