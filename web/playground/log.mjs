// The command log's two touches its text node cannot carry: it stays at its
// newest line unless the reader scrolled up, and its heads are colored.
const STUCK_WITHIN_PX = 24;

function attach(pane) {
  const layer = pane.querySelector("span");
  let stuck = true;
  pane.addEventListener("scroll", () => {
    stuck = pane.scrollHeight - pane.scrollTop - pane.clientHeight < STUCK_WITHIN_PX;
  });
  const paint = () => {
    const node = layer.firstChild;
    if (typeof Highlight === "undefined") return;
    const heads = [];
    const events = [];
    if (node) {
      let at = 0;
      for (const line of node.data.split("\n")) {
        const group = line.startsWith("──") ? heads : line.startsWith("▸") ? events : null;
        group?.push(new StaticRange({ startContainer: node, startOffset: at, endContainer: node, endOffset: at + line.length }));
        at += line.length + 1;
      }
    }
    CSS.highlights.set("log-head", new Highlight(...heads));
    CSS.highlights.set("log-event", new Highlight(...events));
  };
  new MutationObserver(() => {
    paint();
    if (stuck || !layer.textContent) pane.scrollTop = pane.scrollHeight;
  }).observe(layer, { childList: true, characterData: true, subtree: true });
}

export function watchLog(root) {
  const tryAttach = () => {
    const pane = root.querySelector("#commands");
    if (!pane?.querySelector("span")) return false;
    attach(pane);
    return true;
  };
  if (tryAttach()) return;
  const watcher = new MutationObserver(() => {
    if (tryAttach()) watcher.disconnect();
  });
  watcher.observe(root, { childList: true, subtree: true });
}
