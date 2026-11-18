import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { createHerdrTerminal } from "./herdr-workspace.ts";
import { readModelScope, requireScopedModel } from "./model-scope.ts";
import { herdrCall, shellCommand, stopTerminal, terminalIsRunning, type HerdrTerminal } from "./terminal.ts";

export type RunState = "starting" | "busy" | "idle" | "exited" | "error";

export interface RunMetadata {
	version: 1;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	/** Absent in older metadata: those runs keep using tmux. */
	backend?: "tmux" | "herdr";
	herdr?: HerdrTerminal;
	tmuxSession: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	state: RunState;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		if (
			metadata.version !== 1 ||
			typeof metadata.handle !== "string" ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			(metadata.backend !== undefined && metadata.backend !== "tmux" && metadata.backend !== "herdr") ||
			(metadata.backend === "herdr" && (!metadata.herdr ||
				typeof metadata.herdr.socketPath !== "string" || typeof metadata.herdr.workspaceId !== "string" ||
				(metadata.herdr.tabId !== undefined && typeof metadata.herdr.tabId !== "string") ||
				(metadata.herdr.paneId !== undefined && typeof metadata.herdr.paneId !== "string") ||
				(metadata.herdr.terminalId !== undefined && typeof metadata.herdr.terminalId !== "string") ||
				(metadata.herdr.creationPending !== undefined && typeof metadata.herdr.creationPending !== "boolean") ||
				(metadata.herdr.subagentsWorkspaceId !== undefined && typeof metadata.herdr.subagentsWorkspaceId !== "string"))) ||
			typeof metadata.tmuxSession !== "string" ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		return metadata as RunMetadata;
	} catch {
		return undefined;
	}
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	const current = readMetadata(runDir);
	if (!current) return undefined;
	const next: RunMetadata = {
		...current,
		...patch,
		version: 1,
		handle: current.handle,
		runDir: current.runDir,
		updatedAt: new Date().toISOString(),
	};
	writeMetadata(next);
	return next;
}

export async function waitForRunShutdown(runDir: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const metadata = readMetadata(runDir);
		if (!metadata || metadata.state === "exited") return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/** Start the child Pi in its recorded backend. `initialArgs` are only passed on first spawn. */
export async function launchRun(metadata: RunMetadata, initialArgs: string[] = [], placement: "new" | "recorded" = "recorded"): Promise<void> {
	requireScopedModel(metadata.provider, metadata.model);
	const modelPatterns = readModelScope().map((model) =>
		`${model.provider}/${model.id}${model.thinkingLevel ? `:${model.thinkingLevel}` : ""}`,
	).join(",");
	let launcher = "pi";
	const testLauncher = join(metadata.cwd, "pi-test.sh");
	try {
		accessSync(testLauncher, constants.X_OK);
		launcher = testLauncher;
	} catch {
		// Use the installed pi executable.
	}

	const argv = [
		"env",
		`PI_SUBAGENT_RUN_DIR=${metadata.runDir}`,
		launcher,
		"--session", metadata.sessionFile,
		"--provider", metadata.provider,
		"--model", metadata.model,
		"--thinking", metadata.thinking,
		"--models", modelPatterns,
		...(metadata.launchArgs ?? []),
		...initialArgs,
	];
	if (metadata.backend === "herdr") {
		if (!metadata.herdr) throw new Error("Missing Herdr terminal context");
		// Submit a short launcher path instead of pasting prompts into a shell command line.
		// Explicit scope propagation avoids the server shell inheriting an unrelated parent's scope.
		const launcherPath = join(metadata.runDir, "launch.sh");
		writeFileSync(launcherPath, `#!/bin/sh\nexec ${shellCommand([
			argv[0], `PI_SUBAGENT_SCOPED_MODELS=${JSON.stringify(readModelScope())}`,
			`PI_CODING_AGENT_DIR=${getAgentDir()}`, ...argv.slice(1),
		])}\n`, { mode: 0o700 });
		await createHerdrTerminal(metadata.herdr, metadata.cwd, `subagent ${metadata.name ?? metadata.handle}`, placement, (terminal) => {
			metadata.herdr = terminal;
			if (!updateMetadata(metadata.runDir, { herdr: terminal })) throw new Error("Run metadata disappeared during launch");
		});
		try {
			herdrCall(metadata.herdr, ["pane", "run", metadata.herdr.paneId!, `exec /bin/sh ${shellCommand([launcherPath])}`]);
		} catch (error) {
			stopTerminal(metadata);
			throw error;
		}
		return;
	}
	const result = spawnSync("tmux", [
		"new-session", "-d", "-s", metadata.tmuxSession,
		"-x", "120", "-y", "40", "-c", metadata.cwd, "--", ...argv,
	], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr.trim() || "Failed to create tmux session");
}

export function effectiveRunState(metadata: RunMetadata): RunState {
	if (metadata.state === "starting" || metadata.state === "busy" || metadata.state === "idle") {
		try {
			if (!terminalIsRunning(metadata)) return "exited";
		} catch {
			// An unreachable server is not proof the child exited. Keep its transcript/identity.
			return "error";
		}
	}
	return metadata.state;
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries).findLast(isAssistantEntry)?.message;
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}
