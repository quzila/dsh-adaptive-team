# DSH Adaptive Team, role board and local dot control

A reference setup for DeepSeek Harness **0.2.0-rc.2** on macOS. It combines the existing [subscription provider](https://github.com/V1ki/dsh-plugin-subscriptions), DSH's official Codex subagent, a small configurable team preset, and a local controller that a connected ChatGPT dot can invoke. It does not expose a network port or add a new account authentication mechanism.

## What it does

- Select the parent and default worker model in **Settings → Agent team**. Choose an automatic worker ceiling or a manual target count. Select a default Codex subtask model and a per-worker subtask limit. The available routes include connected Claude, ChatGPT/Codex, Grok and Antigravity models.
- Let the parent choose the useful number of workers within the ceiling. Native Codex workers can use their own Codex subtasks. For Codex models whose catalog advertises Fast mode, enable it for the default worker or a board card; the native process receives a per-run service-tier override.
- Build an ordered **role board** in the same settings screen. Each card has a role, model, operation and optional Codex Fast toggle. Move cards to change handoff order. The saved board is local runtime state, excluded from Git.
- Ask the DSH chat to create or edit the board: `team_board` reads it and `team_board_edit` saves the complete revised cards. Run it with `team_board({task:"..."})`; each card receives the original task and the previous card's result. Board runs default to read-only. When the human asks for file changes, use `team_board({task:"...",writable:true})`.
- Use the optional `dsh-control` skill to start, inspect, stop, resume and report on **headless sessions started by this controller**. It does not adopt existing desktop GUI sessions.

This is an integration example. DSH already supports delegation; other projects provide teams or remote clients. The combined role board, model routing, native Codex workers and local dot control are presented as one workflow, not as a new agent method.

## Requirements

- macOS, Node.js 22+, and the DSH desktop app at `/Applications/DeepSeek Harness.app` (tested with `0.2.0-rc.2`).
- In the desktop profile, install `dsh-plugin-subscriptions@0.9.9` and `@deepseek-ai/dsh-subagent-codex@0.2.0-rc.2`; connect the providers you want to use in DSH. Grok and Antigravity require their own subscription connections. Consult those projects for their current installation and account terms.
- For the tested GPT-6.1-Sol worker, the desktop profile used `@openai/codex@0.162.1` as a **profile-local** pnpm override. Other versions and models may need different compatibility checks.
- For remote use, connect the Mac to your dot in ChatGPT under **Computers → Your computer**. Local operation depends on that connection; this repository cannot grant it.

## Install on a compatible desktop profile

Clone this repository somewhere private on the Mac. Run `node scripts/install-desktop.mjs` from the checkout. The script checks for the two installed providers, saves a backup of the desktop profile, adds a `link:` dependency for this checkout, and appends the team selection patch. Install the desktop profile dependencies, then restart the desktop app:

```bash
cd "$HOME/.dsh/profiles/desktop"
node '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/pnpm/bin/pnpm.cjs' install --ignore-scripts
```

This command only installs dependencies declared in the desktop profile; inspect the profile backup path printed by the installer if you need to revert. Open **Settings → Agent team** and confirm the model choices.

The session header's **指揮グラフ** button opens a live command map. The graph shows the parent, up to six active or recently completed agents, and their handoff path. Older and interrupted agents move into a paginated history list; shell and other tool jobs stay in a separate collapsed list, so repeated commands do not expand the graph. The canvas fits the available width when the details panel opens, with zoom controls for inspection. Selecting an agent opens a chronological chat view of its instruction, available commentary, tool activity and result. The input below sends a node-specific instruction to the parent session; DSH one-shot jobs cannot be resumed by chatting directly with them. A running DSH job can be stopped with a two-step confirmation. New team worker events and prompts are stored in private local files under `~/.dsh/local-plugins/claude-codex-team/`, so progress remains visible after a host restart. For older DSH jobs, the plugin reads the local parent session transcript to reconnect `worker` prompts and `job_output` results by job ID. This needs a local `zstd` executable. The official one-shot Codex provider does not retain intermediate child events in the parent session, so historical runs without local capture show only the instruction and result. Session content is never included in this repository.

The top section of that dialog is a **planned command graph**. It can be created before any agent runs, including while DSH is in plan mode. Add agents, edit each selected card's role, model and instruction in the right panel, and connect cards from the parent to fan out or join. The saved role board can seed a chain. Each conversation's graph is stored locally under `plan-graphs/`, accepts up to 12 agents and 24 directed connections, and does not start work when saved. In chat, ask the parent to build or revise the command graph; it can inspect and save the complete plan with `team_graph_plan`. The execution section below shows observed jobs separately, so a planned card is never presented as completed work. The plan graph is a visual planning artifact; the parent still needs a separate instruction to execute it.

For headless control, run `node scripts/setup-headless.mjs` once, then install the personal skill from `skills/dsh-control` into `~/.agents/skills/dsh-control` (a symlink is fine). The setup script refuses to overwrite an existing `dots-control` profile. To use the controller directly:

```bash
node skills/dsh-control/scripts/control.mjs start /absolute/workspace /path/to/prompt.txt
node skills/dsh-control/scripts/control.mjs list
node skills/dsh-control/scripts/control.mjs status run-<uuid>
node skills/dsh-control/scripts/control.mjs stop run-<uuid>
node skills/dsh-control/scripts/control.mjs resume run-<uuid> /path/to/continuation.txt
node skills/dsh-control/scripts/control.mjs result run-<uuid>
```

Set the parent default in the desktop UI before starting a new run. Worker defaults, limits and the role board live in local team settings. The controller stores run logs under `~/.dsh/control/runs` with owner-only file permissions. `stop` cancels its managed process tree; it does not undo edits. A resumed task should inspect the workspace before continuing. Runs in the same workspace cannot overlap through this controller.

## Privacy and scope

The repository contains source code and generic setup instructions only. Account tokens, session histories, prompts, run logs, saved role boards, model catalogs, machine profile state and project files are excluded. The plugin reads existing local subscription credentials at runtime to list available models; it does not package those credentials. A public clone does not give anyone access to the author's Mac or the reader's Mac. The connected dot's own authorization determines who can use local computer access.

The controller is for a trusted local user; it is not a multi-user server. Do not publish its private run directory or a project workspace. This preview has been exercised on one Mac, not on a clean second machine. Run `npm test` for the pure logic tests.

## Prior work and attribution

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) provides the plugin architecture, native subagents, and headless mode. The team preset's plan-mode section follows the upstream standard preset; DSH is MIT licensed. [dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions) supplies the account-backed model routes. Comparable work includes [dsh-agent-team-gui](https://github.com/toolclub/dsh-agent-team-gui), [DSH Crew](https://github.com/ZSeven-W/dsh-crew), and [DS Harness Remote](https://github.com/liguobao/ds-harness-remote). This repository does not bundle their code or credentials.
