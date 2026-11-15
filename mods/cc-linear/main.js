// Your open ClickUp tasks, grouped by state, each linked to the space and tab working on it (by branch name).
// Issues come from cc-status (shared "cc.linear"); this panel only asks for a refresh.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, shared, setShared, theme, run, exec, openOverlay } from "herdr";

const TYPE_RANK = { started: 0, review: 1, unstarted: 2, triage: 3, backlog: 4 };
const PRIORITY = { 1: ["Urgent", "blocked"], 2: ["High", "working"] };

function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

// Any branch that carries the task ID (selp-12914-…).
export function linkOf(issue, allPanes, allSpaces) {
  const id = issue.identifier.toLowerCase();
  const pane = allPanes.find((p) => p.branch && (p.branch === issue.branchName || p.branch.toLowerCase().includes(id)));
  if (!pane) return null;
  const space = allSpaces.find((s) => s.tabs.some((t) => t.id === pane.tab));
  const tab = space?.tabs.find((t) => t.id === pane.tab);
  return space && tab ? { space, tab, branch: pane.branch } : null;
}

export default class Linear extends View {
  init(_props, cx) {
    this.showBacklog = localStorage.getItem("backlog") === "1";
    cx.timer.every(60_000, (cx) => cx.notify());
    // First look, or a connector that wasn't connected last time: check once (scheduled checks wait meanwhile).
    const l = shared("cc.linear") ?? {};
    if (shared("cc.settings")?.linear?.enabled !== false && (!l.at || l.notConnected) && !l.running && Date.now() - (l.failedAt ?? 0) > 5 * 60_000)
      setShared("cc.linear.request", Date.now());
  }

  // Off in settings, or the connector isn't signed in: a message with what to do, instead of an empty list.
  notice(t, data) {
    const enabled = shared("cc.settings")?.linear?.enabled !== false;
    const settings = (p) => setShared("cc.settings.update", { patch: p, at: Date.now() });
    const button = (id, label, primary, action) => div().id(id).px(12).py(5).rounded(6).text_size(12).font_medium().border_1()
      .border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.85)).on_click(() => action()).child(label);
    if (!enabled) return v_flex().p(24).gap(10).items_center()
      .child(div().text_color(t.muted).child("ClickUp is off"))
      .child(button("lin-on", "Turn it on", true, () => settings({ linear: { enabled: true } })));
    if (!data.notConnected) return null;
    return v_flex().p(20).gap(10)
      .child(div().font_semibold().child("Connect ClickUp to see your tasks"))
      .child(div().text_size(12.5).text_color(t.muted).line_height(1.5).child(
        "Your tasks are read through clickup-cli. Run `clickup-cli auth` in a terminal, then check again."))
      .child(h_flex().gap(8).pt(4)
        .child(button("lin-check", data.running ? "Checking…" : "Check again", true, () => !data.running && setShared("cc.linear.request", Date.now())))
        .child(button("lin-off", "I don't use ClickUp", false, () => settings({ linear: { enabled: false } }))));
  }

  render() {
    const t = theme();
    const data = shared("cc.linear") ?? {};
    const prs = shared("cc.github")?.prs ?? [];
    const allPanes = panes(), allSpaces = spaces();
    const issues = [...(data.issues ?? [])].sort((a, b) =>
      (TYPE_RANK[a.stateType] ?? 9) - (TYPE_RANK[b.stateType] ?? 9) || (a.priority || 9) - (b.priority || 9));
    const groups = [];
    for (const i of issues) {
      const g = groups.find((x) => x.name === i.state);
      if (g) g.items.push(i); else groups.push({ name: i.state, type: i.stateType, items: [i] });
    }
    const stop = (_e, cx) => cx.stop_propagation();

    const dot = (status) => status === "working"
      ? div().size(9).rounded(5).border_2().border_color(t.working)
      : div().size(8).rounded(4).bg(status ? t[status] : t.dim);

    const button = (id, label, primary, action) => div().id(id).flex_none().px(9).py(3).rounded(5).text_size(11.5).font_medium().border_1()
      .border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.85)).on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); action(); }).child(label);

    const row = (i) => {
      const link = linkOf(i, allPanes, allSpaces);
      const pr = link && prs.find((p) => p.branch === link.branch);
      const pri = PRIORITY[i.priority];
      const open = () => link ? (run("space.select", { id: link.space.id }), run("tab.select", { id: link.tab.id })) : exec("open", [i.url]);
      return v_flex().id(`li-${i.identifier}`).w_full().px(14).py(8).gap(5).hover((s) => s.bg(t.hover)).on_click(() => open())
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().text_size(11).text_color(t.dim).child(i.identifier))
          .child(div().flex_1().min_w(0).truncate().font_medium().child(i.title))
          .when(Boolean(pri), (el) => el.child(div().flex_none().text_size(11).text_color(t[pri[1]]).child(pri[0])))
          .when(!link, (el) => el.child(button(`start-${i.identifier}`, "Start", true,
            () => openOverlay({ mod: "cc-start", kind: "dialog", width: 640, props: { issue: i } }))))
          .when(Boolean(link), (el) => el.child(button(`open-${i.identifier}`, "ClickUp", false, () => exec("open", [i.url])))))
        .when(Boolean(link), (el) => el.child(h_flex().gap(8).items_center().text_size(11.5).text_color(t.muted)
          .child(dot(link.tab.status))
          .child(div().flex_1().min_w(0).truncate().child(`${link.space.name} › ${link.tab.name}${link.tab.status ? ` · ${link.tab.status === "blocked" ? "needs you" : link.tab.status}` : ""}`))
          .when(Boolean(pr), (el) => el.child(div().flex_none().text_color(pr.ci === "fail" ? t.blocked : pr.ci === "pass" ? t.done : t.muted)
            .child(`#${pr.number} ${pr.ci === "fail" ? "✗" : pr.ci === "pass" ? "✓" : "⋯"}`)))));
    };

    const section = (g) => {
      const folded = g.type === "backlog" && !this.showBacklog;
      return [
        h_flex().id(`lg-${g.name}`).px(14).pt(10).pb(4).gap(8).items_center().text_size(11.5)
          .when(g.type === "backlog", (el) => el.on_click((_e, cx) => { this.showBacklog = !this.showBacklog; localStorage.setItem("backlog", this.showBacklog ? "1" : "0"); cx.notify(); }))
          .child(div().font_semibold().text_color(t.foreground).child(g.name))
          .child(div().text_color(t.dim).child(String(g.items.length)))
          .when(g.type === "backlog", (el) => el.child(div().text_color(t.dim).child(folded ? "show" : "hide"))),
        ...(folded ? [] : g.items.map(row)),
      ];
    };

    const sync = data.running ? "checking…" : data.at ? ago(data.at) : "";
    const notice = this.notice(t, data);
    const refresh = () => setShared("cc.linear.request", Date.now());

    return v_flex().id("cc-linear").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("My tasks"))
        .child(div().text_size(11).text_color(t.dim).child(issues.length ? String(issues.length) : ""))
        .child(div().flex_1())
        .child(div().id("cc-linear-refresh").text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click(() => refresh()).child(sync ? `${sync} · refresh` : "refresh")))
      .when(Boolean(notice), (el) => el.child(notice))
      .when(!notice && Boolean(data.error), (el) => el.child(v_flex().flex_none().px(14).py(8).gap(2).bg(t.raised).border_b(1).border_color(t.border)
        .child(div().text_size(12).text_color(t.blocked).child(`Couldn't read ClickUp: ${data.error}`))
        .child(div().text_size(11.5).text_color(t.dim).child("Click refresh to try again."))))
      .when(!notice, (el) => el.child(v_flex().id("cc-linear-list").flex_1().min_h(0).overflow_y_scrollbar()
        .children(groups.flatMap(section))
        .when(groups.length === 0, (el) => el.child(div().p(24).text_center().text_color(t.dim)
          .child(data.running ? "Loading your tasks…" : data.at ? "No open tasks assigned to you" : "Not loaded yet")))));
  }
}
