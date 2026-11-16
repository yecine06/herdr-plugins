// The Board: every piece of work as one card (agent + ClickUp task + PR, joined by branch), in four columns.
// Click a card to select its tab (the Tasks panel shows its summary); Open goes to its terminal.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, spaces, panes, shared, setShared, theme, run, exec, openOverlay, knownAgents, home } from "herdr";

const COLUMNS = [
  { id: "needs", name: "Needs you", tone: "blocked" },
  { id: "progress", name: "In progress", tone: "working" },
  { id: "review", name: "In review", tone: "done" },
  { id: "todo", name: "Todo", tone: "dim" },
];
const PRIORITY = { 1: "Urgent", 2: "High" };

function since(ms) {
  if (!ms) return "";
  const m = Math.floor((Date.now() - ms) / 60_000);
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
const issueFor = (branch, issues) => {
  const b = (branch ?? "").toLowerCase();
  return b ? issues.find((i) => b === (i.branchName ?? "").toLowerCase() || b.includes(i.identifier.toLowerCase())) ?? null : null;
};

export default class Board extends View {
  init(_props, cx) {
    this.filter = localStorage.getItem("filter") ?? "all";
    this.claude = ["claude"];
    cx.timer.every(60_000, (cx) => cx.notify());
    cx.spawn(async () => {
      const found = (await knownAgents().catch(() => [])).find((a) => a.key === "claude");
      if (found?.run?.length) this.claude = found.run;
    });
  }

  // One card per tab that has an agent, a ClickUp task or a PR; then the issues no tab works on.
  cards() {
    const issues = shared("cc.linear")?.issues ?? [];
    const prs = shared("cc.github")?.prs ?? [];
    const snippets = shared("cc.snippets") ?? {};
    const all = panes(), list = agents(), out = [], used = new Set();
    for (const space of spaces()) {
      for (const tab of space.tabs) {
        const tabPanes = all.filter((p) => p.tab === tab.id && p.terminal);
        const agent = list.find((a) => a.tab === tab.id);
        const branch = tabPanes.find((p) => p.branch)?.branch ?? null;
        const cwd = tabPanes.find((p) => p.cwd)?.cwd ?? space.folder;
        // A tab started on a project folder (dev-workflow, several repos) has no branch: its name carries the ID.
        const issue = issueFor(branch, issues) ?? issueFor(tab.name, issues);
        const pr = branch ? prs.find((p) => p.branch === branch) : null;
        if (issue) used.add(issue.identifier);
        let column = null, status = "";
        if (agent?.status === "blocked") { column = "needs"; status = snippets[agent.address] || "Asked you something"; }
        else if (agent?.status === "done") { column = "needs"; status = "Finished · review it"; }
        else if (agent?.status === "working") { column = "progress"; status = `Working · ${since(tab.working_since)}`; }
        else if (pr) { column = "review"; status = pr.ci === "fail" ? `#${pr.number} checks failed` : `#${pr.number} ${pr.ci === "pass" ? "checks passed" : "checks running"}${pr.review === "APPROVED" ? " · approved" : ""}`; }
        else if (issue) { column = "progress"; status = agent ? "Agent idle" : "No agent running"; }
        if (!column) continue;
        const card = { key: `t-${tab.id}`, column, space, tab, agent, issue, pr, cwd, status,
          title: issue?.title ?? (/^\d+$/.test(tab.name) ? agent?.title || tab.name : tab.name), time: tab.changed_at };
        // Several tabs on one issue or PR (an agent and a dev server, say) are one card: the agent's tab wins.
        const same = card.issue || card.pr ? out.findIndex((c) => (card.issue && c.issue?.identifier === card.issue.identifier) || (card.pr && c.pr?.url === card.pr.url)) : -1;
        if (same < 0) out.push(card);
        else if (agent && !out[same].agent) out[same] = card;
      }
    }
    for (const i of issues) {
      if (used.has(i.identifier) || i.stateType === "backlog") continue;
      out.push({ key: `i-${i.identifier}`, column: i.stateType === "started" ? "progress" : i.stateType === "review" ? "review" : "todo", issue: i, title: i.title,
        status: `${i.state}${PRIORITY[i.priority] ? ` · ${PRIORITY[i.priority]}` : ""} · not started here` });
    }
    return out;
  }

  // Filters by the folders the Start dialog scans (~/work, ~/personal): which one a card's folder is under.
  roots() { return shared("cc.settings")?.roots ?? []; }
  rootOf(card) { return this.roots().find((r) => (card.cwd ?? "").startsWith(`${r}/`) || card.cwd === r) ?? null; }

  select(card) {
    if (!card.tab) return;
    run("space.select", { id: card.space.id });
    run("tab.select", { id: card.tab.id });
    run("layout.select", { stack: "panel-body", child: "tasks" });
    run("layout.show", { id: "panel" });
  }

  openTerminal(card) {
    this.select(card);
    run("layout.select", { stack: "center", child: "main" });
    if (card.agent) run("agent.focus", { terminal: card.agent.address });
  }

  fixCi(card) {
    const p = card.pr;
    run("tab.new", { space: p.space, name: `fix CI #${p.number}`, folder: p.repo, argv: this.claude, task: `/fix-ci ${p.failed[0]?.url ?? p.url}` });
    run("layout.select", { stack: "center", child: "main" });
  }

  render() {
    const t = theme();
    const roots = this.roots();
    const all = this.cards();
    const shown = this.filter === "all" ? all : all.filter((c) => this.rootOf(c) === this.filter || (!c.cwd && c.issue));
    const active = spaces().find((s) => s.active)?.tabs.find((x) => x.active)?.id;
    const stop = (_e, cx) => cx.stop_propagation();

    const chip = (id, label) => {
      const on = this.filter === id;
      return div().id(`bf-${label}`).px(10).py(3).rounded(12).text_size(11.5).border_1()
        .border_color(on ? t.input : t.border).bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.filter = id; localStorage.setItem("filter", id); cx.notify(); }).child(label);
    };
    const button = (id, label, primary, action) => div().id(id).flex_none().px(8).py(2).rounded(5).text_size(11).font_medium().border_1()
      .border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.85)).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); action(); }).child(label);
    const dot = (s) => s === "working" ? div().size(9).rounded(5).border_2().border_color(t.working)
      : div().size(8).rounded(4).bg(s ? t[s] ?? t.dim : t.dim);

    const card = (c) => {
      const selected = c.tab && c.tab.id === active;
      const actions = [];
      if (c.tab) actions.push(button(`open-${c.key}`, "Open", false, () => this.openTerminal(c)));
      if (c.pr?.ci === "fail") actions.push(button(`fix-${c.key}`, "Fix CI", true, () => this.fixCi(c)));
      if (c.pr) actions.push(button(`pr-${c.key}`, `PR #${c.pr.number}`, false, () => exec("open", [c.pr.url])));
      if (!c.tab && c.issue) actions.push(button(`start-${c.key}`, c.issue.stateType === "review" ? "Review" : "Start", true, () => openOverlay({ mod: "cc-start", kind: "dialog", width: 640, props: { issue: c.issue } })));
      if (c.issue) actions.push(button(`lin-${c.key}`, "ClickUp", false, () => exec("open", [c.issue.url])));
      return v_flex().id(c.key).w_full().p(10).gap(6).rounded(8).bg(t.background).border_1()
        .border_color(selected ? t.accent : c.column === "needs" ? t.blocked : t.border)
        .hover((s) => s.bg(t.hover)).on_click(() => (c.tab ? this.select(c) : c.issue && exec("open", [c.issue.url])))
        .child(h_flex().gap(6).items_center().text_size(11)
          .child(div().flex_none().text_color(t.accent).child(c.issue?.identifier ?? ""))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(c.space ? `${c.space.name} › ${c.tab.name}` : c.issue?.project ?? ""))
          .child(div().flex_none().text_color(t.dim).child(since(c.time))))
        .child(div().text_size(13).font_medium().line_height(1.35).child(c.title))
        .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.muted)
          .child(dot(c.agent?.status ?? (c.pr?.ci === "fail" ? "blocked" : null)))
          .child(div().flex_1().min_w(0).truncate().child(c.status)))
        .when(actions.length > 0, (el) => el.child(h_flex().gap(5).flex_wrap().children(actions)));
    };

    return v_flex().id("cc-board").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.canvas).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border).bg(t.background)
        .child(div().font_semibold().pr(6).child("Board"))
        .child(chip("all", "All")).children(roots.map((r) => chip(r, r.split("/").pop())))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(`${shown.length} cards · click selects, Open goes to the terminal`)))
      .child(h_flex().id("cc-board-cols").flex_1().min_h(0).p(10).gap(10).items_start().children(COLUMNS.map((col) => {
        const cards = shown.filter((c) => c.column === col.id);
        return v_flex().id(`col-${col.id}`).flex_1().min_w(0).h_full().gap(8)
          .child(h_flex().gap(8).items_center().px(2)
            .child(div().size(8).rounded(4).bg(t[col.tone] ?? t.dim))
            .child(div().font_semibold().text_size(12.5).child(col.name))
            .child(div().text_size(11).text_color(t.dim).child(String(cards.length))))
          .child(v_flex().id(`cards-${col.id}`).flex_1().min_h(0).gap(8).overflow_y_scrollbar().children(cards.map(card))
            .when(cards.length === 0, (el) => el.child(div().p(10).text_size(11.5).text_color(t.dim).child("Nothing here"))));
      })));
  }
}
