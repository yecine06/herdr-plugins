// One ranked list of what needs you: blocked and finished agents, Slack asks, failed CI, review requests.
// Agents come live from Herdr; GitHub, Slack and screen snippets from cc-status via shared state.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, spaces, panes, shared, setShared, theme, run, exec, knownAgents, openOverlay } from "herdr";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "agents", label: "Agents" },
  { id: "slack", label: "Slack" },
  { id: "github", label: "GitHub" },
];
const SECTIONS = ["NEEDS YOU NOW", "REVIEW", "NEW FOR YOU"];

function since(ms) {
  if (!ms) return "";
  const m = Math.floor((Date.now() - ms) / 60_000);
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}
const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);

const openUrl = (url) => url && exec("open", [url]);
const CLOSED = { you: "done", sweep: "you replied", skipped: "skipped" };
const slackAction = (op, ids) => setShared("cc.slack.action", { op, ids, at: Date.now() });

export default class Inbox extends View {
  init(_props, cx) {
    this.claude = ["claude"];
    this.showTicked = false;
    cx.timer.every(60_000, (cx) => cx.notify());
    cx.spawn(async () => {
      const found = (await knownAgents().catch(() => [])).find((a) => a.key === "claude");
      if (found?.run?.length) this.claude = found.run;
    });
  }

  get filter() { return shared("cc.inbox.filter") ?? "all"; }

  fixCi(p) {
    const failed = p.failed[0];
    run("tab.new", { space: p.space, name: `fix CI #${p.number}`, folder: p.repo, argv: this.claude, task: `/fix-ci ${failed?.url ?? p.url}` });
  }

  // A research agent in the shown space: it looks for the answer everywhere and drafts a reply, never posts.
  // Asks who takes it (a new agent or a free one here) and whether to search Slack first.
  handToAgent(s) {
    openOverlay({ mod: "cc-handoff", kind: "dialog", width: 560,
      props: { ask: { from: s.from, channel: s.channel, text: s.text, permalink: s.permalink } } });
  }

  slackItems() {
    return (shared("cc.slack")?.items ?? []).map((s) => ({
      key: `sl-${s.permalink}`, group: "slack", kind: s.kind === "ask" ? "SLACK" : "FYI", tone: s.kind === "ask" ? "working" : "muted",
      section: s.urgent || s.due ? 0 : 2, time: s.at, open: () => openUrl(s.permalink), ticked: s.ticked, ask: s.kind === "ask",
      title: `${s.from} in ${s.channel}${s.due ? ` · due ${s.due}` : ""}${s.ticked ? ` · ${s.kind === "ask" ? CLOSED[s.by] ?? "done" : "seen"}` : ""}`, body: s.text, permalink: s.permalink,
      // Done: handled, and a standup candidate. Skip: set aside, never in the standup. FYIs are just Seen.
      actions: s.ticked ? [{ label: "Undo", run: () => slackAction("untick", [s.permalink]) }]
        : s.kind === "ask" ? [{ label: "Hand to agent", run: () => this.handToAgent(s) },
          { label: "Done", primary: true, run: () => slackAction("tick", [s.permalink]) },
          { label: "Skip", run: () => slackAction("skip", [s.permalink]) }]
        : [{ label: "Seen", run: () => slackAction("tick", [s.permalink]) }],
    }));
  }

  items() {
    const tabs = new Map(spaces().flatMap((s) => s.tabs.map((t) => [t.id, t])));
    const snippets = shared("cc.snippets") ?? {};
    const gh = shared("cc.github") ?? {};
    const out = [];
    // gardien: an agent waits for an access (AWS, SSH, secrets) that only you can approve.
    const live = agents();
    for (const g of shared("cc.gardien") ?? []) {
      if (!(g.deadline_ms > Date.now())) continue;
      const a = live.find((x) => x.address === g.terminal_id);
      const where = a ? `${a.space_name} · ${a.tab_name}` : g.terminal || "";
      const focus = g.terminal_id ? () => run("agent.focus", { terminal: g.terminal_id }) : () => {};
      const left = Math.max(1, Math.ceil((g.deadline_ms - Date.now()) / 60_000));
      out.push({ key: `g-${g.id}`, group: "agents", section: 0, kind: "ACCÈS", tone: "blocked", time: g.started_ms, open: focus,
        title: where ? `${g.title} · ${where}` : g.title,
        body: [g.headline, g.step || g.why, g.command, `À valider dans la fenêtre gardien ou sur le téléphone · expire dans ${left} min`]
          .filter(Boolean).join(" — "),
        actions: g.terminal_id ? [{ label: "Aller au terminal", primary: true, run: focus }] : [] });
    }
    for (const a of live) {
      const focus = () => run("agent.focus", { terminal: a.address });
      const time = tabs.get(a.tab)?.changed_at;
      if (a.status === "blocked") {
        out.push({ key: `a-${a.address}`, group: "agents", section: 0, kind: "AGENT", tone: "blocked", time, open: focus,
          title: `${a.space_name} · ${a.tab_name}`, body: snippets[a.address] || "Waiting for you", actions: [] });
      } else if (a.status === "done") {
        out.push({ key: `a-${a.address}`, group: "agents", section: 1, kind: "DONE", tone: "done", time, open: focus,
          title: `${a.space_name} · ${a.tab_name} finished`, body: a.title || a.program?.name || "", actions: [] });
      }
    }
    if (shared("cc.settings")?.slack?.enabled !== false) out.push(...this.slackItems().filter((s) => s.ask && !s.ticked));
    for (const p of gh.prs ?? []) {
      if (p.ci !== "fail") continue;
      out.push({ key: `ci-${p.url}`, group: "github", section: 1, kind: "CI", tone: "blocked", open: () => openUrl(p.url),
        title: `#${p.number} failed: ${p.failed.map((f) => f.name).slice(0, 2).join(", ")}`, body: `${p.spaceName} · ${p.title}`,
        actions: [{ label: "Fix CI", primary: true, run: () => this.fixCi(p) }, { label: "Logs", run: () => openUrl(p.failed[0]?.url ?? p.url) }] });
    }
    for (const r of gh.reviews ?? []) {
      out.push({ key: `rv-${r.url}`, group: "github", section: 1, kind: "PR", tone: "accent", open: () => openUrl(r.url),
        title: `Review requested: #${r.number}`, body: `${r.repo} · ${r.title}${r.author ? ` · ${r.author}` : ""}`, actions: [] });
    }
    return out;
  }

  render() {
    const t = theme();
    const all = this.items();
    const filter = this.filter;
    const slack = shared("cc.slack") ?? {};
    const st = shared("cc.settings") ?? {};
    const slackOn = st.slack?.enabled !== false, every = st.slack?.everyMin ?? 30;
    const settings = (p) => setShared("cc.settings.update", { patch: p, at: Date.now() });
    const stop = (_e, cx) => cx.stop_propagation();

    const chip = (f) => {
      const n = f.id === "all" ? all.length : all.filter((i) => i.group === f.id).length;
      const on = filter === f.id;
      return h_flex().id(`f-${f.id}`).h(24).px(9).gap(5).items_center().rounded(12).text_size(11.5).border_1()
        .border_color(on ? t.input : t.border).bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_click(() => setShared("cc.inbox.filter", f.id))
        .child(f.label).child(div().text_color(t.dim).child(String(n)));
    };

    const button = (a, key) => div().id(key).px(9).py(3).rounded(5).text_size(11.5).font_medium().border_1()
      .border_color(a.primary ? t.solid : t.border).bg(a.primary ? t.solid : t.raised).text_color(a.primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.85)).on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); a.run(); cx.notify(); }).child(a.label);

    const row = (i) => h_flex().id(i.key).w_full().px(14).py(9).gap(10).items_start().border_b(1).border_color(t.border)
      .hover((s) => s.bg(t.hover)).on_click(() => i.open()).opacity(i.ticked ? 0.6 : 1)
      .child(div().w(50).flex_none().mt(1).py(2).rounded(4).bg(t.raised).text_color(t[i.tone] ?? t.muted).text_size(10).font_semibold().text_center().child(i.kind))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().font_medium().child(i.title))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(since(i.time))))
        .when(Boolean(i.body), (el) => el.child(div().text_size(12).text_color(t.muted).child(i.body)))
        .when(i.actions.length > 0, (el) => el.child(h_flex().mt(4).gap(6).flex_wrap().children(i.actions.map((a, n) => button(a, `${i.key}-b${n}`))))));

    const heading = (name) => div().px(14).pt(10).pb(4).text_size(11).font_medium().text_color(t.dim).child(name);
    let body;
    if (filter === "slack" && slackOn) {
      const s = this.slackItems();
      const asks = s.filter((i) => i.ask && !i.ticked), fyi = s.filter((i) => !i.ask && !i.ticked), ticked = s.filter((i) => i.ticked);
      body = [
        ...(asks.length ? [heading(`WAITING ON YOU · ${asks.length}`), ...asks.map(row)] : []),
        ...(fyi.length ? [heading(`FYI · ${fyi.length}`), ...fyi.map(row)] : []),
        ...(ticked.length ? [h_flex().px(14).py(10).gap(8).items_center().text_size(12).text_color(t.muted)
          .child(div().flex_1().child(`${ticked.length} closed today`))
          .child(button({ label: this.showTicked ? "Hide" : "Show", run: () => { this.showTicked = !this.showTicked; } }, "sl-show"))
          .child(button({ label: "Clear", run: () => slackAction("clear", []) }, "sl-clear")),
          ...(this.showTicked ? ticked.map(row) : [])] : []),
      ];
    } else {
      const shown = filter === "all" ? all : all.filter((i) => i.group === filter);
      body = SECTIONS.flatMap((name, s) => {
        const rows = shown.filter((i) => i.section === s);
        return rows.length ? [heading(name), ...rows.map(row)] : [];
      });
    }

    const sweep = slack.running ? "Slack: sweeping your DMs and mentions…"
      : slack.error ? `Slack sweep failed: ${slack.error}`
      : slack.lastAt ? `Slack swept ${clock(slack.lastAt)} · next ${clock(slack.lastAt + every * 60_000)}` : "Slack not swept yet";

    return v_flex().id("cc-inbox").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(v_flex().flex_none().px(14).pt(10).pb(8).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().font_semibold().child("Inbox"))
          .child(div().text_size(11).text_color(t.dim).child(`${all.length} open`)))
        .child(h_flex().gap(4).flex_wrap().children(FILTERS.filter((f) => f.id !== "slack" || slackOn).map(chip))))
      // Slack not connected: say how to connect it, or turn the sweep off, instead of a red error.
      .when(slackOn && Boolean(slack.notConnected) && (filter === "all" || filter === "slack"), (el) => el.child(v_flex().flex_none().px(14).py(10).gap(6)
        .border_b(1).border_color(t.border).bg(t.raised)
        .child(div().text_size(12.5).font_medium().child("Connect Slack to see asks for you"))
        .child(div().text_size(11.5).text_color(t.muted).child("The sweep reads Slack through Claude's Slack connector. In claude.ai, open Settings → Connectors → Slack and connect it, then check again."))
        .child(h_flex().gap(6).pt(2)
          .child(button({ label: slack.running ? "Checking…" : "Check again", primary: true, run: () => !slack.running && setShared("cc.slack.request", Date.now()) }, "sl-connect"))
          .child(button({ label: "I don't use Slack", run: () => settings({ slack: { enabled: false } }) }, "sl-off")))))
      .when(slackOn && !slack.notConnected && (filter === "all" || filter === "slack"), (el) => el.child(h_flex().flex_none().px(14).py(6).gap(8).items_center().text_size(11.5)
        .border_b(1).border_color(t.border).bg(slack.error ? t.raised : t.background).text_color(slack.error ? t.blocked : t.dim)
        .child(div().size(7).rounded(4).flex_none().bg(slack.error ? t.blocked : slack.running ? t.working : t.done))
        .child(div().flex_1().min_w(0).truncate().child(sweep))
        .when(!slack.running, (el) => el.child(button({ label: "Check now", run: () => setShared("cc.slack.request", Date.now()) }, "sl-check")))))
      .child(v_flex().id("cc-inbox-list").flex_1().min_h(0).overflow_y_scrollbar()
        .children(body)
        .when(body.length === 0, (el) => el.child(v_flex().p(24).gap(4).items_center()
          .child(div().text_color(t.muted).child(filter === "slack" ? "No Slack asks waiting on you" : "Nothing needs you"))
          .child(div().text_size(11.5).text_color(t.dim).child(`Agents update live; GitHub every ${st.github?.everyMin ?? 3} minutes${slackOn ? `; Slack every ${every}` : ""}`)))))
      .child(this.standupFooter(t, button));
  }

  standupFooter(t, button) {
    const s = shared("cc.standup") ?? {};
    const su = shared("cc.settings")?.standup;
    if (su && !su.enabled) return h_flex().id("cc-standup-foot").flex_none().px(14).py(9).gap(8).items_center().border_t(1).border_color(t.border).bg(t.chrome)
      .child(div().flex_1().text_size(12).text_color(t.dim).child("Standup draft is off"))
      .child(button({ label: "Settings", run: () => openOverlay({ mod: "cc-settings", kind: "dialog", width: 640, height: 0.85 }) }, "su-settings"));
    const times = [...(su?.times ?? [23])].sort((a, b) => a - b);
    const next = times.find((h) => new Date().getHours() < h) ?? times[0];
    const status = s.running ? "Writing…" : s.error ? `Failed: ${s.error}` : `${s.at ? `Written ${clock(s.at)}` : "Not written yet"} · next ${next}:00`;
    // The Standup pane beside the terminals: the open one if there is one, else a new split.
    const open = () => {
      const pane = panes().find((p) => p.mod === "cc-standup");
      if (pane) run("pane.focus", { pane: pane.pane });
      else run("pane.split", { direction: "right", mod: "cc-standup" });
    };
    return h_flex().id("cc-standup-foot").flex_none().px(14).py(9).gap(8).items_center().border_t(1).border_color(t.border).bg(t.chrome)
      .hover((st) => st.bg(t.hover)).on_click(() => open())
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().font_medium().child(`Standup${s.label ? ` for ${s.label}` : ""}`))
        .child(div().truncate().text_size(11.5).text_color(s.error ? t.blocked : t.dim).child(status)))
      .when(Boolean(s.text) && !s.running, (el) => el.child(button({ label: "Copy", primary: true,
        run: () => exec("sh", ["-c", 'printf %s "$1" | pbcopy', "sh", s.text]) }, "su-copy")))
      .when(!s.running, (el) => el.child(button({ label: "Write now", run: () => setShared("cc.standup.request", Date.now()) }, "su-write")));
  }
}
