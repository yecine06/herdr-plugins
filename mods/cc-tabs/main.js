import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, agents, run, openOverlay, theme, window, shared, layout, settings, nextCommand, focused } from "herdr";
// The Asks engine (github.com/sachin-philip/herdr-agent-ask) runs here because the tab bar is
// always shown: asks are detected before the Asks panel (cc-asks) is ever opened.
import { Engine } from "./engine.js";
import { readState, loadConfig } from "./state.js";

// Cloned from Herdr's `tabs` (0.1.15): the side-panel buttons are ours.
const PANELS = [
  { id: "asks", label: "Asks", icon: "mods/cc-tabs/asks.svg" },
  { id: "inbox", label: "Inbox", icon: "mods/cc-tabs/inbox.svg" },
  { id: "linear", label: "ClickUp", icon: "mods/cc-tabs/linear.svg" },
  { id: "tasks", label: "Tasks", icon: "mods/cc-tabs/tasks.svg" },
  { id: "plans", label: "Plan", icon: "mods/cc-plans/plan.svg" },
  { id: "files", label: "Files", icon: "mods/files/file.svg" },
  { id: "changes", label: "Changes", icon: "mods/changes/changes.svg" },
];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The ClickUp task a tab works on, by its panes' branch (as cc-linear links them).
function issueOf(tabId, issues, allPanes) {
  const branches = allPanes.filter((p) => p.tab === tabId && p.branch).map((p) => p.branch.toLowerCase());
  return issues.find((i) => branches.some((b) => b === (i.branchName ?? "").toLowerCase() || b.includes(i.identifier.toLowerCase())))?.identifier ?? null;
}

// Keep in step with cc-inbox's sections.
const inboxCount = () =>
  (shared("cc.gardien") ?? []).filter((g) => g.deadline_ms > Date.now()).length +
  agents().filter((a) => a.status === "blocked" || a.status === "done").length +
  (shared("cc.github")?.prs ?? []).filter((p) => p.ci === "fail").length +
  (shared("cc.github")?.reviews ?? []).length +
  (shared("cc.settings")?.slack?.enabled === false ? 0 : (shared("cc.slack")?.items ?? []).filter((s) => s.kind === "ask" && !s.ticked).length);

function togglePanel(id, forceOpen = false) {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  if (!forceOpen && panel && !panel.hidden && body?.active === id) run("layout.hide", { id: "panel" });
  else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.engine = new Engine();
    const config = (cx) => cx.spawn(async (cx) => { this.engine.config = await loadConfig(); this.engine._backend = undefined; this.engine._codex = undefined; cx.notify(); });
    config(cx);
    cx.timer.every(30000, config);
    cx.timer.every(1000, (cx) => this.engine.tick(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (PANELS.some((p) => p.id === c)) togglePanel(c);
        if (c === "asks-open") togglePanel("asks", true);
        if (c === "asks-recheck") this.engine.recheck();
        if (c === "terminals") run("layout.select", { stack: "center", child: "main" });
        if (c === "board") run("layout.select", { stack: "center", child: "board" });
        cx.notify();
      }
    });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render(cx) {
    this.engine.tick(cx);
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const issues = shared("cc.linear")?.issues ?? [], allPanes = panes();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      const issue = issueOf(c.id, issues, allPanes);
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else { run("tab.select", { id: c.id }); run("layout.select", { stack: "center", child: "main" }); }
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(Boolean(issue), el => el.child(div().text_size(11).text_color(t.accent).child(issue)))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = PANELS.map((p) => p.id);
    this.syncPanel(space, panel, body, enabled);
    const count = inboxCount();
    // Pending asks: a count for the shown space, and a dim one when other spaces have some too.
    const pending = readState().asks.filter(a => a.state === "pending" && !a.notice);
    const here = pending.filter(a => a.space === (space?.id ?? focused()?.space)).length, elsewhere = pending.length - here;
    const asksBadge = pending.length ? h_flex().gap(3).items_center()
      .when(here > 0, el => el.child(div().h(16).min_w(16).px(5).rounded(8).flex().items_center().justify_center().text_size(10.5).font_semibold().bg(t.blocked).text_color(t.background).child(String(here))))
      .when(elsewhere > 0, el => el.child(div().text_size(10.5).text_color(t.dim).child(here ? `+${elsewhere}` : `${elsewhere} elsewhere`))) : null;
    const panelButton = ({ id, label, icon }) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => togglePanel(id))
        .child(svg(icon).size(14)).child(id === "asks" ? this.engine.config?.label ?? label : label)
        .when(id === "asks" && Boolean(asksBadge), el => el.child(asksBadge))
        .when(id === "inbox" && count > 0, el => el.child(div().text_size(11).font_semibold().text_color(t.blocked).child(String(count))));
    };
    const center = find(root, "center")?.active ?? "main";
    const seg = (id, label, icon) => h_flex().id(`center-${id}`).h(24).px(9).gap(5).items_center().rounded(5).text_size(12)
      .bg(center === id ? t.selected : t.chrome).text_color(center === id ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => run("layout.select", { stack: "center", child: id }))
      .child(svg(icon).size(13)).child(label);
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .when(Boolean(find(root, "center")), el => el
        .child(h_flex().flex_none().p(2).gap(2).rounded(7).border_1().border_color(t.border)
          .child(seg("main", "Terminals", "mods/workspace-chrome/terminal.svg"))
          .child(seg("board", "Board", "mods/cc-tabs/board.svg")))
        .child(div().w(1).h(18).mx(5).bg(t.border)))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      // "I don't use ClickUp" (settings) hides its button.
      .children(PANELS.filter((p) => p.id !== "linear" || shared("cc.settings")?.linear?.enabled !== false).map(panelButton))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
