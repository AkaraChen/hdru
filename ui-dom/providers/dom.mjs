// The provider for `surface.Surface`.
//
// In a browser it drives the real DOM under the element with id "app".
// Anywhere else (hd run --engine node) it keeps an in-memory tree, prints
// each command batch, and answers the events listed in UI_CLICKS, then
// handler 0 to stop. Each item is a handler id, optionally with a payload:
// "2,2,1" clicks, "4=milk,5" types "milk" into the field of handler 4.
//
// In the DOM, `SetAttr` of "value" or "checked" sets the property, which
// is what a field shows once the user has edited it. A `Listen` for
// "enter" is a keydown listener that reports Enter with the field's text;
// a checkbox's payload is "true" or "false".
//
// Commands arrive as { tag, fields }; an optional field is a value or
// null; node, handler and job ids are Numbers. `next_job` returns a
// Promise that a later `post_job` resolves, which is what lets the
// runtime's worker tasks wait for resource loads.
//
// Both factories are exported for providers/dom.test.mjs, which passes its
// own `nodes` map to check that removed nodes are forgotten.

// What an event on `target` reports: a checkbox's state, a field's text,
// or nothing for a button.
function payloadOf(target) {
  if (!target) return "";
  if (target.type === "checkbox") return String(target.checked);
  return "value" in target ? String(target.value) : "";
}

export function createDomSurface(root, nodes = new Map()) {
  nodes.set(0, root);
  const queue = [];
  let waiting = null;
  const push = (event) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(event);
    } else {
      queue.push(event);
    }
  };
  const node = (id) => {
    const found = nodes.get(id);
    if (!found) throw new Error(`ui: unknown node ${id}`);
    return found;
  };
  // Drops the map entry of every runtime node under `element`, so a removed
  // or cleared subtree can be collected.
  const forgetDescendants = (element) => {
    for (const child of element.querySelectorAll("[data-hd]")) nodes.delete(Number(child.dataset.hd));
  };
  const apply = (command) => {
    const f = command.fields;
    switch (command.tag) {
      case "Create": {
        const element =
          f.kind === "text" ? document.createElement("span") : document.createElement(f.kind);
        element.dataset.hd = String(f.node);
        nodes.set(f.node, element);
        break;
      }
      case "Append":
        node(f.parent).appendChild(node(f.child));
        break;
      case "MoveBefore":
        node(f.parent).insertBefore(node(f.child), f.before === null ? null : node(f.before));
        break;
      case "SetText":
        node(f.node).textContent = f.text;
        break;
      case "SetAttr": {
        const element = node(f.node);
        if (f.name === "value") element.value = f.value;
        else if (f.name === "checked") element.checked = f.value === "true";
        else element.setAttribute(f.name, f.value);
        break;
      }
      case "Listen": {
        const handler = f.handler;
        const element = node(f.node);
        if (f.event === "enter") {
          element.addEventListener("keydown", (domEvent) => {
            if (domEvent.key === "Enter") push({ handler, payload: payloadOf(domEvent.target) });
          });
        } else {
          element.addEventListener(f.event, (domEvent) => {
            push({ handler, payload: payloadOf(domEvent.target) });
          });
        }
        break;
      }
      case "Remove": {
        const element = node(f.node);
        forgetDescendants(element);
        element.remove();
        nodes.delete(f.node);
        break;
      }
      case "Clear": {
        const element = node(f.node);
        forgetDescendants(element);
        element.replaceChildren();
        break;
      }
      default:
        throw new Error(`ui: unknown command ${command.tag}`);
    }
  };
  const jobs = [];
  const jobWaiters = [];
  let batch = 0;
  return {
    post_job(job) {
      if (jobWaiters.length) jobWaiters.shift()(job);
      else jobs.push(job);
    },
    next_job() {
      if (jobs.length) return jobs.shift();
      return new Promise((resolve) => {
        jobWaiters.push(resolve);
      });
    },
    apply(commands) {
      batch += 1;
      console.log(`ui: batch ${batch}: ${commands.length} command(s)`);
      for (const command of commands) {
        apply(command);
        console.log(`ui:   ${command.tag} ${JSON.stringify(command.fields)}`);
      }
    },
    next_event() {
      if (queue.length) return queue.shift();
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
  };
}

export function createScriptedSurface(clicks, print, nodes = new Map()) {
  nodes.set(0, { id: 0, kind: "root", children: [], text: "", attrs: {} });
  const node = (id) => {
    const found = nodes.get(id);
    if (!found) throw new Error(`ui: unknown node ${id}`);
    return found;
  };
  const forget = (n) => {
    for (const child of n.children) forget(child);
    nodes.delete(n.id);
  };
  const detach = (child) => {
    for (const parent of nodes.values()) {
      const index = parent.children.indexOf(child);
      if (index >= 0) parent.children.splice(index, 1);
    }
  };
  const describe = (command) => {
    const f = command.fields;
    const parts = Object.entries(f).map(([k, v]) => `${k}=${v === null ? "none" : JSON.stringify(v)}`);
    return `${command.tag} ${parts.join(" ")}`;
  };
  const apply = (command) => {
    const f = command.fields;
    switch (command.tag) {
      case "Create":
        nodes.set(f.node, { id: f.node, kind: f.kind, children: [], text: "", attrs: {} });
        break;
      case "Append":
        detach(node(f.child));
        node(f.parent).children.push(node(f.child));
        break;
      case "MoveBefore": {
        const child = node(f.child);
        detach(child);
        const siblings = node(f.parent).children;
        const index = f.before === null ? siblings.length : siblings.indexOf(node(f.before));
        siblings.splice(index < 0 ? siblings.length : index, 0, child);
        break;
      }
      case "SetText":
        node(f.node).text = f.text;
        break;
      case "SetAttr":
        node(f.node).attrs[f.name] = f.value;
        break;
      case "Listen":
        node(f.node).attrs[`on:${f.event}`] = String(f.handler);
        break;
      case "Remove": {
        const target = node(f.node);
        detach(target);
        forget(target);
        break;
      }
      case "Clear": {
        const target = node(f.node);
        for (const child of target.children) forget(child);
        target.children = [];
        break;
      }
      default:
        throw new Error(`ui: unknown command ${command.tag}`);
    }
  };
  const render = (n, depth) => {
    const pad = "  ".repeat(depth);
    const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
    const text = n.text ? ` "${n.text}"` : "";
    const lines = [`${pad}<${n.kind}#${n.id}${attrs}>${text}`];
    for (const child of n.children) lines.push(...render(child, depth + 1));
    return lines;
  };
  const jobs = [];
  const jobWaiters = [];
  let batch = 0;
  return {
    post_job(job) {
      if (job !== 0) print(`-- job ${job} posted`);
      if (jobWaiters.length) jobWaiters.shift()(job);
      else jobs.push(job);
    },
    next_job() {
      if (jobs.length) return jobs.shift();
      return new Promise((resolve) => {
        jobWaiters.push(resolve);
      });
    },
    apply(commands) {
      batch += 1;
      print(`-- batch ${batch}: ${commands.length} command(s)`);
      for (const command of commands) {
        apply(command);
        print(`   ${describe(command)}`);
      }
      print(render(node(0), 0).join("\n"));
    },
    next_event() {
      if (!clicks.length) {
        print("-- no more scripted events; stopping");
        return { handler: 0, payload: "" };
      }
      const { handler, payload } = clicks.shift();
      print(payload === "" ? `-- click handler ${handler}` : `-- event for handler ${handler}: ${JSON.stringify(payload)}`);
      return { handler, payload };
    },
  };
}

const inBrowser = typeof document !== "undefined" && typeof document.getElementById === "function";

export default inBrowser
  ? createDomSurface(document.getElementById("app") ?? document.body)
  : createScriptedSurface(
      (globalThis.process?.env?.UI_CLICKS ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length)
        .map((item) => {
          const at = item.indexOf("=");
          return at < 0
            ? { handler: Number(item), payload: "" }
            : { handler: Number(item.slice(0, at)), payload: item.slice(at + 1) };
        }),
      (line) => console.log(line),
    );
