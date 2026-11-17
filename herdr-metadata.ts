import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { rawRequest, type Request } from "./herdr-api.ts";
import type { HerdrTerminal } from "./terminal.ts";
import type { RunMetadata } from "./shared.ts";

export const METADATA_TTL_MS = 120_000;
export const METADATA_REFRESH_MS = 30_000;
export type MetadataContext = {
	agent: "pi";
	session: { id?: string | null; path?: string | null };
	role: "primary" | "subagent";
	parent_session?: { agent: "pi"; id?: string | null; path?: string | null } | null;
	task_name?: string | null;
	run_id?: string;
};

type Pane = {
	pane_id: string; terminal_id: string; workspace_id?: string; tab_id?: string;
	agent?: string; display_agent?: string; tokens?: Record<string, string>;
	agent_session?: { source: string; agent: string; kind: string; value: string };
};

/** Opaque correlation only, not a server-validated relationship or session alias registry. */
export function metadataSessionKey(session: MetadataContext["session"]): string | undefined {
	const value = session.id ? ["id", session.id] : session.path ? ["path", session.path] : undefined;
	return value ? createHash("sha256").update(JSON.stringify(value)).digest("hex") : undefined;
}

function text(value: string): string {
	return Array.from(value.replace(/\p{Cc}/gu, "").trim()).slice(0, 80).join("");
}

export function metadataFields(context: MetadataContext) {
	const key = metadataSessionKey(context.session);
	if (!key) throw new Error("missing Pi session identity");
	const parent = context.parent_session ? metadataSessionKey(context.parent_session) : undefined;
	const task = text(context.task_name ?? "");
	const prefix = context.role === "primary" ? `pi [${key.slice(0, 8)}]` : `pi subagent${parent ? ` [p:${parent.slice(0, 8)}]` : ""}`;
	return {
		agent: "pi", applies_to_source: "herdr:pi",
		display_agent: text(`${prefix} ${task || (context.role === "primary" ? "principal" : context.run_id ?? "")}`),
		tokens: {
			pi_role: context.role, pi_task: task || null, pi_session_key: key,
			pi_parent_key: parent ?? null, pi_run_id: context.run_id ? text(context.run_id) : null,
		},
		ttl_ms: METADATA_TTL_MS,
	};
}

function matches(pane: Pane | undefined, terminalId: string, context: MetadataContext): boolean {
	const session = pane?.agent_session;
	return pane?.terminal_id === terminalId && pane.agent === "pi"
		&& session?.agent === "pi" && session.source === "herdr:pi"
		&& ((session.kind === "path" && !!context.session.path && session.value === context.session.path)
			|| (session.kind === "id" && !!context.session.id && session.value === context.session.id));
}

function agencyTokens(pane: Pane, panes: Pane[], context: MetadataContext) {
	const cleared = { role: null, agency_self: null, agency_parent: null };
	const child = pane.agent_session?.kind === "path" ? pane.agent_session.value : undefined;
	const parent = context.parent_session?.path;
	if (context.role !== "subagent" || context.parent_session?.agent !== "pi"
		|| !child || !parent || !isAbsolute(child) || !isAbsolute(parent) || child === parent) return cleared;
	const uniquePath = (path: string) => {
		const matches = panes.filter(row => row.agent === "pi" && row.agent_session?.agent === "pi"
			&& row.agent_session.kind === "path" && row.agent_session.value === path);
		return matches.length === 1 && matches[0].agent_session?.source === "herdr:pi";
	};
	if (!uniquePath(child) || !uniquePath(parent)) return cleared;
	// Algorant recomputes this exact tuple; pi_* hashes intentionally keep their own contract.
	const hash = (path: string) => createHash("sha256").update(JSON.stringify(["pi", "path", path])).digest("hex");
	return { role: "subagent", agency_self: hash(child), agency_parent: hash(parent) };
}

/** Official 0.9.5 presentation only. Never claims structural parentage or view ownership. */
export function createMetadataPublisher(request: Request = rawRequest, warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`)) {
	const queues = new Map<string, Promise<void>>();
	const warned = new Set<string>();
	return {
		async publish(target: HerdrTerminal, context: MetadataContext): Promise<boolean> {
			if (!target.terminalId) return false;
			const terminalId = target.terminalId;
			const socket = target.socketPath;
			const key = JSON.stringify([socket, terminalId]);
			let success = false;
			const task = (queues.get(key) ?? Promise.resolve()).then(async () => {
				try {
					const fields = metadataFields(context);
					const listed = await request(socket, "pane.list", {});
					if (!Array.isArray(listed.panes)) throw new Error("invalid pane list");
					const candidates: Pane[] = listed.panes.filter((pane: Pane) => pane.terminal_id === terminalId);
					if (candidates.length !== 1) return;
					const id = candidates[0].pane_id;
					const before: Pane = (await request(socket, "pane.get", { pane_id: id })).pane;
					// No prelaunch reservation: the managed Pi hook must already own this exact session.
					if (!before || before.pane_id !== id || !matches(before, terminalId, context)) return;
					Object.assign(fields.tokens, agencyTokens(before, listed.panes, context));
					await request(socket, "pane.report_metadata", { pane_id: id, source: "pi-subagent", ...fields });
					const after: Pane = (await request(socket, "pane.get", { pane_id: id })).pane;
					if (!after || after.pane_id !== id || !matches(after, terminalId, context)) return;
					if (after.display_agent !== fields.display_agent || Object.entries(fields.tokens).some(([name, value]) => value === null ? after.tokens?.[name] !== undefined : after.tokens?.[name] !== value)) return;
					Object.assign(target, { paneId: id, workspaceId: after.workspace_id ?? target.workspaceId, tabId: after.tab_id ?? target.tabId });
					success = true;
				} catch (error) {
					if (!warned.has(socket)) {
						warned.add(socket);
						warn(`pi-subagent: Herdr presentation metadata unavailable (${socket}): ${String(error)}`);
					}
				}
			});
			queues.set(key, task);
			try { await task; } finally { if (queues.get(key) === task) queues.delete(key); }
			return success;
		},
	};
}

export const metadataPublisher = createMetadataPublisher();
export function childMetadata(run: RunMetadata): MetadataContext {
	return {
		agent: "pi", session: { id: run.childSessionId ?? null, path: run.sessionFile }, role: "subagent",
		parent_session: run.parentSessionId || run.parentSessionFile ? { agent: "pi", id: run.parentSessionId ?? null, path: run.parentSessionFile ?? null } : null,
		task_name: run.name ?? run.handle, run_id: run.handle,
	};
}
