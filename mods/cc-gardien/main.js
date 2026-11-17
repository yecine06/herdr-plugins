// What gardien did: every access an agent asked for (AWS, SSH, 1Password secrets), how it was answered, and the
// daemon's own events. cc-status shares the last entries gardien writes to pending/history.json.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, shared, setShared, theme, run, exec } from "herdr";

const FILTERS = [
  { id: "all", label: "Tout" },
  { id: "asked", label: "Validées" },
  { id: "denied", label: "Refusées" },
  { id: "events", label: "Événements" },
];

const clock = (iso) => new Date(iso).toTimeString().slice(0, 8);
const day = (iso) => new Date(iso).toDateString();

function kind(e) {
  if (e.event) return e.event === "audit-shrank" ? { tag: "ALERTE", tone: "blocked" } : { tag: "INFO", tone: "muted" };
  const d = e.decision ?? "";
  if (d.startsWith("approved")) return { tag: "OK", tone: "done" };
  if (d.startsWith("granted")) return { tag: "AUTO", tone: "accent" };
  if (d.startsWith("denied")) return { tag: "REFUS", tone: "blocked" };
  return { tag: "ERREUR", tone: "blocked" };
}

function target(e) {
  const p = e.profile ?? "";
  if (p.startsWith("ssh:")) return `SSH ${p.slice(4)}`;
  if (p.startsWith("op:")) return `1Password ${p.slice(3).replaceAll("op://", "")}`;
  return e.role ? `AWS ${p} · ${e.role}` : `AWS ${p}`;
}

// "approved (this command, mac touch id)" → "cette commande · Touch ID"
function how(e) {
  const d = e.decision ?? "";
  const words = [
    [/this command/, "cette commande"], [/15 min session grant/, "15 min"], [/session grant until ([0-9:]+)/, "session jusqu'à $1"],
    [/covered by the approved ssh connection: (.*)\)$/, "couvert par la connexion SSH ($1)"], [/mac touch id/, "Touch ID"],
    [/phone passkey/, "téléphone"], [/mac window/, "fenêtre Mac"], [/timeout/, "délai dépassé"], [/client gone.*/, "commande interrompue"],
  ];
  let out = d.replace(/^(approved|granted|denied) ?\(?/, "").replace(/\)$/, "");
  let err = (e.error ?? "").replace(/^refused in gardien \((.*)\)$/, "$1");
  for (const [re, fr] of words) { out = out.replace(re, fr); err = err.replace(re, fr); }
  if (d.startsWith("denied")) return `refusée${err ? ` : ${err}` : ""}`;
  return out + (err ? ` — ${err}` : "");
}

const EVENTS = {
  "daemon-start": "Démon démarré", revoke: "Tout révoqué", enroll: "Lien d'ajout de passkey envoyé",
  "enroll-refused": "Ajout de passkey refusé", "grant-expired": "Fin d'une validation 15 min", "audit-shrank": "⚠ Journal raccourci",
};

export default class Gardien extends View {
  init(_props, cx) {
    cx.timer.every(30_000, (cx) => cx.notify());
  }

  get filter() { return shared("cc.gardien.filter") ?? "all"; }

  render() {
    const t = theme();
    const all = [...(shared("cc.gardien.history") ?? [])].reverse();
    const pending = (shared("cc.gardien") ?? []).filter((g) => g.deadline_ms > Date.now());
    const today = day(new Date().toISOString());
    const f = this.filter;
    const shown = all.filter((e) =>
      f === "all" ? true
      : f === "events" ? Boolean(e.event)
      : f === "denied" ? !e.event && !/^(approved|granted)/.test(e.decision ?? "")
      : !e.event && /^(approved|granted)/.test(e.decision ?? ""));
    const live = agents();
    const focus = (term) => term && live.some((a) => a.address === term) ? () => run("agent.focus", { terminal: term }) : null;
    const todayN = all.filter((e) => !e.event && day(e.time) === today).length;
    const deniedN = all.filter((e) => !e.event && day(e.time) === today && !/^(approved|granted)/.test(e.decision ?? "")).length;

    const chip = (c) => {
      const on = f === c.id;
      return h_flex().id(`gf-${c.id}`).h(24).px(9).items_center().rounded(12).text_size(11.5).border_1()
        .border_color(on ? t.input : t.border).bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover)).on_click(() => setShared("cc.gardien.filter", c.id)).child(c.label);
    };

    const rows = [];
    let lastDay = "";
    shown.forEach((e, n) => {
      const d = day(e.time);
      if (d !== lastDay) {
        lastDay = d;
        rows.push(div().px(14).pt(10).pb(4).text_size(11).font_medium().text_color(t.dim)
          .child(d === today ? "AUJOURD'HUI" : new Date(e.time).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }).toUpperCase()));
      }
      const k = kind(e);
      const go = focus(e.herdr_terminal);
      const title = e.event ? EVENTS[e.event] ?? e.event : target(e);
      const body = e.event ? e.decision : how(e);
      rows.push(h_flex().id(`g-${n}`).w_full().px(14).py(8).gap(10).items_start().border_b(1).border_color(t.border)
        .hover((s) => s.bg(t.hover)).when(Boolean(go), (el) => el.on_click(() => go()))
        .child(div().w(50).flex_none().mt(1).py(2).rounded(4).bg(t.raised).text_color(t[k.tone] ?? t.muted).text_size(10).font_semibold().text_center().child(k.tag))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().font_medium().child(title))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(clock(e.time))))
          .child(div().text_size(12).text_color(t.muted).child(body))
          .when(!e.event && Boolean(e.tool), (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(e.tool)))
          .when(!e.event && Boolean(e.reason), (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(`Raison : ${e.reason}`)))
          .when(!e.event, (el) => el.child(div().text_size(10.5).text_color(t.dim)
            .child(`${e.session ?? ""}${e.herdr_terminal ? ` · ${e.herdr_terminal}` : ""}${go ? " · aller au terminal" : ""}`)))));
    });

    const button = (label, key, fn) => div().id(key).px(9).py(3).rounded(5).text_size(11.5).font_medium().border_1()
      .border_color(t.border).bg(t.raised).hover((s) => s.opacity(0.85)).on_click(() => fn()).child(label);

    return v_flex().id("cc-gardien").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(v_flex().flex_none().px(14).pt(10).pb(8).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().font_semibold().child("Gardien"))
          .child(div().flex_1().text_size(11).text_color(t.dim).child(`${todayN} accès aujourd'hui${deniedN ? ` · ${deniedN} refusés` : ""}${pending.length ? ` · ${pending.length} en attente` : ""}`))
          .child(button("Vérifier", "g-verify", () => exec("sh", ["-c", `"$HOME/Code/P01-perso/33.12-outils-perso/gardien/bin/gardien" log --verify > "$TMPDIR/gardien-verify.txt" 2>&1; open -e "$TMPDIR/gardien-verify.txt"`]))))
        .child(h_flex().gap(4).flex_wrap().children(FILTERS.map(chip))))
      .child(v_flex().id("cc-gardien-list").flex_1().min_h(0).overflow_y_scrollbar()
        .children(rows)
        .when(rows.length === 0, (el) => el.child(v_flex().p(24).gap(4).items_center()
          .child(div().text_color(t.muted).child("Rien pour l'instant"))
          .child(div().text_size(11.5).text_color(t.dim).child("Journal complet : gardien log")))))
      .child(div().flex_none().px(14).py(7).border_t(1).border_color(t.border).bg(t.chrome).text_size(11).text_color(t.dim)
        .child("150 dernières entrées · tout l'historique : gardien log · copie infalsifiable sur docker1"));
  }
}
