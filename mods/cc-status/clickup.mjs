#!/usr/bin/env node
// ClickUp tasks assigned to you, in the shape the panels expect (the former Linear issue shape), through clickup-cli.
// Free and fast: no Claude run. Prints one JSON object: { connected, error, issues }.
//
//   clickup.mjs list            open tasks assigned to you
//   clickup.mjs start <taskId>  move a task to its "started" status

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const CLI = join(homedir(), ".local", "bin", "clickup-cli");
const cli = (args) => JSON.parse(execFileSync(CLI, [...args, "--json"], { encoding: "utf8", timeout: 90_000, maxBuffer: 64 << 20 }));

// ClickUp statuses are free text per list: map each onto a stage (the board column) and a step (what
// starting it means: dev, analyse, review, qa, mep, or none when someone else has to act).
// Order matters: the first match wins.
const STAGES = [
  ["closed", "none", /rejet|annul|abandon|termin|^done$|^complete|^ok client|^ferm/i],
  // Sales pipeline lists (lead › proposal › …) are not development work.
  ["ignored", "none", /^(lead|premiers meetings|proposal|negociation|projet lanc[ée])$/i],
  ["review", "mep", /mettre en prod|^a mep$|^mep$|mise en prod/i],
  ["review", "review", /review/i],
  // QA: someone checks the change; the assignee is the one who does it.
  ["review", "qa", /v[ée]rifi|tester|recette/i],
  ["waiting", "none", /en attente|en cours client/i],
  ["started", "analyse", /conception/i],
  ["started", "dev", /en cours|in progress|doing|en run/i],
  ["unstarted", "analyse", /qualifier|estimer|planifier/i],
  ["backlog", "none", /backlog/i],
];
const PRIORITY = { urgent: 1, high: 2, normal: 3, low: 4 };

function classify(status, type) {
  const s = status.trim();
  for (const [stage, step, re] of STAGES) if (re.test(s)) return { stage, step };
  return type === "closed" ? { stage: "closed", step: "none" } : type === "done" ? { stage: "review", step: "qa" } : { stage: "unstarted", step: "dev" };
}
const stage = (status, type) => classify(status, type).stage;

function list() {
  const me = cli(["user", "me"]).data;
  const id = (me.user ?? me).id;
  const fields = "id,custom_id,name,status.status,status.type,priority.priority,url,list.id,list.name,folder.id,folder.name,folder.hidden,space.id,team_id,text_content";
  const tasks = cli(["tasks", "search", "--assignees", String(id), "--subtasks", "--all-pages", "--fields", fields]).data ?? [];
  const spaces = new Map();
  for (const team of new Set(tasks.map((t) => t.team_id).filter(Boolean))) {
    const out = cli(["spaces", "list", "--team-id", String(team)]).data;
    for (const sp of (Array.isArray(out) ? out : out?.spaces ?? [])) spaces.set(String(sp.id), sp.name);
  }
  const issues = tasks.map((t) => ({
    identifier: t.custom_id || t.id,
    taskId: t.id,
    title: t.name,
    state: t["status.status"],
    stateType: stage(t["status.status"] ?? "", t["status.type"]),
    step: classify(t["status.status"] ?? "", t["status.type"]).step,
    priority: PRIORITY[t["priority.priority"]] ?? 0,
    url: t.url,
    description: (t.text_content ?? "").slice(0, 600),
    // Where it lives in ClickUp: space › folder › list. A folderless list has a hidden folder: no folder level.
    space: spaces.get(String(t["space.id"])) ?? "",
    spaceId: String(t["space.id"] ?? ""),
    folder: t["folder.hidden"] ? "" : t["folder.name"] ?? "",
    folderId: t["folder.hidden"] ? "" : String(t["folder.id"] ?? ""),
    list: t["list.name"] ?? "",
    listId: String(t["list.id"] ?? ""),
    project: t["list.name"] ?? "",
    cycle: t["folder.hidden"] ? "" : t["folder.name"] ?? "",
  })).filter((i) => i.stateType !== "closed" && i.stateType !== "ignored");
  return { connected: true, error: "", issues };
}

// The list's development status: "en cours" itself, else "en cours de dev" or "en cours tech", else the
// first in-progress status that is development (not design, not the client's turn).
function start(taskId) {
  const task = cli(["tasks", "get", taskId]).data;
  const statuses = cli(["api", "GET", `/v2/list/${task.list.id}`]).data?.statuses ?? [];
  const dev = statuses.filter((s) => { const c = classify(s.status, s.type); return c.stage === "started" && c.step === "dev"; });
  const target = dev.find((s) => /^en cours$/i.test(s.status.trim())) ?? dev.find((s) => /dev|tech/i.test(s.status)) ?? dev[0];
  if (!target) throw new Error(`no in-progress status in list ${task.list.name}`);
  cli(["tasks", "update", taskId, "--status", target.status]);
  return { ok: true, status: target.status };
}

const [cmd, arg] = process.argv.slice(2);
try {
  console.log(JSON.stringify(cmd === "start" ? start(arg) : list()));
} catch (e) {
  const msg = String(e?.stderr || e?.message || e).trim().split("\n")[0].slice(0, 160);
  const auth = /401|unauthor|token|OAUTH/i.test(msg);
  console.log(JSON.stringify({ connected: !auth, error: msg || "clickup-cli failed", issues: [] }));
  process.exitCode = 1;
}
