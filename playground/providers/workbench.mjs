// The provider for `workbench.Workbench`: a compiler worker, and one run at a
// time as a worker plus a sandboxed iframe. The iframe is sandboxed because a
// program can set any attribute on its nodes (`dom:attr:`), and a shared
// program should not get the playground's origin that way. The worker keeps a
// program that never yields from freezing the page.

import { CHECK, ENTRY, RUN } from "./compiler.mjs";

const CHECK_DELAY_MS = 120;
// The key hd-lang's site stores its theme under, so the two agree on one origin.
const THEME_KEY = "hd-theme";

const problem = (message) => ({
  id: 0,
  line: 0,
  column: 0,
  end_line: 0,
  end_column: 0,
  code: "",
  severity: "error",
  message,
});

// A diagnostic as a row. One in another file, say a library the program broke,
// has no place in the editor, so its message names the file instead.
export function problemsOf(diagnostics) {
  return diagnostics.map((d, id) => {
    const here = d.line != null && (d.path == null || d.path === ENTRY);
    return {
      id,
      line: here ? d.line : 0,
      column: here ? (d.column ?? 1) : 0,
      end_line: here ? (d.endLine ?? 0) : 0,
      end_column: here ? (d.endColumn ?? 0) : 0,
      code: d.code ?? "",
      severity: d.severity,
      message: here || d.path == null ? d.message : `${d.path}${d.line != null ? `:${d.line}` : ""}: ${d.message}`,
    };
  });
}

// One command as the log shows it.
function propText(v) {
  if (v.tag === "Unset") return "Unset";
  if (v.tag === "Paint") return `rgba(${v.fields.color.r},${v.fields.color.g},${v.fields.color.b},${v.fields.color.a})`;
  if (v.tag === "Extent") return v.fields.size.tag + (v.fields.size.fields?.value ?? "");
  return JSON.stringify(v.fields.value);
}

function commandText({ tag, fields: f }) {
  switch (tag) {
    case "Create":
      return `Create(${f.node}, ${JSON.stringify(f.kind)})`;
    case "Append":
      return `Append(${f.parent}, ${f.child})`;
    case "MoveBefore":
      return `MoveBefore(${f.parent}, ${f.child}, ${f.before})`;
    case "Remove":
    case "Clear":
      return `${tag}(${f.node})`;
    case "SetText":
      return `SetText(${f.node}, ${JSON.stringify(f.text)})`;
    case "SetProp":
      return `SetProp(${f.node}) ${f.key}=${propText(f.value)}`;
    case "Listen":
      return `Listen(${f.node}, ${JSON.stringify(f.event)}, ${f.handler})`;
    default:
      return tag;
  }
}

// A batch as the log shows it. Consecutive properties of one node share a line,
// so a mount reads as its structure; the head still counts every command.
export function commandLog(commands) {
  const count = `${commands.length} command${commands.length === 1 ? "" : "s"}`;
  const lines = [`── batch · ${count}`];
  let props = null;
  const flush = () => {
    if (props) lines.push(`SetProp(${props.node}) ${props.items.join(" ")}`);
    props = null;
  };
  for (const command of commands) {
    if (command.tag !== "SetProp") {
      flush();
      lines.push(commandText(command));
      continue;
    }
    const { node, key, value } = command.fields;
    if (props?.node !== node) {
      flush();
      props = { node, items: [] };
    }
    props.items.push(`${key}=${propText(value)}`);
  }
  flush();
  return lines.join("\n");
}

// `editor` is { showProblems(source, problems), reveal(problem) }.
export function createWorkbench({ examples, compilerUrl, runnerUrl, previewUrl, editor }) {
  let current = null;
  const system = matchMedia("(prefers-color-scheme: dark)");
  // Storage can be blocked; the choice then lasts as long as the page.
  const remember = (dark) => {
    try {
      localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
    } catch {}
  };
  const remembered = () => {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch {
      return null;
    }
  };
  let choice = remembered();
  const scheme = () => choice ?? (system.matches ? "dark" : "light");
  // The stylesheet's colors, and the defaults of a program with no colors.
  const showScheme = () => {
    if (choice) document.documentElement.dataset.theme = choice;
    current?.frame.contentWindow?.postMessage({ scheme: scheme() }, "*");
  };
  system.addEventListener("change", () => {
    if (choice) return;
    showScheme();
    document.getElementById("shell")?.dispatchEvent(new CustomEvent("theme-change", { detail: scheme() }));
  });

  // The compiler, with its answers matched to requests by id.
  const pending = new Map();
  let nextId = 0;
  let compilerWorker = null;
  const compiler = () => {
    if (compilerWorker) return compilerWorker;
    compilerWorker = new Worker(compilerUrl, { type: "module" });
    compilerWorker.onmessage = ({ data }) => {
      pending.get(data.id)?.(data);
      pending.delete(data.id);
    };
    compilerWorker.onerror = (event) => {
      for (const resolve of pending.values()) resolve({ failed: event.message || "the compiler worker failed" });
      pending.clear();
      compilerWorker = null;
    };
    return compilerWorker;
  };
  const compile = (source, goal) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      compiler().postMessage({ id, source, goal });
    });
  const report = (answer) =>
    answer.failed !== undefined
      ? { ok: false, problems: [problem(answer.failed)] }
      : { ok: answer.ok, problems: problemsOf(answer.diagnostics) };

  const log = (text) => {
    document.getElementById("commands")?.dispatchEvent(new CustomEvent("preview-log", { detail: text }));
  };

  // The run in the preview.
  const stop = () => {
    if (!current) return;
    current.worker.terminate();
    removeEventListener("message", current.listen);
    current.frame.remove();
    current = null;
  };
  const start = (wasm) => {
    stop();
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("title", "preview");
    frame.style.cssText = "border:0;width:100%;height:100%;display:block";
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>*,*::before,*::after{box-sizing:border-box}:root{color-scheme:${scheme()};background:light-dark(#fff,#0f151c);color:light-dark(#18222b,#dbe6e8)}body{margin:0;padding:16px;font:14px/1.45 system-ui,sans-serif}button,input,textarea{font:inherit;color:inherit}input:not([type=checkbox]),textarea{background:transparent}</style></head><body><div id="app"></div><script src="${previewUrl}"></` + `script></body></html>`;
    document.getElementById("preview").replaceChildren(frame);

    const worker = new Worker(runnerUrl, { type: "module" });
    let ready = false;
    const early = [];
    const send = (commands) => {
      if (ready) frame.contentWindow.postMessage({ commands }, "*");
      else early.push(commands);
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "apply") {
        log(commandLog(data.commands));
        send(data.commands);
      } else if (data.type === "out") {
        log(data.text);
      } else if (data.type === "exit") {
        log(`── exited with status ${data.status}${data.trapped ? " (trapped)" : ""}`);
      }
    };
    worker.onerror = (event) => log(`── failed: ${event.message}`);
    const listen = ({ source, data }) => {
      if (source !== frame.contentWindow) return;
      if (data.ready) {
        ready = true;
        frame.contentWindow.postMessage({ scheme: scheme() }, "*");
        for (const commands of early.splice(0)) send(commands);
      } else if (data.event) {
        log(`▸ event · handler ${data.event.handler}${data.event.payload ? ` ${JSON.stringify(data.event.payload)}` : ""}`);
        worker.postMessage({ event: data.event });
      }
    };
    addEventListener("message", listen);
    current = { worker, frame, listen };
    worker.postMessage({ wasm }, [wasm.buffer]);
  };

  // Only the newest of the checks waiting out the delay reaches the compiler.
  let latestCheck = 0;
  return {
    example(name) {
      return examples[name] ?? `# no example called ${name}\n`;
    },
    async check(source) {
      const mine = ++latestCheck;
      await new Promise((resolve) => setTimeout(resolve, CHECK_DELAY_MS));
      if (mine !== latestCheck) return { ok: true, problems: [] };
      const result = report(await compile(source, CHECK));
      editor.showProblems(source, result.problems);
      return result;
    },
    async run(source) {
      const answer = await compile(source, RUN);
      const result = report(answer);
      if (result.ok) start(answer.wasm);
      else stop();
      return result;
    },
    stop() {
      stop();
    },
    prefers_dark() {
      showScheme();
      return scheme() === "dark";
    },
    set_dark(dark) {
      choice = dark ? "dark" : "light";
      remember(dark);
      showScheme();
    },
    reveal(place) {
      editor.reveal(place);
    },
  };
}

// `hd build` needs a provider here; only web/playground/main.js creates a real one.
export default {};
