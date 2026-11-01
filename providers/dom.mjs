// The provider for `surface.Surface`.
//
// In a browser it drives the real DOM under the element with id "app".
// Anywhere else (hd run --engine node) it keeps an in-memory tree, prints
// each command batch, and answers the clicks listed in UI_CLICKS
// ("2,2,1"), then handler 0 to stop.
//
// Commands arrive as { tag, fields }; an optional field is a value or
// null; node and handler ids are Numbers.

function createDomSurface(root) {
  const nodes = new Map([[0, root]]);
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
      case "SetAttr":
        node(f.node).setAttribute(f.name, f.value);
        break;
      case "Listen": {
        const handler = f.handler;
        node(f.node).addEventListener(f.event, (domEvent) => {
          const payload = domEvent.target && "value" in domEvent.target ? String(domEvent.target.value) : "";
          push({ handler, payload });
        });
        break;
      }
      case "Remove": {
        const element = node(f.node);
        element.remove();
        nodes.delete(f.node);
        break;
      }
      case "Clear":
        node(f.node).replaceChildren();
        break;
      default:
        throw new Error(`ui: unknown command ${command.tag}`);
    }
  };
  let batch = 0;
  return {
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

function createScriptedSurface(clicks, print) {
  const nodes = new Map([[0, { id: 0, kind: "root", children: [], text: "", attrs: {} }]]);
  const node = (id) => {
    const found = nodes.get(id);
    if (!found) throw new Error(`ui: unknown node ${id}`);
    return found;
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
      case "Remove":
        detach(node(f.node));
        nodes.delete(f.node);
        break;
      case "Clear":
        node(f.node).children = [];
        break;
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
  let batch = 0;
  return {
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
      const handler = clicks.shift();
      print(`-- click handler ${handler}`);
      return { handler, payload: "" };
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
        .map(Number),
      (line) => console.log(line),
    );
