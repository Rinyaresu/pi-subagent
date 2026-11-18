import { spawnSync } from "node:child_process";
import type { RunMetadata } from "./shared.ts";

export interface HerdrTerminal {
	socketPath: string;
	workspaceId: string;
	tabId?: string;
	paneId?: string;
	/** Random terminal identity survives pane moves and prevents ID reuse from targeting another terminal. */
	terminalId?: string;
	creationPending?: boolean;
	subagentsWorkspaceId?: string;
}

/** Pin every operation to the server that owns the run, not the currently focused session. */
export function herdrCall<T>(terminal: HerdrTerminal, args: string[]): T {
	const result = spawnSync("herdr", args, {
		encoding: "utf8",
		timeout: 10_000,
		env: {
			...process.env,
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: terminal.socketPath,
			HERDR_WORKSPACE_ID: terminal.workspaceId,
			HERDR_TAB_ID: terminal.tabId ?? "",
			HERDR_PANE_ID: terminal.paneId ?? "",
		},
	});
	if (result.error) throw new Error(`Herdr: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`Herdr: ${result.stderr.trim() || `command exited ${result.status}`}`);
	// Some successful CLI mutations (notably pane run/close) have no stdout.
	if (!result.stdout.trim()) return {} as T;
	const response = JSON.parse(result.stdout);
	if (response.error || !response.result) throw new Error(`Invalid Herdr response: ${result.stdout.trim()}`);
	return response.result as T;
}

export function currentHerdrTerminal(): HerdrTerminal | undefined {
	if (process.env.HERDR_ENV !== "1") return undefined;
	const socketPath = process.env.HERDR_SOCKET_PATH;
	const workspaceId = process.env.HERDR_WORKSPACE_ID;
	if (!socketPath || !workspaceId) throw new Error("Herdr requires HERDR_SOCKET_PATH and HERDR_WORKSPACE_ID");
	return { socketPath, workspaceId };
}

export function terminalIsRunning(metadata: RunMetadata): boolean {
	if (metadata.backend === "herdr") {
		if (metadata.herdr?.creationPending) throw new Error(`Herdr terminal creation uncertain for ${metadata.handle}; inspect the owning server before retrying`);
		if (!metadata.herdr?.paneId) return false;
		if (!metadata.herdr.terminalId) throw new Error(`Missing Herdr terminal identity for ${metadata.handle}`);
		const { panes } = herdrCall<{
			panes: { pane_id: string; tab_id: string; workspace_id: string; terminal_id: string }[];
		}>(metadata.herdr, ["pane", "list"]);
		const owned = panes.find((pane) => pane.terminal_id === metadata.herdr!.terminalId);
		if (!owned) return false;
		// Pane IDs change when moved between workspaces; terminal identity remains stable.
		Object.assign(metadata.herdr, { paneId: owned.pane_id, tabId: owned.tab_id, workspaceId: owned.workspace_id });
		return true;
	}
	return spawnSync("tmux", ["has-session", "-t", metadata.tmuxSession], { stdio: "ignore" }).status === 0;
}

export function stopTerminal(metadata: RunMetadata): void {
	if (metadata.backend === "herdr") {
		if (metadata.herdr?.creationPending) terminalIsRunning(metadata); // Fail closed, retaining the recovery record.
		if (metadata.herdr?.paneId && terminalIsRunning(metadata)) {
			// Close only the pane we created: users may have added other panes to its tab.
			herdrCall(metadata.herdr, ["pane", "close", metadata.herdr.paneId]);
		}
		return;
	}
	const result = spawnSync("tmux", ["kill-session", "-t", metadata.tmuxSession], { encoding: "utf8" });
	if (result.status !== 0 && terminalIsRunning(metadata)) {
		throw new Error(result.stderr.trim() || "Could not stop tmux subagent");
	}
}

export function focusHerdrTerminal(metadata: RunMetadata): void {
	if (!metadata.herdr?.tabId || !terminalIsRunning(metadata)) throw new Error(`${metadata.handle} is not running`);
	// A tab initially has one pane; focus that exact pane even if the user later splits it.
	herdrCall(metadata.herdr, ["agent", "focus", metadata.herdr.paneId!]);
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function attachCommand(metadata: RunMetadata): string {
	if (metadata.backend === "herdr" && !metadata.herdr?.paneId) {
		return "Herdr terminal identity unavailable; inspect the owning server before retrying";
	}
	if (metadata.backend === "herdr" && metadata.herdr?.paneId) {
		return `HERDR_ENV=1 HERDR_SOCKET_PATH=${quote(metadata.herdr.socketPath)} HERDR_WORKSPACE_ID=${quote(metadata.herdr.workspaceId)} HERDR_TAB_ID=${quote(metadata.herdr.tabId ?? "")} HERDR_PANE_ID=${quote(metadata.herdr.paneId)} herdr agent focus ${quote(metadata.herdr.paneId)}`;
	}
	return `tmux attach -t ${metadata.tmuxSession}`;
}

export function shellCommand(argv: string[]): string {
	return argv.map(quote).join(" ");
}
