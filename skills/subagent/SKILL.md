---
name: subagent
description: Spawn and communicate with observable Pi subagents for second opinions, independent investigations, and delegated implementation work.
---

# Subagent

Use the `subagent` CLI to delegate work to a separate Pi process with its own context. Inside Herdr (`HERDR_ENV=1`), each new child gets an unfocused native tab in the parent's workspace. Outside Herdr, children use tmux sessions. Existing runs retain their recorded backend. Managed subagents cannot spawn nested subagents, and this skill is not loaded into their sessions.

## Spawn

Give each child a short, descriptive name. The name appears in the parent UI, while the generated handle remains its stable identifier:

```sh
subagent spawn --name implementation --prompt "Complete task"
```

Choose a provider/model pair from the parent session's Scoped Models, supplied automatically in the system prompt. The CLI rejects unlisted models and blocks spawning when the scope is empty or unavailable. Existing provider and authorization restrictions still apply; if no listed model is eligible, report the blocker instead of changing the scope or selecting an unlisted fallback.

Without overrides, the child inherits the current provider, model, and reasoning level; a thinking level pinned in Scoped Models takes precedence over inherited reasoning. Use `--provider`, `--model`, or `--thinking` to deliberately choose another eligible configuration. Never pass `$PI_PROVIDER`, `$PI_MODEL`, or `$PI_REASONING_LEVEL` back to the CLI explicitly.

`--cwd` defaults to the current directory. Repeat `--prompt` and `--file` as needed; Pi receives all of them in the first user turn. Run `subagent spawn` directly without piping or redirecting its concise output.

## Tools

Without `--tools`, Pi enables its four default tools:

- `read` - Read text files and images.
- `bash` - Execute shell commands. This can also modify files, so it is not a read-only capability.
- `edit` - Apply exact text replacements to existing files.
- `write` - Create or overwrite files.

Three additional built-in tools are available but off by default:

- `grep` - Search file contents.
- `find` - Find files by glob pattern.
- `ls` - List directory contents.

`--tools` is a comma-separated allowlist across built-in, extension, and custom tools. Common choices:

```sh
# Enforced read-only repository investigation
--tools read,grep,find,ls

# Investigation that may run tests or other commands; bash can modify files
--tools read,bash,grep,find,ls

# Implementation work: omit --tools to use the defaults
```

## Isolation flags

- `--no-extensions` - Disable normal extension discovery. Use for an independent run that should not inherit unrelated extension behavior or extension-provided tools. The subagent control bridge is still explicitly loaded.
- `--no-skills` - Hide installed skills from the child. Use for tightly specified tasks that should rely only on the supplied prompt and files.
- `--no-prompt-templates` - Disable prompt-template commands. Usually unnecessary, but useful when testing a minimal child environment.
- `--no-context-files` - Ignore repository instruction files such as `AGENTS.md` and `CLAUDE.md`. Use only when those instructions would bias an independent investigation. Do not use for implementation unless intentionally bypassing repository guidance.

Spawn prints a random handle and the exact focus/attach command for its backend. Keep the handle for later commands. Subagents persist after their current turn completes: `wait`, completion, and becoming idle do not terminate them. They survive `/reload`. When the spawning Pi session quits or is replaced, they are suspended and relaunched idle with their history when that session is resumed. They are only removed by `subagent stop`.

## Inspect and wait

```sh
subagent status <handle>
subagent list
subagent wait <handle>
```

Run `subagent list` at any time to rediscover active subagents and their handles, names, and current states if you no longer remember them.

`wait` follows the durable session state and prints the latest final assistant response. Run it directly so the bash tool returns that response; do not redirect it to a file or pipe it unless the user explicitly asks for an artifact. Do not infer completion from captured terminal text. Set the bash timeout above `wait`'s default 1800-second deadline.

## Communicate

```sh
# Change the name shown in the parent UI.
subagent rename <handle> "new name"

# Idle: starts a new prompt. Busy: steers the current work.
subagent send <handle> "message"

# Busy: waits until current work finishes, then starts another turn.
subagent send <handle> --follow-up "message"
```

Names are 1–64 characters and need not be unique. Messages use the subagent extension's control inbox; do not use `tmux send-keys`.

## Stop

```sh
subagent stop <handle>
```

Explicitly stop every subagent when it is no longer needed; do not leave completed subagents running idle. This closes the child's owned Herdr pane or tmux session and removes the run transcript and metadata. Other panes added to the Herdr tab are preserved. If the owning Herdr server is unavailable, stopping fails and retains the run for recovery. Keep an idle subagent alive only when concrete follow-up work is expected, then stop it afterward.

The interactive `/subagent` command lists active subagents spawned by the current Pi session. Selecting a native Herdr child focuses its pane without suspending the parent TUI or attaching tmux. Return to the parent using Herdr's tab navigation. For tmux children, selection suspends the parent TUI and attaches to the child's session; detaching returns to the parent. When the parent already runs inside tmux, selection switches the current tmux client instead.

Herdr runs are pinned to their original socket and workspace, including when resuming a suspended parent. Keep that server/workspace available. A connection failure is not treated as proof that the child exited, and does not discard its transcript. An uncertain tab creation retains a recovery record and blocks automatic relaunch; inspect the original server and run metadata before reconciling it. The child shell initializes its own environment; only model scope and `PI_CODING_AGENT_DIR` are explicitly forwarded from the parent. Run `/reload` after updating this extension; already-running tmux children are not migrated.
