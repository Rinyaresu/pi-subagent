import { mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { herdrCall, type HerdrTerminal } from "./terminal.ts";

const workspaceToken = "pi_subagent_workspace";
const workspaceVersion = "v1";

interface Workspace {
	workspace_id: string;
	active_tab_id?: string;
	tokens?: Record<string, string>;
}

interface CreatedPane {
	pane_id: string;
	terminal_id: string;
}

export async function createHerdrTerminal(
	terminal: HerdrTerminal,
	directory: string,
	label: string,
	placement: "new" | "recorded",
	persist: (terminal: HerdrTerminal) => void,
): Promise<void> {
	const { socketPath } = terminal;
	const options = ["--cwd", directory, "--env", "HERDR_NO_AUTO=1", "--no-focus"];
	const createTab = (destination: HerdrTerminal) => {
		persist({ socketPath, workspaceId: destination.workspaceId, subagentsWorkspaceId: destination.subagentsWorkspaceId, creationPending: true });
		const { tab, root_pane } = herdrCall<{
			tab: { tab_id: string; workspace_id: string }; root_pane: CreatedPane;
		}>(destination, ["tab", "create", "--workspace", destination.workspaceId, "--label", label, ...options]);
		persistCreated(tab?.workspace_id, tab?.tab_id, root_pane, destination.subagentsWorkspaceId);
	};
	const persistCreated = (workspaceId: string, tabId: string | undefined, pane: CreatedPane, subagentsWorkspaceId?: string) => {
		if (!workspaceId || !tabId || !pane?.pane_id || !pane.terminal_id) throw new Error("Invalid Herdr terminal creation response");
		persist({ socketPath, workspaceId, tabId, paneId: pane.pane_id, terminalId: pane.terminal_id, subagentsWorkspaceId });
	};

	if (placement === "recorded" && !terminal.subagentsWorkspaceId) {
		createTab(terminal);
		return;
	}

	const lock = `${realpathSync(socketPath)}.pi-subagent-workspace.lock`;
	const deadline = Date.now() + 12_000;
	while (true) {
		try {
			mkdirSync(lock, { mode: 0o700 });
			break;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
			if (Date.now() >= deadline) throw new Error(`Herdr workspace allocation is locked; inspect the owning server and ${lock}`);
			await delay(50);
		}
	}

	let workspaceCreationUncertain = false;
	try {
		const { workspaces } = herdrCall<{ workspaces: Workspace[] }>(terminal, ["workspace", "list"]);
		const target = placement === "recorded"
			? workspaces.find((workspace) => workspace.workspace_id === terminal.workspaceId &&
				(terminal.workspaceId !== terminal.subagentsWorkspaceId || workspace.tokens?.[workspaceToken] === workspaceVersion))
			: undefined;
		const dedicated = workspaces.filter((workspace) =>
			(placement === "recorded" || workspace.workspace_id !== terminal.workspaceId) &&
			workspace.tokens?.[workspaceToken] === workspaceVersion);
		if (!target && dedicated.length > 1) throw new Error("Multiple dedicated Subagents workspaces on the owning Herdr server");
		const existing = target ?? dedicated[0];
		if (existing) {
			createTab({ socketPath, workspaceId: existing.workspace_id,
				subagentsWorkspaceId: target ? terminal.subagentsWorkspaceId : existing.workspace_id });
			return;
		}

		persist({ socketPath, workspaceId: terminal.workspaceId, subagentsWorkspaceId: terminal.subagentsWorkspaceId, creationPending: true });
		workspaceCreationUncertain = true;
		const { workspace, root_pane } = herdrCall<{ workspace: Workspace; root_pane: CreatedPane }>(
			terminal, ["workspace", "create", "--label", "Subagents", ...options]);
		if (!workspace?.workspace_id) throw new Error("Invalid Herdr workspace creation response");
		herdrCall(terminal, ["workspace", "report-metadata", workspace.workspace_id,
			"--source", "pi-subagent", "--token", `${workspaceToken}=${workspaceVersion}`]);
		workspaceCreationUncertain = false;
		persistCreated(workspace.workspace_id, workspace.active_tab_id, root_pane, workspace.workspace_id);
	} catch (error) {
		if (workspaceCreationUncertain) throw new Error(`Herdr workspace creation uncertain; inspect the owning server and ${lock}`, { cause: error });
		throw error;
	} finally {
		if (!workspaceCreationUncertain) rmdirSync(lock);
	}
}
