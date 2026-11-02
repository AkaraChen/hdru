// The browser compiler's wire format (hd-lang crates/hd_web/src/wire.rs), for
// the compiler worker and for build.mjs under Node.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const leb = (out, value) => {
  let n = value >>> 0;
  do {
    const low = n & 0x7f;
    n >>>= 7;
    out.push(n ? low | 0x80 : low);
  } while (n);
};
const string = (out, text) => {
  const bytes = encoder.encode(text);
  leb(out, bytes.length);
  for (const byte of bytes) out.push(byte);
};
const head = (files, entry, goal) => {
  const out = [];
  leb(out, files.length);
  for (const [path, text] of files) {
    string(out, path);
    string(out, text);
  }
  string(out, entry);
  out.push(goal);
  return out;
};

export const ENTRY = "src/main.hd";
export const RUN = 0;
export const CHECK = 1;

// Instantiates the compiler and registers `packages`, each
// { name, files: [[path, text]], requires, hosts: [[trait, provider]], direct }.
export async function createCompiler(bytes, packages) {
  let memory;
  const imports = {
    hd_web: {
      nfc_utf8(input, length, output, capacity) {
        const text = decoder.decode(new Uint8Array(memory.buffer, input >>> 0, length >>> 0));
        const normal = encoder.encode(text.normalize("NFC"));
        if (capacity >>> 0 !== 0 && capacity >>> 0 >= normal.length) {
          new Uint8Array(memory.buffer, output >>> 0, normal.length).set(normal);
        }
        return normal.length;
      },
    },
  };
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  memory = instance.exports.memory;
  const x = instance.exports;
  const call = (request) => {
    const input = Uint8Array.from(request);
    // Take the view after the call: memory may grow during any call.
    const at = x.hd_input(input.length) >>> 0;
    new Uint8Array(memory.buffer, at, input.length).set(input);
    const status = x.hd_compile();
    const output = (kind) => {
      const start = x.hd_output(kind) >>> 0;
      const length = x.hd_output_len(kind) >>> 0;
      return new Uint8Array(memory.buffer, start, length);
    };
    return { status, json: JSON.parse(decoder.decode(output(0))), wasm: output(1).slice() };
  };
  for (const p of packages) {
    const request = head(p.files, "", 8);
    string(request, p.name);
    // Fixed, so the generated glue holds for every compile.
    string(request, `hdru:${p.name}`);
    leb(request, p.requires.length);
    for (const name of p.requires) string(request, name);
    leb(request, p.hosts.length);
    for (const [path, provider] of p.hosts) {
      string(request, path);
      string(request, provider);
    }
    request.push(p.direct ? 1 : 0);
    const answer = call(request);
    if (answer.status !== 0) throw new Error(`registering ${p.name}: ${JSON.stringify(answer.json)}`);
  }
  return {
    // One program in one file: { ok, diagnostics, wasm }.
    compile(source, goal) {
      const { status, json, wasm } = call(head([[ENTRY, source]], ENTRY, goal));
      if (status === 2) throw new Error(json.error);
      return { ok: status === 0, diagnostics: json.diagnostics, wasm };
    },
  };
}
