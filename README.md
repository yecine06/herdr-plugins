# Command Center for Herdr

A [Herdr](https://herdr.dev) app layout for running many coding agents at once, built on Herdr's own `main`: the same
spaces and agents sidebar, plus an **Inbox** of what needs you (blocked or finished agents, Slack asks, failed CI,
review requests), your **Linear** issues linked to the agents working on them, a **Tasks** summary per issue, a
**Board** of all work, a **standup** draft, and Claude Code and Codex **usage** bars.

![Command Center: terminals with the Inbox](preview.png)

![The Board, with the Tasks panel](docs/board.png)

Needs macOS (the Keychain, `pbcopy`), the Herdr app, Node, `gh` signed in, and Claude Code. Linear and Slack are
read through the claude.ai connectors, so connect those in claude.ai if you want them.

Both screenshots are made by `node scripts/preview.mjs` from made-up data (`scripts/preview/demo.json`) in a
separate Herdr window with its own home folder and herdr-core, so it never touches your spaces or logins.

> **Fork (branch `clickup`)**: the Linear source is replaced by ClickUp, read through `clickup-cli`
> (`mods/cc-status/clickup.mjs`) instead of a headless Claude run, so it is free. Tasks assigned to you are mapped onto
> the panel stages by status name (`STAGES` in that file). Internal names (`cc.linear`, `cc-linear`, `settings.linear`)
> are kept to stay close to upstream. The standup draft still asks Linear.

## Install

```sh
node install.mjs            # copy layouts/ and mods/cc-* into ~/.config/herdr-app, then check each mod
node install.mjs --switch   # and switch the window to it (⌘⇧L cycles back)
node install.mjs --hooks    # also set up task notes (see below)
node install.mjs --uninstall
```

Edit here, then run `node install.mjs` again: Herdr reloads the mods in place. The installer only replaces folders
it installed itself (marked `.cc-managed`), and binds ⌘⌥1 and ⌘⌥2 (Terminals, Board) and ⌘⌥I, ⌘⌥L, ⌘⌥T (Inbox,
Linear, Tasks) in `keys.json`, leaving any key you already use.

## Settings

`~/.config/herdr-app/command-center.json`, edited from **Settings** in the status bar or by hand (read again each
minute). The installer writes it only when it's missing. New installs start with the paid Claude runs off:

| | Default | Cost |
|---|---|---|
| GitHub | on, every 3 min, review requests asked of you | free (`gh`) |
| Linear | on, every 15 min, 07–22, Haiku | about 1¢ a run |
| Slack sweep | **off**; when on, hourly, 09–19, Sonnet | 30–45¢ a run on Sonnet |
| Standup draft | **off**; when on, 23:00 on weekdays, Sonnet | about 25¢ a run |
| Repo folders | the folders of the repos open in Herdr | |
| Usage bars | Claude Code and Codex | free |

The dialog shows what a day costs at the settings you pick. When the Linear or Slack connector isn't signed in, its
panel says how to connect it (with **Check again** and **I don't use …**) and the scheduled runs wait instead of
paying to fail; a free check of Claude Code's own "needs sign-in" list catches most of these first.

## What's in it

| Mod | Where | What it does |
|---|---|---|
| `cc-tabs` | tab bar | Herdr's tab bar, with a Terminals | Board toggle (⌘⌥1, ⌘⌥2) and Inbox · Linear · Tasks · Files · Changes buttons (⌘⌥I, ⌘⌥L, ⌘⌥T), the Inbox count and each tab's Linear issue |
| `cc-board` | center (stack with the terminals) | One card per piece of work (agent, Linear issue and PR joined by branch) in Needs you, In progress, In review, Waiting and Todo; filters by the Start dialog's folders; click selects the tab and shows Tasks, Open goes to the terminal, plus Fix CI, PR, a start button that follows the task's status (Start, Analyse, Review, QA or MEP; none while waiting on someone) and Linear |
| `cc-inbox` | side panel | Blocked agents with their prompt, finished agents, Slack asks, failed CI on your branches' PRs (Fix CI starts Claude with `/fix-ci`), PRs that request your review directly; the standup draft at its foot |
| `cc-linear` | side panel | Your open Linear issues by state, each linked to the space and tab on its branch, with agent status and PR checks; Start on unlinked ones |
| `cc-start` | dialog | Start from issue: `/dev-workflow <ID>` run by Claude in the picked folder, a Herdr worktree on the issue's branch name, or a plain tab; repos found four levels under the configured folders, plus folders holding several repos; Claude in plan, auto or ask-first mode, the issue as its first message, and optionally move the issue to In Progress. Analysis, review, QA and release steps open a tab with a prompt for that step and leave the status alone |
| `cc-tasks` | side panel | For each tab of the shown space: goal, plan, decisions, assumptions, what's not done (from `.agents/tasks/`), plus changed files, commits and PR checks from git; a red box when the agent is waiting on you |
| `cc-handoff` | dialog | Hand a Slack ask to an agent: a new one (plan mode) or a free one in this space, optionally searching Slack first; the message is editable |
| `cc-standup` | pane | The standup draft as bullets: click to edit, × to drop, press-and-release on another bullet to move it there, ✦ or the box below to have Claude change one bullet or the whole draft; Undo (10 steps), Write now, Copy. Opened from the Inbox footer |
| `cc-usage` | sidebar foot | Claude Code and Codex plan usage: a bar per limit window with its reset time; amber from 70%, red from 90%; click to refresh |
| `cc-status` | status bar | Status bar, and the only fetcher: writes `cc.github`, `cc.snippets`, `cc.linear` and `cc.slack` to shared state |

What it runs: `git rev-parse` once per folder, `gh pr view` for each local space's feature branch every 3 minutes,
`gh search prs user-review-requested:@me` every 5, and `hc read` once when an agent becomes blocked. Remote spaces
and `main`/`master` branches are skipped. Click the GitHub time in the status bar to check now.

Linear is read through the claude.ai Linear connector: a headless `claude -p` (read-only tools, $0.50 cap) on the
schedule in settings, or when you click refresh. Moving an issue to In
Progress is a second run with Linear's update tools, only when you tick it in Start from issue. The runs work in
`~/.config/herdr-app/data/cc-claude` and keep no session.

Slack: a headless sweep of your DMs and @-mentions since the last sweep, on the schedule in settings, or Check now
in the Inbox. Read-only Slack tools only; it never posts. It also marks earlier
asks resolved once you've replied. Done means handled; Skip means set aside; FYIs get Seen. State is
`~/.config/herdr-app/data/cc-slack/state.json`; Done, Skip, Seen, Undo and Clear in
the Inbox go through cc-status, which owns that file. Urgent or dated new asks become toasts. Hand to agent opens
Claude in plan mode in the shown space to research the answer across Slack, Linear and the code, and draft a reply.

Standup: the Inbox footer holds a draft answer to "What did you accomplish?" for the previous working day (Friday on
Monday), or for today from 18:00. Your commits in every repo under the Start dialog's folders, your PRs (`gh`), the
day's task summaries and the Slack asks you closed (marked Done, or replied to; never skipped ones, kept two weeks even
after Clear) are gathered locally; one Sonnet run (about $0.25) adds Linear and your own Slack messages and
writes it. It runs at the times in settings (before the "new day from" hour it writes the previous working day, after it
today), catches up a missed time within 12 hours if Herdr was closed or asleep, and runs on demand from Write now in the Inbox footer or `herdr-app do cc-status.standup`. Once you edit a day's draft, the
schedule leaves it alone; Write now still replaces it (Undo brings yours back). Asking Claude to change it is one
Sonnet run with no tools, a few cents.

Usage: Claude Code's numbers come from the usage endpoint `/usage` uses, with Claude Code's login read from the macOS
Keychain (read only, never refreshed or stored), every 3 minutes, backing off to 15 after failures. Codex's come from
the newest session log under `~/.codex/sessions`, so they update when Codex runs.

## Task notes

`mods/cc-tasks/cc-task.mjs` decides where a task's notes live: `<repo>/.agents/tasks/<ISSUE>.md` when the branch belongs
to a Linear issue, else `<repo>/.agents/tasks/<space>.md` with a `## <tab>` section. It adds `.agents/tasks/` to the
repo's `.git/info/exclude`. `node install.mjs --hooks` sets up the two pieces that use it (backing up both files
first; adding twice changes nothing; `--uninstall` takes them out):

- `~/.claude/CLAUDE.md`: agents in Herdr terminals run `cc-task.mjs path` and keep that file current.
- `~/.claude/settings.json` Stop hook `cc-task.mjs hook`: after a turn that edited files, in a Herdr terminal only,
  starts a background Haiku run (about 1–2¢) that rewrites `.agents/tasks/.summary/<key>.json`. It returns at once.


## Credits

Ideas and approaches from [Bettr](https://github.com/dissimulate/bettr) (usage bars read from Claude Code's usage
endpoint and Codex's session logs, and the separate-window preview script) and from slack-panel in
[sachin-philip/wizardry](https://github.com/sachin-philip/wizardry) (a headless Claude sweep for Slack asks and a
standup draft). The code here is new.

## Licence

MIT, see [LICENSE](LICENSE).
