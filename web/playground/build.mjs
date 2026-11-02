// Builds the playground into web/playground/dist/. Needs the hd binary, cargo,
// pnpm and the patched hd-lang checkout beside this repository.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUN, createCompiler } from "../../playground/providers/compiler.mjs";
import { logoSvg } from "../../../hd-lang/website/src/logo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const hdLang = resolve(root, "../hd-lang");
const gen = join(here, "gen");
const dist = join(here, "dist");
mkdirSync(gen, { recursive: true });
mkdirSync(dist, { recursive: true });
const sh = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });

function sourceFiles(dir, base = "src") {
  const files = [];
  for (const entry of readdirSync(join(dir, base), { withFileTypes: true })) {
    const path = `${base}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFiles(dir, path));
    else if (entry.name.endsWith(".hd")) files.push([path, readFileSync(join(dir, path), "utf8")]);
  }
  return files;
}

// One example as the single file the playground edits: its browser entry,
// less the line importing the app, above its library.
function singleFile(name) {
  const dir = join(root, "examples", name, "src");
  const main = readFileSync(join(dir, "main.hd"), "utf8").replace("use pkg.app\n", "");
  const uses = main.slice(0, main.indexOf("pub fn main"));
  const entry = main.slice(uses.length);
  return `${uses}${readFileSync(join(dir, "lib.hd"), "utf8")}\n${entry}`;
}

const packages = [
  { name: "reactive", files: sourceFiles(join(root, "reactive")), requires: [], hosts: [], direct: false },
  { name: "ui", files: sourceFiles(join(root, "ui")), requires: ["reactive"], hosts: [], direct: true },
  {
    name: "ui-dom",
    files: sourceFiles(join(root, "ui-dom")),
    requires: ["ui"],
    hosts: [["surface.Surface", "providers/dom.mjs"]],
    direct: true,
  },
];
const examples = {
  counter: singleFile("counter"),
  todos: singleFile("todos"),
  fetcher: singleFile("fetcher"),
  "type-error": readFileSync(join(root, "playground/examples/type-error.hd"), "utf8"),
};
writeFileSync(join(gen, "sources.json"), JSON.stringify({ packages }));
writeFileSync(join(gen, "examples.json"), JSON.stringify({ examples }));

// The shell.
sh("hd", ["build"], join(root, "playground"));
copyFileSync(join(root, "playground/build/debug/playground.wasm"), join(dist, "playground.wasm"));

// The compiler.
const compilerWasm = join(hdLang, "website/playground/assets/hd_web.wasm");
if (!existsSync(compilerWasm) || process.env.REBUILD_COMPILER) {
  sh("node", ["scripts/build-web-compiler.js"], hdLang);
}
copyFileSync(compilerWasm, join(dist, "hd_web.wasm"));

// Every compile's identities are fixed, so one generated glue serves them all.
// Every example is compiled, to fail here if one does not build.
const compiler = await createCompiler(readFileSync(compilerWasm), packages);
let sample = null;
for (const [name, source] of Object.entries(examples)) {
  const { ok, diagnostics, wasm } = compiler.compile(source, RUN);
  if (name === "type-error") {
    if (ok) throw new Error("the type-error example compiled");
    continue;
  }
  if (!ok) throw new Error(`example ${name}: ${JSON.stringify(diagnostics.slice(0, 3))}`);
  sample ??= wasm;
}
const samplePath = join(gen, "sample.wasm");
writeFileSync(samplePath, sample);
sh("cargo", ["run", "-q", "-p", "hd_web", "--example", "host_glue", "--", samplePath, join(gen, "run.host.mjs")], hdLang);

// The pages.
const esbuild = ["dlx", "esbuild@0.28.2", "--bundle", "--platform=browser", "--target=es2022", "--log-level=warning"];
sh("pnpm", [...esbuild, "--format=esm", `--outdir=${dist}`, join(here, "main.js"), join(here, "compiler-worker.js"), join(here, "run-worker.js")], here);
sh("pnpm", [...esbuild, "--format=iife", `--outfile=${join(dist, "preview.js")}`, join(here, "preview.js")], here);
copyFileSync(join(here, "index.html"), join(dist, "index.html"));
copyFileSync(join(here, "style.css"), join(dist, "style.css"));
// The site's logo.
for (const name of ["mark.svg", "favicon.svg"]) copyFileSync(join(hdLang, "website/assets", name), join(dist, name));
// mark.svg holds the dark theme's colors. The light mark is the site's own
// drawing with the light value of each token it names.
const siteCss = readFileSync(join(hdLang, "website/assets/style.css"), "utf8");
const lightOf = (token) => {
  const declared = new RegExp(`${token}:\\s*(?:light-dark\\(\\s*([^,)]+),[^;]*|([^;]+));`).exec(siteCss);
  if (!declared) throw new Error(`the site's style.css has no ${token}`);
  return (declared[1] ?? declared[2]).trim();
};
const lightMark = logoSvg({ id: "hd", variant: "mark", className: "" }).replace(/var\((--[a-z0-9-]+)\)/g, (_, token) => lightOf(token));
writeFileSync(join(dist, "mark-light.svg"), lightMark);
console.log(`built ${dist}`);
