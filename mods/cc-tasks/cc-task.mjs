#!/usr/bin/env node
// Task notes for agents in Herdr terminals. Files live in <repo>/.agents/tasks/ (kept out of git via info/exclude):
//   <ISSUE>.md               notes the agent writes, for work on a ClickUp task's branch
//   <space>.md, "## <tab>"   the same without an issue: one file per space, a section per tab
//   .summary/<key>.json      what the Tasks panel shows, rewritten after each turn that changed code
//
//   cc-task.mjs path         print the notes file (and section) for this terminal, creating it if needed
//   cc-task.mjs hook         Claude Code Stop hook: starts a background summary and returns at once
//   cc-task.mjs summarize    the background summary (started by hook)

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const APP = process.env.HERDR_APP_HOME || join(HOME, ".config", "herdr-app");
const SELF = fileURLToPath(import.meta.url);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MODEL = "haiku";

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 20_000 });
  return r.status === 0 ? r.stdout.trim() : null;
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "space";
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const writeAtomic = (f, text) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(`${f}.tmp`, text); renameSync(`${f}.tmp`, f); };

// Herdr's space and tab for a terminal, from `hc ls` ("space / tab").
function where(terminal) {
  const out = terminal && run("hc", ["ls", "--json"]);
  const list = out ? JSON.parse(out) : [];
  const t = (Array.isArray(list) ? list : list.terminals ?? []).find((x) => x.address === terminal);
  const parts = (t?.where ?? "").split(" / ");
  return parts.length >= 2 ? { space: parts.slice(0, -1).join(" / "), tab: parts.at(-1) } : null;
}

// The ClickUp task a branch belongs to: its ID in the branch, or an ID with a prefix you have tasks under.
function issueOf(branch) {
  if (!branch) return null;
  const issues = readJson(join(APP, "shared.json"))?.["cc.linear"]?.issues ?? [];
  const b = branch.toLowerCase();
  const hit = issues.find((i) => b === (i.branchName ?? "").toLowerCase() || b.includes(i.identifier.toLowerCase()));
  if (hit) return { id: hit.identifier, title: hit.title };
  const teams = [...new Set(issues.map((i) => i.identifier.split("-")[0].toLowerCase()))];
  const m = teams.length ? b.match(new RegExp(`(?:^|[^a-z])(${teams.join("|")})-(\\d+)`)) : null;
  return m ? { id: `${m[1].toUpperCase()}-${m[2]}`, title: null } : null;
}

function target(cwd, terminal) {
  const root = run("git", ["rev-parse", "--show-toplevel"], cwd);
  if (!root) return null;
  const branch = run("git", ["branch", "--show-current"], cwd);
  const issue = issueOf(branch);
  const dir = join(root, ".agents", "tasks");
  if (issue) return { root, dir, branch, key: issue.id, title: issue.title ?? issue.id, notes: join(dir, `${issue.id}.md`), section: null };
  const w = where(terminal);
  if (!w) return null;
  const key = `${slug(w.space)}--${slug(w.tab)}`;
  return { root, dir, branch, key, title: `${w.space} › ${w.tab}`, notes: join(dir, `${slug(w.space)}.md`), section: w.tab };
}

function ensureIgnored(root) {
  let common = run("git", ["rev-parse", "--git-common-dir"], root);
  if (!common) return;
  if (!isAbsolute(common)) common = join(root, common);
  const exclude = join(common, "info", "exclude");
  const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!text.split("\n").includes(".agents/tasks/")) {
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${text && !text.endsWith("\n") ? "\n" : ""}.agents/tasks/\n`);
  }
}

const TEMPLATE = "### Goal\n\n### Plan\n\n### Decisions\n\n### Assumptions\n\n### Not done\n";

function path() {
  const t = target(process.cwd(), process.env.HC_TERMINAL_ID);
  if (!t) { console.log("No notes: not in a git repo, or not in a Herdr terminal."); return; }
  mkdirSync(t.dir, { recursive: true });
  ensureIgnored(t.root);
  const text = existsSync(t.notes) ? readFileSync(t.notes, "utf8") : "";
  if (!text) writeFileSync(t.notes, t.section ? `# ${t.title.split(" › ")[0]}\n\n## ${t.section}\n\n${TEMPLATE}` : `# ${t.title}\n\n${TEMPLATE.replace(/###/g, "##")}`);
  else if (t.section && !text.split("\n").includes(`## ${t.section}`)) appendFileSync(t.notes, `\n## ${t.section}\n\n${TEMPLATE}`);
  console.log(`Notes: ${t.notes}${t.section ? `\nSection: ## ${t.section} (keep to this section)` : ""}`);
}

// Messages after the last prompt the person typed.
function lastTurn(transcript) {
  const lines = readFileSync(transcript, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const msgs = lines.filter((o) => (o.type === "user" || o.type === "assistant") && !o.isMeta && o.message);
  const isPrompt = (o) => o.type === "user" && (typeof o.message.content === "string" || o.message.content.some((c) => c.type === "text"));
  let start = msgs.length - 1;
  while (start > 0 && !isPrompt(msgs[start])) start--;
  return msgs.slice(start);
}

function digest(turn) {
  const out = [], edits = [], plans = [], commands = new Set();
  let budget = 9000;
  const add = (s) => { if (budget > 0) { out.push(s.slice(0, budget)); budget -= s.length; } };
  for (const o of turn) {
    const content = typeof o.message.content === "string" ? [{ type: "text", text: o.message.content }] : o.message.content;
    for (const c of content) {
      if (c.type === "text" && c.text.trim()) add(`${o.type === "user" ? "PERSON" : "AGENT"}: ${c.text.trim().slice(0, o.type === "user" ? 1500 : 700)}`);
      if (c.type === "tool_use") {
        const i = c.input ?? {};
        if (EDIT_TOOLS.has(c.name)) edits.push(i.file_path ?? i.notebook_path ?? "?");
        if (/\/\.claude\/plans\/|\.agents\/tasks\/.*plan/i.test(i.file_path ?? "")) plans.push(i.file_path);
        if (c.name === "ExitPlanMode" && i.plan) add(`PLAN: ${String(i.plan).slice(0, 1500)}`);
        const what = i.command ?? i.file_path ?? i.pattern ?? i.description ?? "";
        add(`TOOL ${c.name}${what ? `: ${String(what).slice(0, 160)}` : ""}`);
        if (c.name === "Bash") commands.add(c.id);
      }
      // A command's outcome, so passing tests and checks count as verified.
      if (c.type === "tool_result" && commands.has(c.tool_use_id)) {
        const text = (typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x.text ?? "").join("\n")).trim();
        add(`RESULT ${c.is_error ? "(failed)" : "(ok)"}: ${text.slice(-240)}`);
      }
      if (c.type === "tool_result" && /AskUserQuestion|answered/i.test(JSON.stringify(c).slice(0, 400))) add(`PERSON ANSWERED: ${JSON.stringify(c.content).slice(0, 600)}`);
    }
  }
  return { text: out.join("\n"), edits, plans };
}

function hook() {
  if (process.env.CC_TASKS_SUMMARY || !process.env.HC_TERMINAL_ID) return;
  let input = "";
  try { input = readFileSync(0, "utf8"); } catch { return; }
  const h = JSON.parse(input || "{}");
  if (!h.transcript_path || !existsSync(h.transcript_path)) return;
  if (!digest(lastTurn(h.transcript_path)).edits.length) return;
  const child = spawn(process.execPath, [SELF, "summarize", JSON.stringify({ transcript: h.transcript_path, cwd: h.cwd ?? process.cwd(), terminal: process.env.HC_TERMINAL_ID })],
    { detached: true, stdio: "ignore", env: { ...process.env, CC_TASKS_SUMMARY: "1" } });
  child.unref();
}

const SCHEMA = JSON.stringify({
  type: "object", required: ["goal", "steps", "decisions", "notDone"],
  properties: {
    goal: { type: "string" }, planFile: { type: "string" },
    steps: { type: "array", items: { type: "object", required: ["state", "text"], properties: { state: { enum: ["done", "now", "todo"] }, text: { type: "string" } } } },
    decisions: { type: "array", items: { type: "object", required: ["kind", "text"], properties: { kind: { enum: ["decision", "assumption", "you_said"] }, text: { type: "string" } } } },
    notDone: { type: "array", items: { type: "string" } },
  },
});

function summarize(arg) {
  const { transcript, cwd, terminal } = JSON.parse(arg);
  const t = target(cwd, terminal);
  if (!t) return;
  mkdirSync(t.dir, { recursive: true });
  ensureIgnored(t.root);
  const out = join(t.dir, ".summary", `${t.key}.json`);
  const lock = `${out}.lock`;
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < 5 * 60_000) return;
  writeAtomic(lock, String(process.pid));
  try {
    const prev = readJson(out);
    const turn = digest(lastTurn(transcript));
    let notes = existsSync(t.notes) ? readFileSync(t.notes, "utf8") : "";
    if (t.section) notes = notes.split(/\n(?=## )/).find((s) => s.startsWith(`## ${t.section}\n`)) ?? "";
    const prompt = [
      "You keep a short summary of an AI coding agent's task, for the developer who reviews its work.",
      "Update the previous summary with the latest turn. Return the whole summary:",
      "- goal: one or two sentences.",
      "- steps: the plan, at most 7, each done, now or todo.",
      "- decisions: at most 8. kind decision = a choice the agent made; assumption = something it assumed without confirmation, worded so a reviewer knows what to check; you_said = the developer's own instruction or answer, briefly quoted.",
      "- notDone: at most 5: skipped tests, TODOs, open questions, risks.",
      "- planFile: the plan file's path if one was written, else empty.",
      "Plain words, each item under 140 characters. Prefer the agent's own notes where they exist. Never invent.",
      `\nTask: ${t.title}`,
      `\nPrevious summary:\n${prev ? JSON.stringify({ goal: prev.goal, planFile: prev.planFile, steps: prev.steps, decisions: prev.decisions, notDone: prev.notDone }) : "(none)"}`,
      `\nAgent's notes:\n${notes.slice(0, 4000) || "(none)"}`,
      `\nPlan files written this turn: ${turn.plans.join(", ") || "none"}`,
      `\nLatest turn:\n${turn.text}`,
    ].join("\n");
    const work = join(APP, "data", "cc-claude");
    mkdirSync(work, { recursive: true });
    const r = spawnSync(join(HOME, ".local", "bin", "claude"), ["-p", prompt, "--model", MODEL, "--tools", "", "--output-format", "json",
      "--json-schema", SCHEMA, "--no-session-persistence", "--max-budget-usd", "0.3"], { cwd: work, encoding: "utf8", timeout: 180_000, env: process.env });
    let s = null;
    try { s = JSON.parse(r.stdout).structured_output; } catch { /* reported below */ }
    if (!s) { writeAtomic(join(t.dir, ".summary", `${t.key}.error`), `${r.status}\n${r.stdout}\n${r.stderr}`); return; }
    writeAtomic(out, JSON.stringify({ ...s, title: t.title, notes: t.notes, section: t.section, branch: t.branch,
      turns: (prev?.turns ?? 0) + 1, updatedAt: Date.now() }, null, 2));
  } finally {
    spawnSync("rm", ["-f", lock]);
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "path") path();
else if (cmd === "hook") { try { hook(); } catch { /* never block the agent */ } }
else if (cmd === "summarize") summarize(arg);
else if (cmd) console.log("usage: cc-task.mjs path | hook");
