import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, type TUI } from "@earendil-works/pi-tui";
import {
	effectiveRunState,
	inboxDir,
	launchRun,
	listRuns,
	readMetadata,
	removeRunDir,
	runDisplayName,
	type InboxMessage,
	type RunMetadata,
	updateMetadata,
	waitForRunShutdown,
} from "./shared.ts";

import { MODEL_SCOPE_ENV, modelScopePrompt, type ScopedModel } from "./model-scope.ts";
import { currentHerdrTerminal, focusHerdrTerminal, herdrCall, stopTerminal, terminalIsRunning, type HerdrTerminal } from "./terminal.ts";
import { childMetadata, metadataPublisher, METADATA_REFRESH_MS as metadataRefreshMs } from "./herdr-metadata.ts";
import { primaryIdentity } from "./primary-identity.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));
// This non-inherited process property survives reloads only inside the same live Pi process.
// It is populated only after process/TTY ownership has been verified.
const primaryTerminalKey = Symbol.for("pi-subagent.primary-terminal.v1");
type PrimaryRuntime = typeof process & { [primaryTerminalKey]?: { socketPath: string; terminalId: string } };
const primaryIdentityWarned = new Set<string>();

function isInboxMessage(value: unknown): value is InboxMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return typeof message.message === "string" && (message.delivery === "auto" || message.delivery === "followUp");
}

function displayState(metadata: RunMetadata): string {
	return effectiveRunState(metadata).padEnd(8);
}

export default function subagentExtension(pi: ExtensionAPI) {
	const runDir = process.env.PI_SUBAGENT_RUN_DIR;
	if (!runDir) {
		const syncModelScope = (ctx: ExtensionContext): ScopedModel[] => {
			const id = ctx.sessionManager.getSessionId();
			const file = ctx.sessionManager.getSessionFile();
			if (id) process.env.PI_SESSION_ID = id; else delete process.env.PI_SESSION_ID;
			if (file) process.env.PI_SESSION_FILE = file; else delete process.env.PI_SESSION_FILE;
			const models = ctx.scopedModels.map(({ model, thinkingLevel }) => ({
				provider: model.provider,
				id: model.id,
				thinkingLevel,
			}));
			process.env[MODEL_SCOPE_ENV] = JSON.stringify(models);
			return models;
		};
		let lastPublished: string | undefined;
		let lastPublishedAt = 0;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let refreshTimer: ReturnType<typeof setInterval> | undefined;
		let live = false;
		let generation = 0;
		let pending: Promise<void> = Promise.resolve();
		const publishPrimary = async (ctx: ExtensionContext): Promise<boolean> => {
			const current = generation;
			if (process.env.HERDR_ENV !== "1") return true;
			let socketPath = process.env.HERDR_SOCKET_PATH ?? "(unknown)";
			try {
				const terminal = currentHerdrTerminal();
				if (!terminal) return true;
				socketPath = terminal.socketPath;
				const session = { id: ctx.sessionManager.getSessionId(), path: ctx.sessionManager.getSessionFile() ?? null };
				const name = ctx.sessionManager.getSessionName?.() ?? null;
				const key = JSON.stringify([socketPath, process.env.HERDR_TERMINAL_ID ?? null, session, name]);
				if (lastPublished === key && Date.now() - lastPublishedAt < metadataRefreshMs) return true;
				const { panes } = herdrCall<{ panes: { pane_id: string; terminal_id: string }[] }>(terminal, ["pane", "list"]);
				if (!Array.isArray(panes)) throw new Error("invalid pane list");
				const runtime = process as PrimaryRuntime;
				const saved = runtime[primaryTerminalKey];
				const inherited = process.env.HERDR_TERMINAL_ID;
				if (saved?.socketPath === socketPath && inherited && saved.terminalId !== inherited) throw new Error("inherited terminal identity conflicts with runtime identity");
				let terminalId = saved?.socketPath === socketPath ? saved.terminalId : undefined;
				if (!terminalId) {
					terminalId = await primaryIdentity.identify(socketPath, panes);
					if (inherited && inherited !== terminalId) throw new Error("inherited terminal identity does not belong to this process");
				}
				if (!live || current !== generation) return true;
				const matches = panes.filter((item) => item.terminal_id === terminalId);
				if (!terminalId || matches.length !== 1) throw new Error("current terminal identity unavailable or ambiguous");
				const pane = matches[0];
				runtime[primaryTerminalKey] = { socketPath, terminalId };
				if (await metadataPublisher.publish({ ...terminal, paneId: pane.pane_id, terminalId }, {
					agent: "pi", role: "primary", session, task_name: name,
				})) { lastPublished = key; lastPublishedAt = Date.now(); return true; }
				return false;
			} catch (error) {
				if (!primaryIdentityWarned.has(socketPath)) {
					primaryIdentityWarned.add(socketPath);
					const message = `Herdr metadata unavailable (${socketPath}): ${String(error)}`;
					if (ctx.hasUI) ctx.ui.notify(message, "warning");
					else process.stderr.write(`pi-subagent: ${message}\n`);
				}
				return false;
			}
		};
		// Serialize lifecycle-triggered attempts; timers are bounded and cancelled on teardown.
		const attempt = (ctx: ExtensionContext): Promise<boolean> => {
			const current = generation;
			const result = pending.then(() => live && generation === current ? publishPrimary(ctx) : true);
			pending = result.then(() => {}, () => {});
			return result;
		};
		pi.on("session_start", async (_event, ctx) => {
			syncModelScope(ctx);
			const current = ++generation;
			live = true;
			if (retryTimer) clearTimeout(retryTimer);
			if (refreshTimer) clearInterval(refreshTimer);
			refreshTimer = setInterval(() => void attempt(ctx), metadataRefreshMs);
			refreshTimer.unref();
			const retry = async (remaining: number): Promise<void> => {
				const success = await attempt(ctx);
				if (!success && remaining > 0 && generation === current) {
					retryTimer = setTimeout(() => void retry(remaining - 1), 500);
					retryTimer.unref();
				}
			};
			await retry(3);
		});
		pi.on("agent_start", async (_event, ctx) => { await attempt(ctx); });
		pi.on("session_info_changed", async (_event, ctx) => { await attempt(ctx); });
		pi.on("session_shutdown", async () => {
			live = false;
			generation++;
			if (retryTimer) clearTimeout(retryTimer);
			if (refreshTimer) clearInterval(refreshTimer);
			retryTimer = undefined;
			refreshTimer = undefined;
			await pending;
		});
		pi.on("tool_call", (_event, ctx) => { syncModelScope(ctx); });
		pi.on("before_agent_start", (event, ctx) => ({
			systemPrompt: `${event.systemPrompt}\n\n${modelScopePrompt(syncModelScope(ctx))}`,
		}));
		pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "skills")] }));
	}

	pi.registerCommand("subagent", {
		description: "Select and open a subagent spawned by this session",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			const runs = listRuns(ctx.sessionManager.getSessionId()).filter((run) => effectiveRunState(run) !== "exited");
			if (runs.length === 0) {
				ctx.ui.notify("No active subagents spawned by this session", "info");
				return;
			}

			const items: SelectItem[] = runs.map((run) => ({
				value: run.handle,
				label: `${runDisplayName(run)}  ${displayState(run)}  ${run.provider}/${run.model}  ${run.thinking}`,
			}));
			let tui: TUI | undefined;
			const selected = await ctx.ui.custom<string | undefined>((customTui, theme, _keybindings, done) => {
				tui = customTui;
				const list = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);

				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Attach to subagent")), 1, 0));
				container.addChild(list);
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							`${keyHint("tui.select.confirm", "attach")}  ${keyHint("tui.select.cancel", "cancel")}`,
						),
						1,
						0,
					),
				);
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

				return {
					render: (width) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						list.handleInput(data);
						customTui.requestRender();
					},
				};
			});
			if (!selected || !tui) return;
			const run = runs.find((candidate) => candidate.handle === selected);
			if (!run) return;

			if (run.backend === "herdr") {
				try {
					focusHerdrTerminal(run);
				} catch (error) {
					ctx.ui.notify(`Could not focus ${run.handle}: ${String(error)}`, "error");
				}
				return;
			}

			if (process.env.TMUX) {
				const exitCode = await new Promise<number | null>((resolveExit) => {
					const child = spawn("tmux", ["switch-client", "-t", run.tmuxSession], { stdio: "inherit" });
					child.on("error", () => resolveExit(null));
					child.on("close", resolveExit);
				});
				if (exitCode !== 0) ctx.ui.notify(`Could not switch to ${run.handle}`, "error");
				return;
			}

			tui.stop();
			try {
				const exitCode = await new Promise<number | null>((resolveExit) => {
					const child = spawn("tmux", ["attach-session", "-t", run.tmuxSession], { stdio: "inherit" });
					child.on("error", () => resolveExit(null));
					child.on("close", resolveExit);
				});
				if (exitCode !== 0) process.stderr.write(`Could not attach to ${run.handle}\n`);
			} finally {
				tui.start();
				tui.requestRender(true);
			}
		},
	});

	if (!runDir) {
		let widgetTimer: ReturnType<typeof setInterval> | undefined;
		let widgetContext: ExtensionContext | undefined;

		const refreshWidget = (): void => {
			if (!widgetContext) return;
			const activeRuns = listRuns(widgetContext.sessionManager.getSessionId())
				.map((run) => ({ run, state: effectiveRunState(run) }))
				.filter(({ state }) => state !== "exited");
			if (activeRuns.length === 0) {
				widgetContext.ui.setWidget("subagents", undefined);
				return;
			}

			const visible = activeRuns.slice(0, 5).map(({ run, state }) => {
				const color =
					state === "busy" ? "warning" : state === "idle" ? "success" : state === "error" ? "error" : "muted";
				return widgetContext!.ui.theme.fg(color, `${run.name ?? run.handle}:${state}`);
			});
			if (activeRuns.length > visible.length) {
				visible.push(widgetContext.ui.theme.fg("muted", `+${activeRuns.length - visible.length}`));
			}
			widgetContext.ui.setWidget(
				"subagents",
				[widgetContext.ui.theme.fg("dim", "subagents: ") + visible.join(widgetContext.ui.theme.fg("dim", " | "))],
				{ placement: "belowEditor" },
			);
		};

		pi.on("session_start", (_event, ctx) => {
			// Relaunch children that were suspended when this session was last quit or switched away from.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!run.suspended) continue;
				try {
					if (terminalIsRunning(run)) continue;
					if (!existsSync(run.sessionFile)) {
						removeRunDir(run.runDir);
						continue;
					}
					const starting = updateMetadata(run.runDir, { state: "starting", error: undefined }) ?? run;
					launchRun(starting);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					updateMetadata(run.runDir, { state: "error", error: message });
					if (ctx.hasUI) ctx.ui.notify(`Could not resume subagent ${runDisplayName(run)}: ${message}`, "error");
				}
			}

			if (!ctx.hasUI) return;
			widgetContext = ctx;
			refreshWidget();
			widgetTimer = setInterval(refreshWidget, 1000);
			widgetTimer.unref();
		});

		pi.on("session_shutdown", async (event, ctx) => {
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			widgetContext = undefined;
			ctx.ui.setWidget("subagents", undefined);
			if (event.reason === "reload") return;
			// Suspend running children: stop the process but keep transcript and metadata so resuming this
			// session relaunches them. Children that already exited on their own are discarded.
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				try {
					if (!terminalIsRunning(run)) {
						if (!run.suspended) removeRunDir(run.runDir);
						continue;
					}
					updateMetadata(run.runDir, { suspended: true });
					stopTerminal(run);
					await waitForRunShutdown(run.runDir);
				} catch (error) {
					// Losing the server must never discard a resumable child transcript.
					updateMetadata(run.runDir, { suspended: true, error: String(error) });
					if (ctx.hasUI) ctx.ui.notify(`Could not suspend ${runDisplayName(run)}: ${String(error)}`, "error");
				}
			}
		});
		return;
	}

	let currentContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let processing = false;
	let sessionName: string | undefined;
	let childTerminal: HerdrTerminal | undefined;
	let metadataGeneration = 0;
	let metadataRetryTimer: ReturnType<typeof setTimeout> | undefined;
	let metadataRefreshTimer: ReturnType<typeof setInterval> | undefined;
	let metadataPending: Promise<void> = Promise.resolve();
	let lastChildPublished: string | undefined;
	let lastChildPublishedAt = 0;

	const publishChild = (): Promise<boolean> => {
		const current = metadataGeneration;
		const result = metadataPending.then(async () => {
			if (!currentContext || current !== metadataGeneration) return true;
			const metadata = readMetadata(runDir);
			if (metadata?.backend !== "herdr" || !metadata.herdr || !childTerminal) return true;
			// A restore/relaunch creates a different terminal. Never adopt it from a live old child.
			if (metadata.herdr.socketPath !== childTerminal.socketPath || metadata.herdr.terminalId !== childTerminal.terminalId) return false;
			const context = childMetadata(metadata);
			const key = JSON.stringify(context);
			if (lastChildPublished === key && Date.now() - lastChildPublishedAt < metadataRefreshMs) return true;
			try {
				metadata.herdr = { ...childTerminal };
				if (!terminalIsRunning(metadata)) return false;
				childTerminal = { ...metadata.herdr };
				updateMetadata(runDir, { herdr: metadata.herdr });
				const success = await metadataPublisher.publish(metadata.herdr, context);
				if (current !== metadataGeneration) return true;
				if (success) {
					const latest = readMetadata(runDir);
					if (latest?.herdr?.socketPath !== childTerminal.socketPath || latest.herdr.terminalId !== childTerminal.terminalId) return false;
					childTerminal = { ...metadata.herdr };
					updateMetadata(runDir, { herdr: metadata.herdr });
					lastChildPublished = key;
					lastChildPublishedAt = Date.now();
				}
				return success;
			} catch (error) {
				if (currentContext?.hasUI) currentContext.ui.notify(`Herdr metadata unavailable: ${String(error)}`, "warning");
				return false;
			}
		});
		metadataPending = result.then(() => {}, () => {});
		return result;
	};

	const syncSessionName = (): boolean => {
		const metadata = readMetadata(runDir);
		if (!metadata) return false;
		const next = `subagent ${metadata.name ?? metadata.handle}`;
		if (next === sessionName) return false;
		pi.setSessionName(next);
		sessionName = next;
		return true;
	};

	const processInbox = async (): Promise<void> => {
		if (processing || !currentContext) return;
		if (syncSessionName()) void publishChild();
		const queueDir = inboxDir(runDir);
		if (!existsSync(queueDir)) return;
		processing = true;
		try {
			for (const name of readdirSync(queueDir)
				.filter((entry) => entry.endsWith(".json"))
				.sort()) {
				const path = join(queueDir, name);
				let payload: InboxMessage;
				try {
					const value: unknown = JSON.parse(readFileSync(path, "utf8"));
					if (!isInboxMessage(value)) throw new Error("Invalid inbox message");
					payload = value;
				} catch (error) {
					unlinkSync(path);
					updateMetadata(runDir, {
						state: "error",
						error: error instanceof Error ? error.message : String(error),
					});
					continue;
				}

				updateMetadata(runDir, { state: "busy", error: undefined });
				try {
					if (currentContext.isIdle()) {
						pi.sendUserMessage(payload.message);
					} else {
						pi.sendUserMessage(payload.message, {
							deliverAs: payload.delivery === "followUp" ? "followUp" : "steer",
						});
					}
					unlinkSync(path);
				} catch (error) {
					updateMetadata(runDir, {
						state: currentContext.isIdle() ? "idle" : "busy",
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
			}
		} finally {
			processing = false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		const updated = updateMetadata(runDir, {
			childSessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? metadata.sessionFile,
			state: ctx.isIdle() ? "idle" : "busy",
			suspended: undefined,
			error: undefined,
		});
		syncSessionName();
		const current = ++metadataGeneration;
		if (metadataRetryTimer) clearTimeout(metadataRetryTimer);
		if (metadataRefreshTimer) clearInterval(metadataRefreshTimer);
		lastChildPublished = undefined;
		if (updated?.backend === "herdr" && updated.herdr) {
			childTerminal ??= { ...updated.herdr };
			metadataRefreshTimer = setInterval(() => void publishChild(), metadataRefreshMs);
			metadataRefreshTimer.unref();
			const retry = async (remaining: number): Promise<void> => {
				const success = await publishChild();
				if (!success && remaining > 0 && current === metadataGeneration) {
					metadataRetryTimer = setTimeout(() => void retry(remaining - 1), 500);
					metadataRetryTimer.unref();
				}
			};
			await retry(3);
		}
		if (!currentContext || current !== metadataGeneration) return;
		if (!timer) {
			timer = setInterval(() => void processInbox(), 250);
			timer.unref();
		}
		void processInbox();
	});

	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		updateMetadata(runDir, { state: "busy", hasStarted: true, error: undefined });
	});

	pi.on("agent_settled", (_event, ctx) => {
		currentContext = ctx;
		if (ctx.isIdle()) updateMetadata(runDir, { state: "idle" });
	});

	pi.on("session_shutdown", async (event) => {
		currentContext = undefined;
		metadataGeneration++;
		if (metadataRetryTimer) clearTimeout(metadataRetryTimer);
		if (metadataRefreshTimer) clearInterval(metadataRefreshTimer);
		metadataRetryTimer = undefined;
		metadataRefreshTimer = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		await metadataPending;
		if (event.reason === "quit") updateMetadata(runDir, { state: "exited" });
	});
}
