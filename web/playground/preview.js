// Inside the sandboxed preview iframe: applies commands from the page with the
// real DOM renderer, and reports events back.
import { createDomSurface } from "../../ui-dom/providers/dom.mjs";

// The page's Commands panel already shows every command.
const surface = createDomSurface(document.getElementById("app"), new Map(), () => {}, () => {});

addEventListener("message", ({ source, data }) => {
  if (source !== parent) return;
  if (data.scheme) document.documentElement.style.colorScheme = data.scheme;
  else surface.apply(data.commands);
});

(async () => {
  while (true) parent.postMessage({ event: await surface.next_event() }, "*");
})();
parent.postMessage({ ready: true }, "*");
