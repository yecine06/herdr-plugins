// Command Center settings: what runs, how often, with which model, and roughly what it costs a day.
// Reads shared "cc.settings" and saves through cc-status (shared "cc.settings.update"), which writes
// ~/.config/herdr-app/command-center.json.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { shared, setShared, theme, props, closeOverlay, home } from "herdr";

const HOURS = [{ id: "9-19", label: "09–19", v: [9, 19] }, { id: "7-22", label: "07–22", v: [7, 22] }, { id: "0-24", label: "All day", v: [0, 24] }];
const MODELS = [{ id: "haiku", label: "Haiku" }, { id: "sonnet", label: "Sonnet" }];
const STANDUP_TIMES = [9, 10, 11, 12, 17, 18, 19, 21, 23];
// Rough cost of one run, in dollars, from runs measured while building this; a guide, not a bill.
const RUN = { linear: { haiku: 0.008, sonnet: 0.05 }, slack: { haiku: 0.06, sonnet: 0.35 }, standup: { haiku: 0.05, sonnet: 0.25 } };

const span = ([from, to]) => (from <= to ? to - from : 24 - from + to);
const tilde = (p) => p.replace(home(), "~");
const untilde = (p) => p.trim().replace(/^~(?=\/|$)/, home());
const clone = (v) => JSON.parse(JSON.stringify(v));

export function dailyCost(s) {
  const runs = (x) => (x.enabled ? (span(x.hours) * 60) / x.everyMin : 0);
  const linear = 0;
  const slack = runs(s.slack) * RUN.slack[s.slack.model];
  const standup = s.standup.enabled ? s.standup.times.length * RUN.standup[s.standup.model] : 0;
  return { linear, slack, standup, total: linear + slack + standup };
}

export default class Settings extends View {
  init(_props, cx) {
    const s = shared("cc.settings");
    this.draft = s ? clone({ repoRoots: s.repoRoots, github: s.github, linear: s.linear, slack: s.slack, standup: s.standup, usage: s.usage }) : null;
    this.roots = InputState.new({ value: (s?.repoRoots ?? []).map(tilde).join(", "), placeholder: "Leave empty: the folders of the repos open in Herdr" });
    this.handle = cx.focus_handle();
  }

  save() {
    const roots = this.roots.value().split(",").map(untilde).filter(Boolean);
    setShared("cc.settings.update", { patch: { ...this.draft, repoRoots: roots.length ? roots : null }, at: Date.now() });
    closeOverlay(props()?.overlay);
  }

  render() {
    const t = theme();
    const d = this.draft;
    const close = () => closeOverlay(props()?.overlay);
    if (!d) return v_flex().p(24).bg(t.popover).text_color(t.dim).child("Settings aren't loaded yet. The status bar loads them; try again in a moment.");

    const seg = (id, options, value, pick) => h_flex().p(2).gap(2).rounded(7).bg(t.background).border_1().border_color(t.border).children(options.map((o) =>
      div().id(`${id}-${o.id}`).px(10).py(4).rounded(5).text_size(12).cursor_pointer()
        .bg(value === o.id ? t.selected : t.background).text_color(value === o.id ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { pick(o.id); cx.notify(); }).child(o.label)));
    const toggle = (id, on, flip) => h_flex().id(id).w(34).h(20).p(2).rounded(10).cursor_pointer().bg(on ? t.accent : t.raised)
      .border_1().border_color(on ? t.accent : t.input).justify_start().when(on, (el) => el.justify_end())
      .on_click((_e, cx) => { flip(); cx.notify(); })
      .child(div().size(14).rounded(7).bg(on ? t.accent_foreground : t.muted));
    const row = (label, control, note) => h_flex().gap(12).items_center().py(5)
      .child(v_flex().w(150).flex_none().gap(1).child(div().text_size(12.5).child(label)).when(Boolean(note), (el) => el.child(div().text_size(11).text_color(t.dim).child(note))))
      .child(div().flex_1().min_w(0).child(control));
    const card = (id, title, sub, enabled, flip, body) => v_flex().id(id).p(14).gap(4).rounded(10).bg(t.background).border_1().border_color(t.border)
      .child(h_flex().gap(10).items_center()
        .child(v_flex().flex_1().gap(1).child(div().font_semibold().child(title)).child(div().text_size(11.5).text_color(t.dim).child(sub)))
        .when(Boolean(flip), (el) => el.child(toggle(`${id}-on`, enabled, flip))))
      .when(enabled !== false, (el) => el.child(v_flex().pt(6).children(body)));
    const hours = (x) => seg(`${x}-hours`, HOURS, HOURS.find((h) => h.v.join() === d[x].hours.join())?.id ?? "", (id) => { d[x].hours = HOURS.find((h) => h.id === id).v; });
    const every = (x, options) => seg(`${x}-every`, options.map((m) => ({ id: m, label: m < 60 ? `${m} min` : `${m / 60} h` })), d[x].everyMin, (v) => { d[x].everyMin = v; });

    const cost = dailyCost(d);
    const money = (v) => (v < 0.01 ? "<1¢" : `$${v.toFixed(2)}`);

    return v_flex().id("cc-settings").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { close(); cx.stop_propagation(); } })
      .size_full().bg(t.popover).text_color(t.foreground).text_size(13)
      .child(v_flex().flex_none().px(20).pt(18).pb(12).gap(4).border_b(1).border_color(t.border)
        .child(h_flex().items_center().child(div().flex_1().text_size(16).font_semibold().child("Command Center settings")).child(div().text_size(11).text_color(t.dim).child("Esc")))
        .child(div().text_size(12).text_color(cost.total > 5 ? t.working : t.muted).child(
          `About ${money(cost.total)} a day in Claude runs at these settings` +
          ` (Slack ${money(cost.slack)}, standup ${money(cost.standup)}; ClickUp is free). Task summaries add 1–2¢ per agent turn that changes code.`)))
      .child(v_flex().id("cc-settings-body").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14).gap(12)
        .child(card("gh", "GitHub", "PR checks for your spaces' branches and review requests, through gh. Free.", d.github.enabled, () => { d.github.enabled = !d.github.enabled; }, [
          row("Check every", seg("gh-every", [3, 5, 10].map((m) => ({ id: m, label: `${m} min` })), d.github.everyMin, (v) => { d.github.everyMin = v; })),
          row("Review requests", seg("gh-rev", [{ id: "direct", label: "Asked of me" }, { id: "all", label: "Including my teams" }], d.github.reviews, (v) => { d.github.reviews = v; })),
        ]))
        .child(card("lin", "ClickUp", "Your open tasks, through clickup-cli. Free.", d.linear.enabled, () => { d.linear.enabled = !d.linear.enabled; }, [
          row("Check every", every("linear", [15, 30, 60])),
          row("Between", hours("linear")),
        ]))
        .child(card("sl", "Slack sweep", "Asks in your DMs and @-mentions, through Claude's Slack connector. Read only.", d.slack.enabled, () => { d.slack.enabled = !d.slack.enabled; }, [
          row("Sweep every", every("slack", [30, 60, 120])),
          row("Between", hours("slack")),
          row("Model", seg("sl-model", MODELS, d.slack.model, (v) => { d.slack.model = v; }), "Sonnet judges asks better"),
        ]))
        .child(card("su", "Standup draft", "\"What did you accomplish?\" from commits, PRs, task notes, Linear and Slack.", d.standup.enabled, () => { d.standup.enabled = !d.standup.enabled; }, [
          row("Write at", h_flex().gap(4).flex_wrap().children(STANDUP_TIMES.map((h) => {
            const on = d.standup.times.includes(h);
            return div().id(`su-t-${h}`).px(8).py(3).rounded(5).text_size(12).cursor_pointer().border_1()
              .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
              .on_click((_e, cx) => { d.standup.times = on ? d.standup.times.filter((x) => x !== h) : [...d.standup.times, h].sort((a, b) => a - b); if (!d.standup.times.length) d.standup.times = [h]; cx.notify(); })
              .child(`${String(h).padStart(2, "0")}:00`);
          })), "Before the switch hour it writes the previous working day"),
          row("New day from", seg("su-cut", [17, 18, 19, 20].map((h) => ({ id: h, label: `${h}:00` })), d.standup.cutover, (v) => { d.standup.cutover = v; })),
          row("Weekends", seg("su-wk", [{ id: true, label: "Skip" }, { id: false, label: "Include" }], d.standup.weekdaysOnly, (v) => { d.standup.weekdaysOnly = v; })),
          row("Model", seg("su-model", MODELS, d.standup.model, (v) => { d.standup.model = v; })),
        ]))
        .child(card("repos", "Repo folders", "Where Start from issue, the standup and the Board look for repos (three levels deep).", undefined, null, [
          Input.new(this.roots).h(32).px(10).rounded(7).border_1().border_color(t.input).bg(t.popover).text_size(12.5),
          div().pt(4).text_size(11).text_color(t.dim).child("Comma separated. Empty: the folders of the repos open in Herdr."),
        ]))
        .child(card("use", "Usage bars", "Plan limits at the foot of the sidebar. Claude's come from your Claude Code login in the Keychain.", undefined, null, [
          row("Claude Code", toggle("use-claude", d.usage.claude, () => { d.usage.claude = !d.usage.claude; })),
          row("Codex", toggle("use-codex", d.usage.codex, () => { d.usage.codex = !d.usage.codex; })),
        ])))
      .child(h_flex().flex_none().px(20).py(12).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(tilde(shared("cc.settings")?.file ?? "")))
        .child(h_flex().id("set-cancel").h(32).px(14).items_center().rounded(8).border_1().border_color(t.input).bg(t.raised).text_size(12.5).cursor_pointer()
          .on_click(() => close()).child("Cancel"))
        .child(h_flex().id("set-save").h(32).px(14).items_center().rounded(8).border_1().border_color(t.solid).bg(t.solid).text_color(t.solid_foreground)
          .text_size(12.5).font_medium().cursor_pointer().on_click(() => this.save()).child("Save")));
  }
}
