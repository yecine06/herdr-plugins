// Hints over the focused terminal: URLs, file paths, tickets, hashes and IPs on screen, each behind a letter.
// A letter opens it (browser, VS Code at the line, Finder, ClickUp, Preview), Shift+letter copies it.
// Drawn as a popup list, not as badges over the text: popups are the overlay kind that renders reliably.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { focused, hc, exec, home, appHome, readTextFile, props, closeOverlay, theme, notify } from "herdr";
import { extract, hints, ALPHABET } from "./extract.js";

const FILTERS = [
  { id: "all", label: "All", keep: () => true },
  { id: "links", label: "Links", keep: (i) => i.type === "url" || ((i.type === "ticket" || i.type === "mr") && i.url) },
  { id: "files", label: "Files", keep: (i) => i.type === "file" || i.type === "image" },
  { id: "refs", label: "Refs", keep: (i) => i.type === "hash" || i.type === "ip" || i.type === "ticket" || i.type === "mr" },
];
const BADGE = { url: "URL", ticket: "TICKET", file: "FILE", image: "IMAGE", hash: "SHA", ip: "IP", mr: "MR" };
const MAX_ROWS = 14;

export default class Hints extends View {
  init(_props, cx) {
    const f = focused();
    // The terminal shown in the focused pane (a peek or replacement included); never another pane.
    this.terminal = f?.shown ?? f?.terminal ?? f?.agent;
    this.items = [];
    this.filter = 0;
    this.prefix = "";
    this.at = 0;
    this.loading = Boolean(this.terminal);
    this.error = this.terminal ? "" : "Focus a terminal, then press the shortcut again.";
    this.handle = cx.focus_handle();
    this.handle.focus();
    if (!this.terminal) return;
    cx.spawn(async (cx) => {
      try {
        // Screen only: asking for history can send scroll input to a full-screen program.
        const [read, info] = await Promise.all([hc(["read", "--json", "--lines", "0", this.terminal]), hc(["get", "--json", this.terminal])]);
        if (read.code !== 0) throw new Error("Couldn't read this terminal.");
        const screen = JSON.parse(read.stdout);
        const meta = info.code === 0 ? JSON.parse(info.stdout) : {};
        // Tracker URLs hold workspace IDs, so they live in the app folder, not in this repo.
        let trackers = {}, mrs = {};
        try { { const cfg = JSON.parse((await readTextFile(`${appHome()}/hints.json`)) ?? "{}"); trackers = cfg.trackers ?? {}; mrs = cfg.mrs ?? {}; } } catch {}
        this.cwd = meta.foreground?.cwd ?? meta.cwd;
        this.items = extract(screen.text ?? "", meta.cols, trackers, mrs);
      } catch (e) {
        this.error = e?.message ?? "Couldn't read this terminal.";
      }
      this.loading = false;
      cx.notify();
    });
  }

  close() { closeOverlay(props().overlay); }

  // Hints are given per filter, so the visible list always starts at "a".
  rows() {
    const list = this.items.filter(FILTERS[this.filter].keep);
    const labels = hints(list.length);
    return list.map((item, i) => ({ ...item, hint: labels[i] }));
  }

  shown() { return this.rows().filter((r) => r.hint.startsWith(this.prefix)); }

  resolve(file) {
    if (file.startsWith("~/")) return home() + file.slice(1);
    if (file.startsWith("/")) return file;
    return this.cwd ? `${this.cwd.replace(/\/$/, "")}/${file.replace(/^\.\//, "")}` : null;
  }

  activate(item, copy, cx) {
    if (!item || this.busy) return;
    // Files on a remote machine can't be opened here.
    const remote = this.terminal.includes("/");
    if (copy || item.type === "hash" || item.type === "ip" || ((item.type === "ticket" || item.type === "mr") && !item.url) || (remote && item.file)) {
      cx.write_to_clipboard(item.value);
      notify({ title: "Copied", body: item.value, timeout: 2 });
      return this.close();
    }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        // Screen text decides what opens, so never hand a path to the default handler: a folder named
        // "X.app" would launch. Folders are revealed in Finder, images forced into Preview.
        let args = [item.url ?? item.value];
        if (item.file) {
          const abs = this.resolve(item.file);
          if (!abs || (await exec("test", ["-e", abs])).code !== 0) throw new Error(`Not found from ${this.cwd ?? "this terminal"}: ${item.file}`);
          const folder = (await exec("test", ["-d", abs])).code === 0;
          args = folder ? ["-R", abs] : item.type === "image" ? ["-a", "Preview", abs] : [`vscode://file${encodeURI(abs)}${item.line ? `:${item.line}` : ""}`];
        }
        const r = await exec("open", args);
        if (r.code !== 0) throw new Error((r.stderr || "Couldn't open it").trim().split("\n")[0]);
        this.close();
      } catch (e) {
        this.error = e?.message ?? String(e);
        this.prefix = "";
        cx.notify();
      } finally {
        this.busy = false;
      }
    });
  }

  key(event, cx) {
    // Every key stays here while the popup is open: nothing reaches the agent behind it.
    cx.stop_propagation();
    const m = event.modifiers;
    if (event.key === "escape" || event.keystroke?.toLowerCase() === "ctrl-c") return this.close();
    if (event.is_held || this.loading) return;
    if (m.control || m.alt || m.platform || m.function) return;
    const shown = this.shown();
    if (event.key === "tab") {
      this.filter = (this.filter + (m.shift ? FILTERS.length - 1 : 1)) % FILTERS.length;
      this.prefix = ""; this.at = 0; this.error = "";
    } else if (event.key === "backspace") {
      this.prefix = this.prefix.slice(0, -1); this.at = 0;
    } else if (event.key === "up" || event.key === "down") {
      if (shown.length) this.at = (this.at + (event.key === "up" ? -1 : 1) + shown.length) % shown.length;
    } else if (event.key === "enter" || event.key === "return") {
      return this.activate(shown[this.at], m.shift, cx);
    } else {
      const ch = event.key_char ?? (event.key.length === 1 ? event.key : "");
      const lower = ch.toLowerCase();
      if (!lower || !ALPHABET.includes(lower)) return;
      const next = this.prefix + lower;
      const rows = this.rows();
      if (!rows.some((r) => r.hint.startsWith(next))) return;
      const hit = rows.find((r) => r.hint === next);
      if (hit) return this.activate(hit, m.shift || ch !== lower, cx);
      this.prefix = next; this.at = 0;
    }
    cx.notify();
  }

  render() {
    const t = theme();
    const shown = this.shown();
    this.at = Math.min(this.at, Math.max(0, shown.length - 1));
    const start = Math.max(0, Math.min(this.at - Math.floor(MAX_ROWS / 2), shown.length - MAX_ROWS));
    const visible = shown.slice(start, start + MAX_ROWS);
    const message = this.loading ? "Reading the screen…" : this.error || (!shown.length ? "Nothing to select on this screen." : "");
    return v_flex().id("cc-hints").size_full().p(10).gap(6)
      .bg(t.popover).text_color(t.foreground).text_size(12)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().items_center().gap(6)
        .children(FILTERS.map((f, i) => div().id(`f-${f.id}`).px(6).py(1).rounded(4).cursor_pointer()
          .bg(i === this.filter ? t.selected : t.popover).text_color(i === this.filter ? t.foreground : t.muted)
          .on_click((_e, cx) => { this.filter = i; this.prefix = ""; this.at = 0; cx.notify(); })
          .child(f.label)))
        .when(Boolean(this.prefix), (el) => el.child(div().px(5).rounded(3).bg(t.input).text_color(t.accent)
          .font_family("JetBrains Mono").child(this.prefix.toUpperCase())))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.muted).truncate().child(this.cwd ?? "")))
      .child(v_flex().flex_1().min_h(0).gap(2)
        .when(Boolean(message), (el) => el.child(div().py(8).text_color(this.error ? t.danger ?? t.accent : t.muted).child(message)))
        .children(visible.map((item, i) => h_flex().id(`hint-${item.hint}`).h(26).flex_none().px(6).gap(8).items_center().rounded(4)
          .bg(start + i === this.at ? t.selected : t.popover).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((e, cx) => this.activate(item, e.modifiers.shift, cx))
          .child(div().w(24).flex_none().font_family("JetBrains Mono").font_semibold().text_color(t.accent).child(item.hint.toUpperCase()))
          .child(div().w(48).flex_none().text_size(10).text_color(t.muted).child(BADGE[item.type]))
          .child(div().flex_1().min_w(0).truncate().font_family("JetBrains Mono").child(item.value)))))
      .child(div().border_t(1).border_color(t.border).pt(6).text_size(10.5).text_color(t.muted)
        .child(`Letter opens · Shift+letter copies · ↑↓ Enter · Tab filter · Esc closes${shown.length > MAX_ROWS ? ` · ${this.at + 1}/${shown.length}` : ""}`));
  }
}
