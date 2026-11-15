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

// ClickUp statuses are free text per list: map them onto the stages the panels know.
// Order matters: the first match wins.
const STAGES = [
  ["closed", /rejet|annul|abandon|termin|^done$|^complete/i],
  ["review", /review|v[ée]rifier|tester|recette|mettre en prod/i],
  ["started", /en cours|in progress|doing|en run/i],
  ["backlog", /backlog/i],
];
const PRIORITY = { urgent: 1, high: 2, normal: 3, low: 4 };

function stage(status, type) {
  for (const [s, re] of STAGES) if (re.test(status)) return s;
  return type === "closed" ? "closed" : type === "done" ? "review" : "unstarted";
}

function list() {
  const me = cli(["user", "me"]).data;
  const id = (me.user ?? me).id;
  const fields = "id,custom_id,name,status.status,status.type,priority.priority,url,list.name,folder.name,text_content";
  const tasks = cli(["tasks", "search", "--assignees", String(id), "--subtasks", "--all-pages", "--fields", fields]).data ?? [];
  const issues = tasks.map((t) => ({
    identifier: t.custom_id || t.id,
    taskId: t.id,
    title: t.name,
    state: t["status.status"],
    stateType: stage(t["status.status"] ?? "", t["status.type"]),
    priority: PRIORITY[t["priority.priority"]] ?? 0,
    url: t.url,
    description: (t.text_content ?? "").slice(0, 600),
    project: t["list.name"] ?? "",
    cycle: t["folder.name"] ?? "",
  })).filter((i) => i.stateType !== "closed");
  return { connected: true, error: "", issues };
}

// The first status of the task's list whose name says it's in progress.
function start(taskId) {
  const task = cli(["tasks", "get", taskId]).data;
  const statuses = cli(["api", "GET", `/v2/list/${task.list.id}`]).data?.statuses ?? [];
  const target = statuses.find((s) => stage(s.status, s.type) === "started");
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
