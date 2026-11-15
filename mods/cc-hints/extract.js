// Pure extraction of selectable items from a terminal screen. No herdr imports, so `node test.mjs` can run it.


// Home row first: the most likely picks get the easiest keys.
export const ALPHABET = "asdfjklghqwertyuiopzxcvbnm";

const URL_RE = /\bhttps?:\/\/[^\s<>"'`|│]+/g;
const PATH_RE = /(?:~|\.{1,2})?\/?(?:[\w.@+-]+\/)+[\w.@+-]+(?::\d+(?::\d+)?)?|\b[\w.-]+\.[A-Za-z]\w{0,9}:\d+(?::\d+)?/g;
const TICKET_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g;
const SHA_RE = /\b[0-9a-f]{7,40}\b/g;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g;

const IMAGE = /\.(png|jpe?g|gif|webp|svg|heic|bmp|tiff?)$/i;

// Trailing punctuation belongs to the sentence, not the item; a ")" only stays when it closes a "(" inside.
function trimEnd(value) {
  let v = value.replace(/[.,;:!?'"»]+$/, "");
  while (v.endsWith(")") && (v.match(/\(/g)?.length ?? 0) < (v.match(/\)/g)?.length ?? 0)) v = v.slice(0, -1).replace(/[.,;:!?]+$/, "");
  return v;
}

// A line that fills the terminal width was soft-wrapped: glue it to the next one so long URLs stay whole.
export function logicalLines(text, cols) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    while (cols && [...lines[i]].length >= cols && i + 1 < lines.length) line += lines[++i];
    out.push(line);
  }
  return out;
}

function pathKind(raw) {
  // A trailing slash marks a folder; keep the folder.
  const value = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
  const [file, line] = value.split(/:(?=\d)/);
  const last = file.split("/").pop();
  // Needs a path anchor or a real extension, so "93k/1.0M" or "11/15" are not files.
  if (!/^(~|\.{1,2}\/|\/)/.test(file) && !/\.[A-Za-z]\w*$/.test(last)) return null;
  if (!/[A-Za-z]/.test(last)) return null;
  return { type: IMAGE.test(file) ? "image" : "file", value, file, line: line ? Number(line) : undefined };
}

// Items from the bottom of the screen up, so the most recent output gets the first hints.
// trackers: { PREFIX: "https://tracker/base/" }, read from the app's hints.json, never from the code.
// A ticket whose prefix is listed opens at base + key; any other KEY-123 is only copied.
export function extract(text, cols, trackers = {}) {
  const seen = new Set();
  const items = [];
  const add = (item) => {
    if (!item || seen.has(item.value)) return;
    seen.add(item.value);
    items.push(item);
  };
  for (const line of logicalLines(text, cols).reverse()) {
    const found = [];
    const taken = [];
    const free = (start, end) => !taken.some(([s, e]) => start < e && end > s);
    const scan = (re, make) => {
      for (const m of line.matchAll(re)) {
        const value = trimEnd(m[0]);
        const start = m.index, end = start + value.length;
        // "…/Code/x" is a shortened path that can't be resolved.
        if (!value || !free(start, end) || line[start - 1] === "…") continue;
        const item = make(value);
        if (!item) continue;
        taken.push([start, end]);
        found.push({ ...item, at: start });
      }
    };
    scan(URL_RE, (v) => ({ type: "url", value: v }));
    scan(PATH_RE, pathKind);
    scan(TICKET_RE, (v) => ({ type: "ticket", value: v, url: trackers[v.split("-")[0]] ? trackers[v.split("-")[0]] + v : undefined }));
    scan(IP_RE, (v) => ({ type: "ip", value: v }));
    scan(SHA_RE, (v) => (/[a-f]/.test(v) && /\d/.test(v) ? { type: "hash", value: v } : null));
    // Right to left within a line, matching the bottom-up order.
    found.sort((a, b) => b.at - a.at).forEach(({ at, ...item }) => add(item));
  }
  return items;
}

// Prefix-free labels: single letters while they suffice, then two letters for everything.
export function hints(count) {
  const n = ALPHABET.length;
  if (count <= n) return [...ALPHABET].slice(0, count);
  const out = [];
  for (const a of ALPHABET) for (const b of ALPHABET) if (out.length < count) out.push(a + b);
  return out;
}
