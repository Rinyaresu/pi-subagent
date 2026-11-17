# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent has a dedicated Pi JSONL session. Inside Herdr (`HERDR_ENV=1`), new children run in native tabs in the parent's workspace, created without changing focus. Outside Herdr they run in tmux sessions. The parent can inspect status, wait for durable results, steer active work, queue follow-ups, or open the child TUI.

## Requirements

- Pi
- Node.js 22.19 or newer
- Herdr 0.9.5+ for native runs, with `HERDR_SOCKET_PATH` and `HERDR_WORKSPACE_ID`
- tmux for runs outside Herdr and existing tmux children

## Install

Install this fork at a reviewed commit with Pi's package manager:

```sh
pi install git:github.com/Rinyaresu/pi-subagent@<reviewed-commit>
```

Replace `<reviewed-commit>` with the full commit from your machine configuration.
Do not install a second copy in `extensions/`. Preserve dirty package checkouts
before updating them. Reload existing Pi sessions only when idle. The extension
contributes its bundled skill automatically.

## Usage

Spawn with a descriptive name using the parent session's provider, model, and thinking level:

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

Names appear in the parent UI. Generated handles remain the stable identifiers used by management commands.

The parent session's Scoped Models are the allowlist for spawning and resuming children. The extension supplies the resolved list automatically through the environment and the system prompt; no settings-file lookup is needed. Unlisted provider/model pairs are rejected, including inherited models. Empty scopes block spawning: select models with `/scoped-models` first. After installing this change, run `/reload` in existing parent sessions. Provider and authorization policies remain additional constraints.

Children receive the same scope through `--models`. Suspended children whose models are no longer listed are not relaunched. Pinned thinking levels apply unless `--thinking` explicitly overrides them.

Override the model configuration with a pair from your scope when needed:

```sh
subagent spawn \
  --provider openai-codex \
  --model gpt-5.4-mini \
  --thinking low \
  --prompt "Find the relevant implementation"
```

Provide multiple prompt fragments and files:

```sh
subagent spawn \
  --file /tmp/spec.md \
  --prompt "Implement this specification" \
  --prompt "Run the targeted tests"
```

Restrict tools for a read-only investigation:

```sh
subagent spawn --tools read,grep,find,ls --prompt "Investigate the failure"
```

Manage a run by its generated handle:

```sh
subagent status a1b2c3
subagent rename a1b2c3 "error handling review"
subagent send a1b2c3 "Focus on error handling"
subagent send a1b2c3 --follow-up "Then summarize"
subagent wait a1b2c3
subagent stop a1b2c3
subagent list
```

Use `/subagent` to select an active child. For a Herdr child, it focuses the native pane without stopping the parent TUI or nesting tmux. Return through Herdr's tab navigation. Tmux children keep the existing attach/switch-client behavior. The status widget shows active names (or handles for unnamed runs) and their current state.

Existing metadata without a backend remains tmux-backed. Updating does not migrate live processes; run `/reload` before using the updated command. Native runs retain their original socket/workspace on resume, so keep that server and workspace available. Unreachable servers retain run metadata rather than discarding transcripts. Stopping closes only the child's owned pane, preserving any other panes added to its tab. Terminal identity follows pane moves and protects against reused pane IDs. If tab creation loses its response, a write-ahead recovery record is retained and automatic retries are blocked: inspect the original server and metadata before reconciling it.

The child shell initializes its own environment in the requested cwd. The launcher explicitly forwards the parent's model scope and `PI_CODING_AGENT_DIR`, not arbitrary parent environment variables or credentials.

## Herdr TreeView metadata

On Herdr 0.9.5, the extension publishes display-only `pi_*` metadata after proving
terminal and native Pi session ownership. It renews metadata every 30 seconds
with a 120-second TTL. Shutdown stops renewal and awaits in-flight publication;
it does not synchronously remove the last report.

For subagents with unique, distinct absolute native child and parent paths, the
same report adds `role=subagent`, `agency_self`, and `agency_parent`. The aliases
use SHA-256 of compact JSON `["pi","path",path]`, matching
Algorant/herdr-agent-tree at `c14c3ee4fa9fa709b4e6e984fc53f47cd9bc2a28`.
The existing `pi_*` hashes keep their independent ID-or-path contract. Missing,
relative, ID-only, or ambiguous path references clear the aliases without
inventing an edge. The extension never publishes `agency_lead`.

The extension does not install the plugin, change the Agents view, or configure
its rows. Those belong to machine configuration. Herdr metadata writes are not
atomic with identity checks. A replacement Pi using the same path cannot be
distinguished by the plugin's path-based identity contract. Do not share these
alias keys with another publisher.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery while retaining the control bridge
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are suspended: the process stops, but transcript and metadata are kept. Resuming that parent session relaunches them idle with their full history. `subagent stop` removes a run permanently.

## Tests

`npm test` covers backend selection, model scope, literal launcher arguments, durable messaging/results, cleanup, legacy metadata, `/subagent` focus and parent lifecycle events.

Opt-in runtime smoke test with an isolated named Herdr server and a real idle Pi (no model request):

```sh
PI_SUBAGENT_HERDR_LIVE=1 node --test herdr-live.test.ts
```

Test artifacts live under `~/.local/state/pi/work-artifacts/pi-subagent/`. The smoke test stops only its isolated server, never the user's active Herdr session.
