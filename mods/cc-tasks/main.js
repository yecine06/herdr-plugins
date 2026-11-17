// What each task in the shown space is about: goal, plan, decisions and assumptions, changes, what's not done.
// Reads <repo>/.agents/tasks/ (written by agents and by cc-task.mjs after each turn); changes come from git.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, agents, shared, theme, run, exec, readTextFile, watchFolder, layout, home } from "herdr";

const STEP = { done: ["✓", "done"], now: ["◐", "working"], todo: ["○", "dim"] };
const KIND = { decision: ["DECISION", "accent"], assumption: ["ASSUMPTION", "working"], you_said: ["YOU SAID", "done"] };

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "space";
function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
}
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}

// Same rule as cc-task.mjs: the ClickUp task on the branch, else the space and tab.
function keyOf(branch, space, tab) {
  const issues = shared("cc.linear")?.issues ?? [];
  const b = (branch ?? "").toLowerCase();
  const hit = b && issues.find((i) => b === (i.branchName ?? "").toLowerCase() || b.includes(i.identifier.toLowerCase()));
  if (hit) return { key: hit.identifier, issue: hit, file: `${hit.identifier}.md` };
  const teams = [...new Set(issues.map((i) => i.identifier.split("-")[0].toLowerCase()))];
  const m = b && teams.length ? b.match(new RegExp(`(?:^|[^a-z])(${teams.join("|")})-(\\d+)`)) : null;
  if (m) { const id = `${m[1].toUpperCase()}-${m[2]}`; return { key: id, issue: null, file: `${id}.md` }; }
  return { key: `${slug(space.name)}--${slug(tab.name)}`, issue: null, file: `${slug(space.name)}.md` };
}

export default class Tasks extends View {
  init(_props, cx) {
    this.roots = {};
    this.summaries = {};
    this.changes = {};
    this.watching = new Set();
    this.selected = null;
    cx.timer.every(30_000, (cx) => { if (this.visible()) { this.loadChanges(cx, true); cx.notify(); } });
  }

  visible() {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    return panel && !panel.hidden && body?.active === "tasks";
  }

  // Each tab of the shown space with its repo, branch and task key.
  tasks(cx) {
    const space = spaces().find((s) => s.active);
    if (!space) return { space: null, list: [] };
    const all = panes();
    const list = [];
    for (const tab of space.tabs) {
      const pane = all.find((p) => p.tab === tab.id && p.cwd && p.terminal);
      if (!pane) continue;
      if (!(pane.cwd in this.roots)) {
        this.roots[pane.cwd] = undefined;
        cx.spawn(async (cx) => {
          const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: pane.cwd, on: space.machine }).catch(() => null);
          this.roots[pane.cwd] = r?.code === 0 ? r.stdout.trim() : null;
          cx.notify();
        });
      }
      const root = this.roots[pane.cwd];
      const agent0 = agents().find((a) => a.tab === tab.id);
      if (!root && !agent0) continue;
      const k = keyOf(pane.branch, space, tab);
      const agent = agents().find((a) => a.tab === tab.id);
      list.push({ ...k, tab, root, cwd: pane.cwd, branch: pane.branch, agent, machine: space.machine });
    }
    return { space, list };
  }

  load(cx, task) {
    if (!task.root) return;
    const dir = `${task.root}/.agents/tasks`;
    if (!this.watching.has(dir) && !task.machine) {
      this.watching.add(dir);
      cx.spawn(async (cx) => {
        for (;;) {
          // A repo with no notes folder yet can't be watched: look again in a while rather than at once.
          if (!(await watchFolder(dir).then(() => true, () => false))) await cx.sleep(30_000);
          for (const k of Object.keys(this.summaries)) if (this.summaries[k]?.dir === dir) delete this.summaries[k];
          cx.notify();
        }
      });
    }
    if (task.key in this.summaries) return;
    this.summaries[task.key] = { dir, loading: true };
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${dir}/.summary/${task.key}.json`, { on: task.machine }).catch(() => null);
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      this.summaries[task.key] = { dir, data };
      cx.notify();
    });
  }

  // Topic history of the Claude session in a tab, written by ~/.claude/hooks/session-topics.mjs under the terminal's address.
  loadTopics(cx, task) {
    const addr = task?.agent?.address;
    if (!addr || task.machine) return;
    const c = (this.topics ??= {})[addr];
    if (c && Date.now() - c.at < 15_000) return;
    this.topics[addr] = { at: Date.now(), data: c?.data ?? null };
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${home()}/.claude/session-topics/by-terminal/${addr}.json`).catch(() => null);
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      this.topics[addr] = { at: Date.now(), data };
      cx.notify();
    });
  }

  loadChanges(cx, force) {
    const task = this.current;
    if (!task?.root || (!force && this.changes[task.key])) return;
    this.changes[task.key] ??= { files: [], commits: 0 };
    cx.spawn(async (cx) => {
      const on = task.machine, cwd = task.cwd;
      // The branch's base: the remote's default branch, else a local main or master, else just uncommitted work.
      let base = "HEAD";
      for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
        const r = await exec("git", ["merge-base", "HEAD", ref], { cwd, on }).catch(() => null);
        if (r?.code === 0 && r.stdout.trim()) { base = r.stdout.trim(); break; }
      }
      const diff = await exec("git", ["diff", "--numstat", base], { cwd, on }).catch(() => null);
      const log = await exec("git", ["rev-list", "--count", `${base}..HEAD`], { cwd, on }).catch(() => null);
      const files = (diff?.stdout ?? "").split("\n").filter(Boolean).map((l) => { const [a, d, path] = l.split("\t"); return { path, add: a, del: d }; });
      // New files git doesn't track yet count too: every line is an addition.
      const added = await exec("sh", ["-c", "git ls-files --others --exclude-standard -z | xargs -0 -r wc -l 2>/dev/null | grep -v ' total$'"], { cwd, on }).catch(() => null);
      for (const line of (added?.stdout ?? "").split("\n").filter(Boolean)) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (m) files.push({ path: m[2], add: m[1], del: "0" });
      }
      // Task notes are not code: never count them as changes.
      this.changes[task.key] = { files: files.filter((f) => !f.path.startsWith(".agents/")), commits: Number(log?.stdout.trim() ?? 0) || 0 };
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const { space, list } = this.tasks(cx);
    const activeTab = space?.tabs.find((x) => x.active);
    // Follow the tab you switch to; a click on a row still picks another one until the next switch.
    if (activeTab?.id !== this.lastActive) {
      this.lastActive = activeTab?.id;
      const cur = list.find((x) => x.tab.id === activeTab?.id);
      if (cur) this.selected = cur.key;
    }
    if (!list.some((x) => x.key === this.selected)) this.selected = (list.find((x) => x.tab.id === activeTab?.id) ?? list[0])?.key ?? null;
    const task = list.find((x) => x.key === this.selected) ?? null;
    if (task?.key !== this.current?.key) { this.current = task; this.loadChanges(cx, false); }
    this.current = task;
    for (const x of list) this.load(cx, x);
    this.loadTopics(cx, task);
    const topics = task?.agent?.address ? this.topics?.[task.agent.address]?.data?.history : null;
    const s = task ? this.summaries[task.key]?.data : null;
    const changes = task ? this.changes[task.key] : null;
    const pr = task && (shared("cc.github")?.prs ?? []).find((p) => p.branch === task.branch);
    const snippet = task?.agent?.status === "blocked" ? (shared("cc.snippets") ?? {})[task.agent.address] : null;

    const label = (text, right) => h_flex().gap(8).items_center().pb(2)
      .child(div().text_size(11).font_medium().text_color(t.dim).child(text))
      .when(Boolean(right), (el) => el.child(div().flex_1()).child(right));
    const button = (id, text, primary, action) => div().id(id).flex_none().px(10).py(4).rounded(5).text_size(11.5).font_medium().border_1()
      .border_color(primary ? t.solid : t.border).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((st) => st.opacity(0.85)).on_click(() => action()).child(text);
    const dot = (status) => status === "working" ? div().size(9).rounded(5).border_2().border_color(t.working)
      : div().size(8).rounded(4).bg(status ? t[status] : t.dim);

    const listRow = (x) => h_flex().id(`tk-${x.key}`).px(8).py(6).gap(8).items_center().rounded(6).text_size(12.5)
      .bg(x.key === this.selected ? t.selected : t.background).hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { this.selected = x.key; cx.notify(); })
      .child(dot(x.tab.status))
      .child(div().flex_none().text_size(11).text_color(t.accent).child(x.issue || /^[A-Z]+-\d+$/.test(x.key) ? x.key : ""))
      .child(div().flex_1().min_w(0).truncate().child(x.issue?.title ?? x.tab.name))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(x.tab.name));

    const body = !task ? [div().p(20).text_color(t.dim).child(space ? "No tabs in a git repo here" : "No space")]
      : [
        v_flex().gap(3)
          .child(div().text_size(15).font_semibold().child(task.issue?.title ?? s?.title ?? `${space.name} › ${task.tab.name}`))
          .child(div().text_size(11).text_color(t.dim).child(`.agents/tasks/${task.file}${s?.updatedAt ? ` · updated ${ago(s.updatedAt)}` : ""}`)),
        ...(snippet ? [v_flex().p(10).gap(6).rounded(8).bg(t.raised).border_1().border_color(t.blocked)
          .child(div().text_size(11).font_semibold().text_color(t.blocked).child("WAITING ON YOU"))
          .child(div().text_size(12.5).child(snippet))
          .child(h_flex().child(button("tk-open", "Open", true, () => run("agent.focus", { terminal: task.agent.address }))))] : []),
        ...(topics?.length ? [v_flex().gap(3).child(label("TOPICS", div().text_size(11).text_color(t.dim).child(`${topics.length}`)))
          .children(topics.slice().reverse().slice(0, 12).map((e, n) => h_flex().id(`tp-${n}`).gap(8).text_size(12.5)
            .child(div().w(14).flex_none().text_color(n === 0 ? t.working : t.dim).child(n === 0 ? "◐" : "✓"))
            .child(div().flex_1().min_w(0).text_color(n === 0 ? t.foreground : t.muted).child(e.title))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(e.at)))))] : []),
        ...(!s ? [div().text_size(12.5).text_color(t.dim).child("No summary yet. It appears after the agent's next turn that changes code.")] : [
          v_flex().gap(4).child(label("GOAL")).child(div().text_size(12.5).text_color(t.foreground).child(s.goal)),
          ...(s.steps?.length ? [v_flex().gap(3)
            .child(label("PLAN", s.planFile ? div().text_size(11).text_color(t.accent).truncate().child(s.planFile.split("/").pop()) : null))
            .children(s.steps.map((st, n) => h_flex().id(`st-${n}`).gap(8).items_start().text_size(12.5)
              .child(div().w(14).flex_none().text_color(t[STEP[st.state]?.[1] ?? "dim"]).child(STEP[st.state]?.[0] ?? "○"))
              .child(div().flex_1().min_w(0).text_color(st.state === "done" ? t.muted : t.foreground).child(st.text))))] : []),
          ...(s.decisions?.length ? [v_flex().gap(5).child(label("DECISIONS AND ASSUMPTIONS"))
            .children(s.decisions.map((d, n) => h_flex().id(`dc-${n}`).gap(8).items_start().text_size(12.5)
              .child(div().flex_none().mt(1).px(5).py(1).rounded(4).bg(t.raised).text_size(9.5).font_semibold().text_color(t[KIND[d.kind]?.[1] ?? "muted"]).child(KIND[d.kind]?.[0] ?? d.kind))
              .child(div().flex_1().min_w(0).text_color(t.foreground).child(d.text))))] : []),
        ]),
        v_flex().gap(3)
          .child(label("CHANGES", div().text_size(11).text_color(t.dim).child([
            changes?.commits ? `${changes.commits} commit${changes.commits === 1 ? "" : "s"}` : "",
            pr ? `PR #${pr.number} ${pr.ci === "fail" ? "✗" : pr.ci === "pass" ? "✓" : "⋯"}` : "",
          ].filter(Boolean).join(" · "))))
          .children((changes?.files ?? []).slice(0, 8).map((f, n) => h_flex().id(`ch-${n}`).gap(10).text_size(11.5)
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(f.path))
            .child(div().text_color(t.done).child(f.add === "-" ? "" : `+${f.add}`))
            .child(div().text_color(t.blocked).child(f.del === "-" || f.del === "0" ? "" : `−${f.del}`))))
          .when(!(changes?.files ?? []).length, (el) => el.child(div().text_size(12).text_color(t.dim).child("No changes against the base branch"))),
        ...(s?.notDone?.length ? [v_flex().gap(3).child(label("NOT DONE OR RISKY"))
          .children(s.notDone.map((r, n) => h_flex().id(`nd-${n}`).gap(8).text_size(12.5)
            .child(div().flex_none().text_color(t.working).child("!")).child(div().flex_1().min_w(0).child(r))))] : []),
      ];

    return v_flex().id("cc-tasks").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Tasks"))
        .child(div().text_size(11).text_color(t.dim).child(space?.name ?? "")))
      .when(list.length > 1, (el) => el.child(v_flex().flex_none().p(6).gap(1).border_b(1).border_color(t.border).children(list.map(listRow))))
      .child(v_flex().id("cc-tasks-body").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(12).gap(14).children(body))
      .when(Boolean(task?.root), (el) => el.child(h_flex().flex_none().px(14).py(9).gap(8).items_center().border_t(1).border_color(t.border).bg(t.chrome)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(s ? `Summary after ${s.turns} turn${s.turns === 1 ? "" : "s"}` : ""))
        .child(button("tk-diff", "Review diff", true, () => { run("tab.select", { id: task.tab.id }); run("layout.select", { stack: "panel-body", child: "changes" }); }))
        .child(button("tk-notes", "Open notes", false, () => exec("open", [`${task.root}/.agents/tasks/${task.file}`])))));
  }
}
