// Hand a Slack ask to an agent: a new one in the shown space, or one already there that's free.
// Optionally have it search Slack for an earlier answer first. props: { ask: { from, channel, text, permalink }, overlay }

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { agents, spaces, panes, focused, props, theme, run, hc, knownAgents, closeOverlay } from "herdr";

function message(ask, searchSlack) {
  const research = searchSlack
    ? "Read the thread, then search Slack across all channels for an earlier answer before anything else. Then check ClickUp and this codebase where it helps."
    : "Read the thread, then answer from this codebase and ClickUp. Don't search the rest of Slack.";
  return `${ask.from} asked me on Slack (${ask.channel}): "${ask.text}"\n${ask.permalink}\n\n${research}\nDraft a reply I can paste, with links to what you relied on. Don't post, react or send anything in Slack.`;
}

export default class Handoff extends View {
  init(_props, cx) {
    const ask = props()?.ask;
    if (!ask) return;
    this.searchSlack = localStorage.getItem("searchSlack") !== "0";
    const f = focused();
    const here = agents().filter((a) => a.space === f?.space);
    const mine = here.find((a) => a.address === f?.terminal && (a.status === "idle" || a.status === "done"));
    this.target = mine?.address ?? "new";
    this.claude = ["claude"];
    this.text = TextareaState.new({ value: message(ask, this.searchSlack), rows: 7 });
    this.edited = false;
    this.text.on("change", () => { this.edited = true; });
    this.error = null;
    this.handle = cx.focus_handle();
    cx.spawn(async () => {
      const found = (await knownAgents().catch(() => [])).find((a) => a.key === "claude");
      if (found?.run?.length) this.claude = found.run;
    });
  }

  toggleSearch() {
    this.searchSlack = !this.searchSlack;
    localStorage.setItem("searchSlack", this.searchSlack ? "1" : "0");
    // Keep the person's own wording; only rewrite a message they haven't touched.
    if (!this.edited) this.text.set_value(message(props().ask, this.searchSlack));
  }

  go(cx) {
    const text = this.text.value().trim();
    if (!text) return;
    if (this.target === "new") {
      const f = focused();
      const space = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active);
      const tabIds = new Set(space?.tabs.map((t) => t.id) ?? []);
      const folder = panes().find((p) => tabIds.has(p.tab) && p.cwd)?.cwd;
      run("tab.new", { space: space?.id, name: `Slack: ${props().ask.from}`, folder, argv: [...this.claude, "--permission-mode", "plan"], task: text });
      closeOverlay(props().overlay);
      return;
    }
    const address = this.target;
    cx.spawn(async (cx) => {
      // --if idle: never type into an agent that's working or showing a prompt.
      const r = await hc(["send", "--if", "idle", address, text]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) { run("agent.focus", { terminal: address }); closeOverlay(props().overlay); }
      else { this.error = (r.stderr || r.stdout || "Couldn't send it").trim().split("\n")[0]; cx.notify(); }
    });
  }

  render(cx) {
    const t = theme();
    const ask = props()?.ask;
    if (!ask) return div();
    const f = focused();
    const here = agents().filter((a) => a.space === f?.space);
    const free = (a) => a.status === "idle" || a.status === "done";
    const space = spaces().find((s) => s.id === f?.space);

    const option = (id, title, sub, enabled) => h_flex().id(`to-${id}`).px(10).py(8).gap(10).items_center().rounded(8).border_1()
      .border_color(this.target === id ? t.accent : t.border).bg(this.target === id ? t.selected : t.background)
      .opacity(enabled ? 1 : 0.5).cursor_pointer()
      .on_click((_e, cx) => { if (enabled) { this.target = id; this.error = null; cx.notify(); } })
      .child(div().size(12).rounded(6).border_2().border_color(this.target === id ? t.accent : t.input))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(13).font_medium().truncate().child(title))
        .child(div().text_size(11.5).text_color(t.dim).truncate().child(sub)));
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click((_e, cx) => action(cx)).child(text);
    const label = (text) => div().pt(14).pb(6).text_size(11).font_medium().text_color(t.dim).child(text);
    const status = { idle: "free", done: "finished, free", working: "working: can't take it now", blocked: "waiting on you: can't take it now" };

    return v_flex().id("cc-handoff").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .w_full().p(20).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(h_flex().items_center().gap(8)
        .child(div().text_size(15).font_semibold().child(`Hand to an agent · ${ask.from}`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(4).text_size(12).text_color(t.muted).child(`${ask.channel}: ${ask.text}`))
      .child(label("WHO TAKES IT"))
      .child(v_flex().gap(6)
        .child(option("new", `New agent in ${space?.name ?? "this space"}`, "Claude in plan mode, in a new tab", true))
        .children(here.map((a) => option(a.address, `${a.tab_name} · ${a.program?.name ?? "agent"}`,
          `${a.address === f?.terminal ? "focused · " : ""}${status[a.status] ?? a.status}`, free(a)))))
      .child(h_flex().id("search").pt(14).gap(8).items_center().cursor_pointer().on_click((_e, cx) => { this.toggleSearch(); cx.notify(); })
        .child(div().size(14).rounded(3).border_1().border_color(this.searchSlack ? t.accent : t.input).bg(this.searchSlack ? t.accent : t.background)
          .text_size(10).text_color(t.accent_foreground).text_center().child(this.searchSlack ? "✓" : ""))
        .child(div().text_size(12.5).child("Search Slack for an earlier answer first")))
      .child(label("MESSAGE"))
      .child(Textarea.new(this.text).h(130).px(10).py(8).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5))
      .when(Boolean(this.error), (el) => el.child(div().pt(8).text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().pt(16).gap(8).justify_end()
        .child(button("ho-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("ho-go", this.target === "new" ? "Start agent" : "Send to agent", true, (cx) => this.go(cx))));
  }
}
