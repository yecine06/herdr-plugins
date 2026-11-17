// Start from a ClickUp task: a worktree (or a tab) with an agent whose first message is the issue.
// A task past or before development (analysis, review, QA, release) opens a tab for that step, status left alone.
// props: { issue, overlay }

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, InputState, Input } from "gpui-base";
import { spaces, panes, props, theme, run, exec, knownAgents, openOverlay, closeOverlay, shared, setShared, pickFolder, home } from "herdr";

// Folders scanned for git repos, four levels deep: settings' repoRoots, or when unset the parent folders of
// the repos open in Herdr (cc-status works them out). "Change folders" saves them to settings.
const repoRoots = () => shared("cc.settings")?.roots ?? [];
const tilde = (p) => p.replace(home(), "~");
const untilde = (p) => p.trim().replace(/^~(?=\/|$)/, home());

// The repo whose name appears in the issue's project or title (inbound-se for "… Inbound SE"); longest wins.
function suggest(issue, repos) {
  const text = ` ${`${issue.project ?? ""} ${issue.title}`.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return repos.filter((r) => r.name.length >= 4 && text.includes(` ${r.name.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `))
    .sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

const MODES = [
  { id: "plan", label: "Plan mode" },
  { id: "auto", label: "Auto mode" },
  { id: "manual", label: "Ask first" },
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
const shortTitle = (s) => s.split(/\s+/).reduce((acc, w) => (acc.length + w.length < 26 ? `${acc} ${w}`.trim() : acc), "");

// What starting a task means depends on its step (cc-status/clickup.mjs): only "dev" codes, gets a worktree
// and moves the task to in progress; the others open a tab and leave the status alone.
const STEPS = {
  dev: { button: "Start", verb: "Work on",
    ask: (i) => `Keep notes on your plan, decisions and assumptions as you go. When done, open a PR titled "${i.identifier}: …" and stop.` },
  analyse: { button: "Start analysis", verb: "Analyse",
    ask: (i) => `This task is at "${i.state}": nothing is coded yet. Read the task and the code it touches, then give: what is asked and what is unclear, the repos and files involved, an approach, the risks, the questions to ask, and an estimate. Do not write code or change the task's status.` },
  review: { button: "Start review", verb: "Review",
    ask: (i) => `Find the merge requests for this task (branch or title containing ${i.identifier}) in the repos of this folder. Review them against the task: correctness, missing cases, tests. Report your findings, most severe first. Do not push, merge or change the task's status.` },
  qa: { button: "Start QA", verb: "QA for",
    ask: (i) => `This task is at "${i.state}": the change has to be checked before it moves on. Find its merge requests (branch or title containing ${i.identifier}) and where it is deployed. List the checks that prove each acceptance criterion, including edge cases and regressions; run those you can (tests, API calls, database reads, logs) and leave the others as steps for a human. Report each check as passed, failed or not run, with its evidence. Do not change code or the task's status.` },
  mep: { button: "Start MEP", verb: "Release",
    ask: (i) => `This task is at "${i.state}". Run /mep for the repos it touches: check what is waiting to be promoted and that ${i.identifier} is in it, then follow the skill. Stop before any production action and ask me.` },
};
const stepOf = (i) => (STEPS[i.step] ? i.step : i.stateType === "review" ? "review" : "dev");

function firstMessage(i, step) {
  const about = (i.description ?? "").trim();
  return `${STEPS[step].verb} ${i.identifier}: ${i.title}\n${i.url}\n${about ? `\n${about}\n` : ""}\n${STEPS[step].ask(i)}`;
}

// A folder that holds several repos side by side (a project split across repos) is offered as one entry.
function projectFolders(repos) {
  const count = new Map();
  for (const r of repos) {
    const parent = r.root.replace(/\/[^/]+$/, "");
    count.set(parent, (count.get(parent) ?? 0) + 1);
  }
  return [...count].filter(([, n]) => n >= 2).map(([root, n]) => ({ root, name: root.split("/").pop(), space: null, git: false, repos: n }));
}

export default class Start extends View {
  init(_props, cx) {
    const i = props()?.issue;
    if (!i) return;
    this.step = stepOf(i);
    this.dev = this.step === "dev";
    this.where = this.dev ? "devflow" : "tab";
    this.mode = "plan";
    this.agent = "claude";
    this.move = this.dev && i.stateType !== "started";
    this.repos = [];
    this.repo = null;
    this.agents = [{ key: "claude", name: "Claude Code", run: ["claude"] }, { key: "shell", name: "Shell", run: null }];
    this.message = TextareaState.new({ value: firstMessage(i, this.step), rows: 7 });
    this.query = "";
    this.filter = InputState.new({ placeholder: "Filter repos" });
    this.filter.on("change", (_e, cx) => { this.query = this.filter.value().trim().toLowerCase(); cx.notify(); });
    this.editingRoots = false;
    this.rootsInput = InputState.new({ value: repoRoots().map(tilde).join(", ") });
    this.rootsInput.on("submit", (_e, cx) => this.saveRoots(cx));
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      const found = await knownAgents().catch(() => []);
      const list = found.filter((a) => a.installed && (a.key === "claude" || a.key === "codex"));
      if (list.length) this.agents = [...list.map((a) => ({ key: a.key, name: a.name, run: a.run })), { key: "shell", name: "Shell", run: null }];
      cx.notify();
    });
    this.scan(cx, true);
  }

  // Repos open as local spaces (the shown one first), then every repo under the folders, then the folders
  // that hold several repos. A space opened on a plain folder (no git) is kept too, so it can be reused.
  scan(cx, pick, roots = repoRoots()) {
    cx.spawn(async (cx) => {
      const byRoot = new Map();
      const plainSpaces = new Map();
      const ordered = [...spaces()].sort((a, b) => Number(b.active) - Number(a.active));
      for (const s of ordered) {
        if (s.machine) continue;
        const tabIds = new Set(s.tabs.map((t) => t.id));
        const cwd = panes().find((p) => tabIds.has(p.tab) && p.cwd)?.cwd ?? s.folder;
        if (!cwd) continue;
        const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => null);
        const root = r?.code === 0 ? r.stdout.trim() : null;
        if (root && !byRoot.has(root)) byRoot.set(root, { root, name: root.split("/").pop(), space: s.id, git: true });
        else if (!root && !plainSpaces.has(cwd.replace(/\/+$/, ""))) plainSpaces.set(cwd.replace(/\/+$/, ""), s.id);
      }
      const scanned = [];
      for (const dir of roots) {
        const r = await exec("find", [dir, "-maxdepth", "4", "(", "-name", "node_modules", "-o", "-name", "vendor", ")", "-prune", "-o", "-name", ".git", "-print"], { timeout: 15_000 }).catch(() => null);
        for (const line of (r?.stdout ?? "").split("\n").filter(Boolean)) {
          const root = line.replace(/\/\.git$/, "");
          if (!byRoot.has(root) && !scanned.some((x) => x.root === root)) scanned.push({ root, name: root.split("/").pop(), space: null, git: true });
        }
      }
      const folders = projectFolders([...byRoot.values(), ...scanned])
        .map((f) => ({ ...f, space: plainSpaces.get(f.root) ?? null }));
      const byName = (a, b) => a.name.localeCompare(b.name);
      const picked = this.repo?.root;
      this.repos = [...byRoot.values(), ...scanned.sort(byName), ...folders.sort(byName)];
      this.suggested = suggest(props().issue, this.repos);
      this.repo = (picked && this.repos.find((r) => r.root === picked)) || (pick && this.suggested) || this.repos[0] || null;
      cx.notify();
    });
  }

  saveRoots(cx) {
    const roots = this.rootsInput.value().split(",").map(untilde).filter(Boolean);
    setShared("cc.settings.update", { patch: { repoRoots: roots.length ? roots : null }, at: Date.now() });
    this.editingRoots = false;
    this.scan(cx, false, roots);
    cx.notify();
  }

  pickRepo(cx) {
    cx.spawn(async (cx) => {
      const picked = await pickFolder({ prompt: "Use this folder" });
      if (!picked) return;
      const folder = picked.replace(/\/+$/, "");
      // A folder outside any repo (a project split across repos) is fine: it opens as a tab, without a worktree.
      const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder }).catch(() => null);
      const git = r?.code === 0;
      const root = git ? r.stdout.trim() : folder;
      this.repo = this.repos.find((x) => x.root === root) ?? { root, name: root.split("/").pop(), space: null, git };
      if (!this.repos.includes(this.repo)) this.repos.push(this.repo);
      cx.notify();
    });
  }

  // "dev-workflow" hands the worktrees to the Claude skill of that name (project sheet, per-repo branch
  // format, worktrees/<TICKET>/<repo>, post-setup, worktree guard hook): the agent starts in the project
  // folder and creates them itself. "Herdr worktree" is the built-in one: one repo, ~/.herdr/worktrees.
  whereOptions() {
    return [
      ...(this.agent === "claude" ? [{ id: "devflow", label: "dev-workflow" }] : []),
      ...(this.repo?.git === false ? [] : [{ id: "worktree", label: "Herdr worktree" }]),
      { id: "tab", label: "New tab, no worktree" },
    ];
  }

  whereNow() {
    const options = this.whereOptions();
    return options.some((o) => o.id === this.where) ? this.where : "tab";
  }

  start() {
    const i = props().issue;
    const where = this.whereNow();
    const typed = this.message.value().trim();
    const msg = where === "devflow" ? `/dev-workflow ${i.identifier}\n\n${typed}` : typed;
    const agent = this.agents.find((a) => a.key === this.agent);
    const name = `${i.identifier} ${shortTitle(i.title)}`;
    const argv = !agent?.run ? null : agent.key === "claude" ? [...agent.run, "--permission-mode", this.mode] : [...agent.run];
    closeOverlay(props().overlay);
    if (where === "worktree") {
      // The worktree dialog takes no first message, so it goes on the agent's command line.
      openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: {
        space: this.repo.space, folder: this.repo.root, branch: i.branchName || `${i.identifier.toLowerCase()}-${slug(i.title)}`,
        tab: name, argv: argv ? [...argv, ...(msg ? [msg] : [])] : undefined } });
    } else if (this.repo.space) {
      run("tab.new", { space: this.repo.space, name, folder: this.repo.root, argv: argv ?? undefined, task: argv && msg ? msg : undefined });
    } else {
      run("space.new", { folder: this.repo.root, tab: name, argv: argv ?? undefined, task: argv && msg ? msg : undefined });
    }
    if (this.move) setShared("cc.linear.move", { identifier: i.identifier, taskId: i.taskId, at: Date.now() });
  }

  render() {
    const t = theme();
    const i = props()?.issue;
    if (!i) return div();
    const label = (text) => div().pt(14).pb(6).text_size(11).font_medium().text_color(t.dim).child(text);
    const seg = (id, options, value, pick) => h_flex().p(3).gap(2).rounded(8).bg(t.background).border_1().border_color(t.border).children(options.map((o) =>
      div().id(`${id}-${o.id}`).flex_1().py(6).rounded(6).text_center().text_size(12.5).cursor_pointer()
        .bg(value === o.id ? t.selected : t.background).text_color(value === o.id ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { pick(o.id); cx.notify(); }).child(o.label)));
    const button = (id, text, primary, action, enabled = true) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).opacity(enabled ? 1 : 0.5)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(enabled ? 0.88 : 0.5)).on_click(() => enabled && action()).child(text);
    const check = (id, on, text, toggle) => h_flex().id(id).gap(8).items_center().cursor_pointer().on_click((_e, cx) => { toggle(); cx.notify(); })
      .child(div().size(14).rounded(3).border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
        .text_size(10).text_color(t.accent_foreground).text_center().child(on ? "✓" : ""))
      .child(div().text_size(12.5).child(text));
    const branch = i.branchName || `${i.identifier.toLowerCase()}-${slug(i.title)}`;
    const ready = Boolean(this.repo);
    const plain = this.repo?.git === false;
    const where = this.whereNow();

    return v_flex().id("cc-start").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .w_full().p(20).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(12).text_color(t.accent).child(i.identifier))
        .child(div().text_size(11.5).text_color(t.dim).child([i.state, i.cycle, i.project].filter(Boolean).join(" · ")))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(6).text_size(16).font_semibold().child(i.title))
      .child(label("WHERE"))
      .child(seg("where", this.whereOptions(), where, (v) => { this.where = v; }))
      .child(h_flex().pt(8).gap(8).items_center()
        .child(Input.new(this.filter).flex_1().h(30).px(9).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5))
        .child(div().id("repo-other").flex_none().text_size(12).text_color(t.muted).cursor_pointer()
          .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.pickRepo(cx)).child("Other folder…")))
      .child(v_flex().id("repo-list").mt(6).h(150).overflow_y_scrollbar().rounded(7).border_1().border_color(t.border)
        .children(this.repos.filter((r) => !this.query || r.name.toLowerCase().includes(this.query) || r.root.toLowerCase().includes(this.query)).map((r, n) =>
          h_flex().id(`repo-${n}`).px(10).py(5).gap(8).items_center().cursor_pointer()
            .bg(this.repo === r ? t.selected : t.background).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.repo = r; cx.notify(); })
            .child(div().flex_none().text_size(12.5).text_color(this.repo === r ? t.foreground : t.muted).child(r.name))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(tilde(r.root)))
            .when(Boolean(r.repos), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.muted).child(`${r.repos} repos`)))
            .when(Boolean(r.space), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.done).child("open")))
            .when(this.suggested === r, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.accent).child("suggested"))))))
      .child(h_flex().pt(6).gap(6).items_center().text_size(11.5).text_color(t.dim)
        .when(!this.editingRoots, (el) => el
          .child(div().flex_1().min_w(0).truncate().child(`Repos under ${repoRoots().map(tilde).join(", ")}`))
          .child(div().id("roots-edit").flex_none().cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.editingRoots = true; this.rootsInput.focus(); cx.notify(); }).child("Change folders")))
        .when(this.editingRoots, (el) => el
          .child(Input.new(this.rootsInput).flex_1().h(28).px(8).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(12))
          .child(div().id("roots-save").flex_none().cursor_pointer().text_color(t.foreground).on_click((_e, cx) => this.saveRoots(cx)).child("Save"))))
      .child(div().pt(6).text_size(11.5).text_color(t.dim).child(!ready ? "Pick a repo or a folder"
        : where === "devflow" ? `Claude runs /dev-workflow ${i.identifier} from ${this.repo.name}: worktrees and branches follow the project sheet`
        : where === "worktree" ? `Branch ${branch}, in a new space`
        : plain ? `In ${this.repo.name}, a folder of several repos: no worktree, each repo stays on its branch`
        : `In ${this.repo.name}, on the branch it has checked out`))
      .child(label("AGENT"))
      .child(seg("agent", this.agents.map((a) => ({ id: a.key, label: a.name })), this.agent, (v) => { this.agent = v; }))
      .when(this.agent === "claude", (el) => el.child(label("START IN")).child(seg("mode", MODES, this.mode, (v) => { this.mode = v; })))
      .when(this.agent !== "shell", (el) => el.child(label("FIRST MESSAGE"))
        .child(Textarea.new(this.message).h(150).px(10).py(8).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5)))
      .when(this.dev && i.stateType !== "started", (el) => el.child(div().pt(14).child(check("move", this.move, `Move ${i.identifier} to “en cours”`, () => { this.move = !this.move; }))))
      .child(h_flex().pt(18).gap(8).items_center()
        .child(div().flex_1().text_size(11.5).text_color(t.dim).child(`Opens a tab named “${i.identifier} ${shortTitle(i.title)}”`))
        .child(button("cs-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("cs-start", STEPS[this.step].button, true, () => this.start(), ready)));
  }
}
