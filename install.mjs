#!/usr/bin/env node
// Copies the Command Center layout and its cc-* mods into the Herdr app's folder.
//   node install.mjs              install or update, then check each mod
//   node install.mjs --switch     also switch the window to the layout
//   node install.mjs --hooks      also set up task notes: a rule in ~/.claude/CLAUDE.md and a Stop hook
//                                 in ~/.claude/settings.json (both backed up first)
//   node install.mjs --uninstall  remove the layout, the mods, the key bindings and anything --hooks added

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "./mods/cc-status/settings.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const LAYOUT = "command-center";
const MARKER = ".cc-managed";
const SETTINGS = join(app, "command-center.json");
const KEYS = { "cmd-alt-i": "cc-tabs.inbox", "cmd-alt-l": "cc-tabs.linear", "cmd-alt-t": "cc-tabs.tasks", "cmd-alt-1": "cc-tabs.terminals", "cmd-alt-2": "cc-tabs.board",
  "cmd-shift-a": "cc-tabs.asks", "alt-0": "cc-agents.show", "alt-1": "cc-agents.n1", "alt-2": "cc-agents.n2", "alt-3": "cc-agents.n3", "alt-4": "cc-agents.n4", "alt-5": "cc-agents.n5", "alt-6": "cc-agents.n6", "alt-7": "cc-agents.n7", "alt-8": "cc-agents.n8", "alt-9": "cc-agents.n9",
  "ctrl-shift-o": "mod.open:cc-hints" };
const HOOK = "node ~/.config/herdr-app/mods/cc-tasks/cc-task.mjs hook";
const RULE_HEADING = "## Task notes (Herdr)";
const RULE = `${RULE_HEADING}
- In a Herdr terminal (\`HC_TERMINAL_ID\` set), when changing code in a git repo, run \`node ~/.config/herdr-app/mods/cc-tasks/cc-task.mjs path\` once and keep that notes file (and section) current: goal, plan files, decisions, assumptions to check, what's not done. Short bullets; edit, don't append duplicates.
`;
const args = new Set(process.argv.slice(2));

const mods = readdirSync(join(here, "mods")).filter((m) => m.startsWith("cc-"));
const herdr = (...a) => execFileSync("herdr-app", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const backup = (file) => { if (existsSync(file)) copyFileSync(file, `${file}.before-command-center`); };

function editKeys(add) {
  const file = join(app, "keys.json");
  const keys = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  keys.global ??= {};
  for (const [key, action] of Object.entries(KEYS)) {
    if (add) {
      if (keys.global[key] && keys.global[key] !== action) console.log(`  key ${key} is already bound to ${keys.global[key]}; left it`);
      else keys.global[key] = action;
    } else if (keys.global[key] === action) delete keys.global[key];
  }
  writeFileSync(file, JSON.stringify(keys, null, 2) + "\n");
}

// The CLAUDE.md rule and the Stop hook that feed the Tasks panel. Adding twice changes nothing.
function editHooks(add) {
  const md = join(claudeDir, "CLAUDE.md");
  const text = existsSync(md) ? readFileSync(md, "utf8") : "";
  const has = text.includes(RULE_HEADING);
  if (add && !has) { backup(md); writeFileSync(md, `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n${RULE}`); console.log(`  added the task-notes rule to ${md}`); }
  if (!add && has) {
    backup(md);
    const heading = RULE_HEADING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    writeFileSync(md, text.replace(new RegExp(`\\n?${heading}\\n(?:- .*\\n?)*`), "\n").replace(/\n{2,}$/, "\n"));
    console.log(`  removed the task-notes rule from ${md}`);
  }
  const file = join(claudeDir, "settings.json");
  const s = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const stop = s.hooks?.Stop ?? [];
  const present = JSON.stringify(stop).includes(HOOK);
  if (add && !present) {
    backup(file);
    s.hooks = { ...(s.hooks ?? {}), Stop: [...stop, { hooks: [{ type: "command", command: HOOK, timeout: 10 }] }] };
    writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
    console.log(`  added the task-summary Stop hook to ${file}`);
  }
  if (!add && present) {
    backup(file);
    s.hooks.Stop = stop.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => h.command !== HOOK) })).filter((g) => g.hooks.length);
    if (!s.hooks.Stop.length) delete s.hooks.Stop;
    writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
    console.log(`  removed the task-summary Stop hook from ${file}`);
  }
}

if (args.has("--uninstall")) {
  for (const f of [`${LAYOUT}.json`, `${LAYOUT}.svg`]) rmSync(join(app, "layouts", f), { force: true });
  for (const m of mods) if (existsSync(join(app, "mods", m, MARKER))) rmSync(join(app, "mods", m), { recursive: true });
  editKeys(false);
  editHooks(false);
  console.log(`Removed. Kept your settings (${SETTINGS}) and data (${join(app, "data")}); delete them by hand if you like.`);
  process.exit(0);
}

mkdirSync(join(app, "layouts"), { recursive: true });
for (const f of [`${LAYOUT}.json`, `${LAYOUT}.svg`]) cpSync(join(here, "layouts", f), join(app, "layouts", f));

// New settings start with the paid sweeps off; an existing file is never touched.
if (!existsSync(SETTINGS)) { writeFileSync(SETTINGS, JSON.stringify(DEFAULTS, null, 2) + "\n"); console.log(`  wrote default settings to ${SETTINGS}`); }

let failed = false;
for (const m of mods) {
  const target = join(app, "mods", m);
  if (existsSync(target) && !existsSync(join(target, MARKER))) {
    console.log(`  ${m}: a folder of that name exists and isn't ours; skipped`);
    failed = true;
    continue;
  }
  rmSync(target, { recursive: true, force: true });
  cpSync(join(here, "mods", m), target, { recursive: true });
  writeFileSync(join(target, MARKER), "Installed from herdr-plugins; replaced on every install.\n");
}
editKeys(true);
if (args.has("--hooks")) editHooks(true);

for (const m of mods) {
  try {
    herdr("check", join(app, "mods", m));
    console.log(`  ${m}: ok`);
  } catch (e) {
    failed = true;
    console.log(`  ${m}: FAILED\n${(e.stderr || e.stdout || e.message).trim()}`);
  }
}

if (args.has("--switch") && !failed) herdr("do", "layout.switch", JSON.stringify({ name: LAYOUT }));
process.exit(failed ? 1 : 0);
