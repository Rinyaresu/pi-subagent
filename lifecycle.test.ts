import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import subagentExtension from "./index.ts";
import { launchRun, readMetadata, updateMetadata, writeMetadata, type RunMetadata } from "./shared.ts";
import { metadataPublisher } from "./herdr-metadata.ts";
import { MODEL_SCOPE_ENV } from "./model-scope.ts";
import { primaryIdentity } from "./primary-identity.ts";

test("primary session changes publish aliases and follow moved terminal identity", async () => {
	const previous = { ...process.env };
	const originalPublish = metadataPublisher.publish;
	const originalIdentify = primaryIdentity.identify;
	primaryIdentity.identify = async () => "stable";
	const publications: any[] = [];
	const artifacts = join(homedir(), ".local/state/pi/work-artifacts/pi-subagent/agent-families");
	mkdirSync(artifacts, { recursive: true });
	const dir = mkdtempSync(join(artifacts, "primary-"));
	const state = join(dir, "panes.json");
	writeFileSync(join(dir, "herdr"), `#!${process.execPath}\nconst fs=require('node:fs'); console.log(JSON.stringify({result:{panes:JSON.parse(fs.readFileSync(process.env.TEST_PANES))}}));\n`, { mode: 0o700 });
	writeFileSync(state, JSON.stringify([{ pane_id: "p1", terminal_id: "stable" }]));
	Object.assign(process.env, { PATH: `${dir}:${process.env.PATH}`, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_SUBAGENT_RUN_DIR: "", HERDR_ENV: "1", HERDR_SOCKET_PATH: join(dir, "api.sock"), HERDR_WORKSPACE_ID: "w", HERDR_PANE_ID: "p1", HERDR_TERMINAL_ID: "stable", TEST_PANES: state });
	metadataPublisher.publish = async (terminal, context) => { publications.push({ terminal, context }); return true; };
	const handlers = new Map<string, ((...args: any[]) => any)[]>();
	const ctx: any = { hasUI: false, scopedModels: [], sessionManager: { getSessionId: () => "parent-1", getSessionFile: () => "/parent-1" }, ui: { setWidget() {} } };
	try {
		subagentExtension({ on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerCommand() {} } as any);
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
		writeFileSync(state, JSON.stringify([{ pane_id: "p1", terminal_id: "reused" }, { pane_id: "p2", terminal_id: "stable" }]));
		delete process.env.HERDR_TERMINAL_ID;
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "reload" }, ctx);
		handlers.clear();
		const reloaded = (await import(`./index.ts?reload=${Date.now()}`)).default;
		reloaded({ on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerCommand() {} } as any);
		ctx.sessionManager = { getSessionId: () => "parent-2", getSessionFile: () => "/parent-2" };
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "reload" }, ctx);
		assert.equal(process.env.PI_SESSION_ID, "parent-2");
		assert.equal(process.env.PI_SESSION_FILE, "/parent-2");
		for (const handler of handlers.get("agent_start") ?? []) await handler({}, ctx);
		assert.equal(publications.length, 2);
		assert.deepEqual(publications.map((p) => p.terminal.paneId), ["p1", "p2"]);
		assert.deepEqual(publications.map((p) => p.context.session), [{ id: "parent-1", path: "/parent-1" }, { id: "parent-2", path: "/parent-2" }]);
		assert.ok(publications.every((p) => p.context.role === "primary" && !Object.hasOwn(p.context, "completion_sound")));

		// The managed hook can still report the old session during session_start.
		let attempts = 0;
		metadataPublisher.publish = async (terminal, context) => { publications.push({ terminal, context }); return ++attempts > 1; };
		ctx.sessionManager = { getSessionId: () => "parent-3", getSessionFile: () => "/parent-3", getSessionName: () => "work" };
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "new" }, ctx);
		assert.equal(attempts, 1);
		assert.equal(process.env.PI_SESSION_ID, "parent-3");
		assert.equal(process.env.PI_SESSION_FILE, "/parent-3");
		for (const handler of handlers.get("agent_start") ?? []) await handler({}, ctx);
		for (const handler of handlers.get("agent_start") ?? []) await handler({}, ctx);
		assert.equal(attempts, 2);
		assert.equal(publications.at(-1).context.task_name, "work");
		assert.equal(publications.at(-1).terminal.paneId, "p2");
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "reload" }, ctx);
		primaryIdentity.identify = originalIdentify;
		metadataPublisher.publish = originalPublish;
		delete (process as any)[Symbol.for("pi-subagent.primary-terminal.v1")];
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
	}
});

test("bounded retry publishes after delayed managed-hook readiness", async () => {
	const previous = { ...process.env };
	const originalPublish = metadataPublisher.publish;
	const originalIdentify = primaryIdentity.identify;
	const artifacts = join(homedir(), ".local/state/pi/work-artifacts/pi-subagent/agent-families");
	mkdirSync(artifacts, { recursive: true });
	const dir = mkdtempSync(join(artifacts, "primary-retry-"));
	writeFileSync(join(dir, "herdr"), `#!${process.execPath}\nconsole.log(JSON.stringify({result:{panes:[{pane_id:'p',terminal_id:'ours'}]}}));\n`, { mode: 0o700 });
	Object.assign(process.env, { PATH: `${dir}:${process.env.PATH}`, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_SUBAGENT_RUN_DIR: "", HERDR_ENV: "1", HERDR_SOCKET_PATH: join(dir, "api.sock"), HERDR_WORKSPACE_ID: "w", HERDR_TERMINAL_ID: "ours" });
	delete (process as any)[Symbol.for("pi-subagent.primary-terminal.v1")];
	primaryIdentity.identify = async () => "ours";
	let ready = false;
	let calls = 0;
	let resolvePublished!: () => void;
	const published = new Promise<void>((resolve) => { resolvePublished = resolve; });
	metadataPublisher.publish = async () => { calls++; if (ready) resolvePublished(); return ready; };
	const handlers = new Map<string, ((...args: any[]) => any)[]>();
	const ctx: any = { hasUI: false, scopedModels: [], sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent" }, ui: { setWidget() {} } };
	try {
		subagentExtension({ on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerCommand() {} } as any);
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "new" }, ctx);
		for (const handler of handlers.get("agent_start") ?? []) await handler({}, ctx);
		assert.equal(calls, 2);
		ready = true;
		await Promise.race([published, new Promise<never>((_, reject) => setTimeout(() => reject(Error("retry timeout")), 2000))]);
		assert.equal(calls, 3);
		for (const handler of handlers.get("agent_start") ?? []) await handler({}, ctx);
		assert.equal(calls, 3);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "reload" }, ctx);
		primaryIdentity.identify = originalIdentify;
		metadataPublisher.publish = originalPublish;
		delete (process as any)[Symbol.for("pi-subagent.primary-terminal.v1")];
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
	}
});

test("wrong inherited terminal ID cannot publish to another pane", async () => {
	const previous = { ...process.env };
	const originalPublish = metadataPublisher.publish;
	const originalIdentify = primaryIdentity.identify;
	const artifacts = join(homedir(), ".local/state/pi/work-artifacts/pi-subagent/agent-families");
	mkdirSync(artifacts, { recursive: true });
	const dir = mkdtempSync(join(artifacts, "primary-hint-"));
	writeFileSync(join(dir, "herdr"), `#!${process.execPath}\nconsole.log(JSON.stringify({result:{panes:[{pane_id:'p1',terminal_id:'wrong'},{pane_id:'p2',terminal_id:'ours'}]}}));\n`, { mode: 0o700 });
	Object.assign(process.env, { PATH: `${dir}:${process.env.PATH}`, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_SUBAGENT_RUN_DIR: "", HERDR_ENV: "1", HERDR_SOCKET_PATH: join(dir, "api.sock"), HERDR_WORKSPACE_ID: "w", HERDR_PANE_ID: "p1", HERDR_TERMINAL_ID: "wrong" });
	delete (process as any)[Symbol.for("pi-subagent.primary-terminal.v1")];
	primaryIdentity.identify = async () => "ours";
	let published = false;
	metadataPublisher.publish = async () => { published = true; return true; };
	const warnings: string[] = [];
	const handlers = new Map<string, ((...args: any[]) => any)[]>();
	const ctx: any = { hasUI: true, scopedModels: [], sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent" }, ui: { notify: (message: string) => warnings.push(message), setWidget() {} } };
	try {
		subagentExtension({ on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerCommand() {} } as any);
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "reload" }, ctx);
		assert.equal(published, false);
		assert.match(warnings[0], /does not belong/);
		assert.equal((process as any)[Symbol.for("pi-subagent.primary-terminal.v1")], undefined);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "reload" }, ctx);
		primaryIdentity.identify = originalIdentify;
		metadataPublisher.publish = originalPublish;
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
	}
});

test("reload without verifiable identity never trusts the inherited pane", async () => {
	const previous = { ...process.env };
	const originalPublish = metadataPublisher.publish;
	const artifacts = join(homedir(), ".local/state/pi/work-artifacts/pi-subagent/agent-families");
	mkdirSync(artifacts, { recursive: true });
	const dir = mkdtempSync(join(artifacts, "primary-unverified-"));
	writeFileSync(join(dir, "herdr"), `#!${process.execPath}\nconsole.log(JSON.stringify({result:{panes:[{pane_id:'p1',terminal_id:'other'}]}}));\n`, { mode: 0o700 });
	Object.assign(process.env, { PATH: `${dir}:${process.env.PATH}`, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_SUBAGENT_RUN_DIR: "", HERDR_ENV: "1", HERDR_SOCKET_PATH: join(dir, "absent.sock"), HERDR_WORKSPACE_ID: "w", HERDR_PANE_ID: "p1" });
	delete process.env.HERDR_TERMINAL_ID;
	delete (process as any)[Symbol.for("pi-subagent.primary-terminal.v1")];
	const warnings: string[] = [];
	let published = false;
	metadataPublisher.publish = async () => { published = true; return true; };
	const handlers = new Map<string, ((...args: any[]) => any)[]>();
	const ctx: any = { hasUI: true, scopedModels: [], sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent" }, ui: { notify: (message: string) => warnings.push(message), setWidget() {} } };
	try {
		subagentExtension({ on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerCommand() {} } as any);
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "reload" }, ctx);
		assert.equal(published, false);
		assert.equal(warnings.length, 1);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "reload" }, ctx);
		metadataPublisher.publish = originalPublish;
		delete (process as any)[Symbol.for("pi-subagent.primary-terminal.v1")];
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
	}
});

test("primary renews ephemeral metadata without per-turn API calls and stops on shutdown", async (t) => {
	const previous = { ...process.env };
	const originalPublish = metadataPublisher.publish;
	const originalIdentify = primaryIdentity.identify;
	const artifacts = join(homedir(), ".local/state/pi/work-artifacts/pi-subagent/agent-families");
	mkdirSync(artifacts, { recursive: true });
	const dir = mkdtempSync(join(artifacts, "primary-refresh-"));
	const log = join(dir, "calls");
	writeFileSync(log, "");
	writeFileSync(join(dir, "herdr"), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.TEST_LOG,'list\\n');console.log(JSON.stringify({result:{panes:[{pane_id:'p',terminal_id:'ours'}]}}));\n`, { mode: 0o700 });
	Object.assign(process.env, { PATH: `${dir}:${process.env.PATH}`, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_SUBAGENT_RUN_DIR: "", HERDR_ENV: "1", HERDR_SOCKET_PATH: join(dir, "api.sock"), HERDR_WORKSPACE_ID: "w", HERDR_TERMINAL_ID: "ours", TEST_LOG: log });
	delete (process as any)[Symbol.for("pi-subagent.primary-terminal.v1")];
	primaryIdentity.identify = async () => "ours";
	let calls = 0;
	metadataPublisher.publish = async () => { calls++; return true; };
	const handlers = new Map<string, ((...args: any[]) => any)[]>();
	const ctx: any = { hasUI: false, scopedModels: [], sessionManager: { getSessionId: () => "parent", getSessionFile: () => "/parent" }, ui: { setWidget() {} } };
	const emit = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({ reason: "reload" }, ctx); };
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 1_000_000 });
	const advance = async (ms: number) => { t.mock.timers.tick(ms); await new Promise<void>((resolve) => setImmediate(resolve)); };
	try {
		subagentExtension({ on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerCommand() {} } as any);
		await emit("session_start");
		for (let i = 0; i < 5; i++) await emit("agent_start");
		await advance(29_999);
		await emit("agent_start");
		assert.equal(calls, 1);
		assert.equal(readFileSync(log, "utf8"), "list\n", "throttling must happen before pane.list");
		await advance(1);
		assert.equal(calls, 2, "idle sessions must renew the ephemeral TTL");
		await emit("agent_start");
		assert.equal(calls, 2);
		await emit("session_shutdown");
		await advance(90_000);
		await emit("agent_start");
		assert.equal(calls, 2);
	} finally {
		await emit("session_shutdown");
		t.mock.timers.reset();
		primaryIdentity.identify = originalIdentify;
		metadataPublisher.publish = originalPublish;
		delete (process as any)[Symbol.for("pi-subagent.primary-terminal.v1")];
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
	}
});

test("child retries readiness, renews moved/renamed metadata and never rebinds a restored terminal", async (t) => {
	const previous = { ...process.env };
	const originalPublish = metadataPublisher.publish;
	const artifacts = join(homedir(), ".local/state/pi/work-artifacts/pi-subagent/agent-families");
	mkdirSync(artifacts, { recursive: true });
	const dir = mkdtempSync(join(artifacts, "child-refresh-"));
	const state = join(dir, "panes.json");
	const log = join(dir, "calls");
	writeFileSync(log, "");
	writeFileSync(state, JSON.stringify([{ pane_id: "p1", terminal_id: "stable", tab_id: "t1", workspace_id: "w1" }]));
	writeFileSync(join(dir, "herdr"), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.TEST_LOG,'list\\n');console.log(JSON.stringify({result:{panes:JSON.parse(fs.readFileSync(process.env.TEST_PANES))}}));\n`, { mode: 0o700 });
	const runDir = join(dir, "run");
	mkdirSync(runDir);
	const run: RunMetadata = { version: 1, backend: "herdr", herdr: { socketPath: join(dir, "api.sock"), workspaceId: "w1", tabId: "t1", paneId: "p1", terminalId: "stable" }, handle: "abc123", parentSessionId: "parent", parentSessionFile: "/parent", childSessionId: "stale-child", tmuxSession: "unused", runDir, sessionFile: join(runDir, "session.jsonl"), cwd: dir, provider: "provider-a", model: "model-one", thinking: "high", state: "starting", hasStarted: false, createdAt: "now", updatedAt: "now" };
	writeMetadata(run);
	Object.assign(process.env, { PATH: `${dir}:${process.env.PATH}`, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_SUBAGENT_RUN_DIR: runDir, HERDR_TERMINAL_ID: "stale-parent", PI_SESSION_ID: "stale-parent", PI_SESSION_FILE: "/stale-parent", TEST_PANES: state, TEST_LOG: log });
	const publications: any[] = [];
	let ready = false;
	metadataPublisher.publish = async (terminal, context) => { publications.push({ terminal: { ...terminal }, context }); return ready; };
	const handlers = new Map<string, ((...args: any[]) => any)[]>();
	const names: string[] = [];
	const warnings: string[] = [];
	const ctx: any = { hasUI: true, isIdle: () => true, sessionManager: { getSessionId: () => "current-child", getSessionFile: () => run.sessionFile }, ui: { notify: (message: string) => warnings.push(message) } };
	const emit = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({ reason: "reload" }, ctx); };
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 1_000_000 });
	const advance = async (ms: number) => { t.mock.timers.tick(ms); await new Promise<void>((resolve) => setImmediate(resolve)); };
	try {
		subagentExtension({ on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); }, registerCommand() {}, setSessionName(name: string) { names.push(name); } } as any);
		await emit("session_start");
		assert.equal(publications.length, 1);
		assert.deepEqual(publications[0].context.session, { id: "current-child", path: run.sessionFile });
		assert.equal(publications[0].context.parent_session.id, "parent");
		assert.equal(publications[0].terminal.terminalId, "stable");
		assert.equal(Object.hasOwn(publications[0].context, "completion_sound"), false);
		await advance(500);
		assert.equal(publications.length, 2);
		ready = true;
		await advance(500);
		assert.equal(publications.length, 3);
		assert.deepEqual(warnings, [], "not-yet-ready publication must stay silent");
		const beforeTurns = readFileSync(log, "utf8");
		await emit("agent_start");
		await emit("agent_settled");
		assert.equal(publications.length, 3);
		assert.equal(readFileSync(log, "utf8"), beforeTurns);
		updateMetadata(runDir, { name: "renamed" });
		await advance(250);
		assert.equal(publications.at(-1).context.task_name, "renamed");
		assert.equal(names.at(-1), "subagent renamed");
		writeFileSync(state, JSON.stringify([{ pane_id: "p1", terminal_id: "other", tab_id: "t1", workspace_id: "w1" }, { pane_id: "p2", terminal_id: "stable", tab_id: "t2", workspace_id: "w2" }]));
		await advance(59_000);
		assert.equal(publications.at(-1).terminal.paneId, "p2");
		assert.equal(readMetadata(runDir)!.herdr!.workspaceId, "w2");
		assert.equal(readMetadata(runDir)!.herdr!.paneId, "p2");
		// Reload gets a fresh bounded readiness budget; failed publication never changes run state.
		ready = false;
		const beforeReload = publications.length;
		await emit("session_start");
		for (let i = 0; i < 3; i++) await advance(500);
		assert.equal(publications.length, beforeReload + 4);
		await advance(1_000);
		assert.equal(publications.length, beforeReload + 4, "startup retries must be bounded");
		assert.equal(readMetadata(runDir)!.state, "idle");
		assert.deepEqual(warnings, []);
		// A parent's relaunch/restore cannot cause the still-live old child to adopt new identity.
		updateMetadata(runDir, { herdr: { ...run.herdr!, terminalId: "restored", paneId: "p3" } });
		writeFileSync(state, JSON.stringify([{ pane_id: "p3", terminal_id: "restored", tab_id: "t3", workspace_id: "w3" }]));
		const beforeRestore = publications.length;
		await advance(30_000);
		assert.equal(publications.length, beforeRestore);
		assert.equal(readMetadata(runDir)!.herdr!.terminalId, "restored");
		await emit("session_shutdown");
		const beforeShutdown = readFileSync(log, "utf8");
		await advance(90_000);
		assert.equal(publications.length, beforeRestore);
		assert.equal(readFileSync(log, "utf8"), beforeShutdown);
	} finally {
		await emit("session_shutdown");
		t.mock.timers.reset();
		metadataPublisher.publish = originalPublish;
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
	}
});

test("/subagent focuses Herdr without suspending TUI; reload, parent quit and resume retain lifecycle", async () => {
	initTheme("light", false);
	const previous = { ...process.env };
	const originalPublish = metadataPublisher.publish;
	const publications: any[] = [];
	metadataPublisher.publish = async (terminal, context) => { publications.push({ terminal: { ...terminal }, context }); return true; };
	const artifacts = join(homedir(), ".local/state/pi/work-artifacts/pi-subagent");
	mkdirSync(artifacts, { recursive: true });
	const dir = mkdtempSync(join(artifacts, "lifecycle-test-"));
	const log = join(dir, "calls.jsonl");
	const state = join(dir, "state.json");
	writeFileSync(log, "");
	writeFileSync(state, JSON.stringify({ next: 0, panes: [] }));
	writeFileSync(join(dir, "herdr"), `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(process.env.TEST_STATE));
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(a)+'\\n');
let result = {};
if (a[0] === 'tab' && a[1] === 'create') {
 const n = ++s.next;
 result = {tab:{tab_id:'w1:t'+n,workspace_id:'w1'},root_pane:{pane_id:'w1:p'+n,terminal_id:'term-'+n}};
 s.panes.push({pane_id:'w1:p'+n,tab_id:'w1:t'+n,workspace_id:'w1',terminal_id:'term-'+n});
} else if (a[1] === 'list') result = {panes:s.panes};
else if (a[1] === 'close') s.panes = s.panes.filter(p=>p.pane_id!==a[2]);
fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(s));
console.log(JSON.stringify({result}));
`, { mode: 0o700 });
	Object.assign(process.env, {
		PATH: `${dir}:${process.env.PATH}`, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_SUBAGENT_RUN_DIR: "", HERDR_ENV: "",
		TEST_STATE: state, TEST_LOG: log,
		[MODEL_SCOPE_ENV]: JSON.stringify([{ provider: "provider-a", id: "model-one" }]),
	});
	const handlers = new Map<string, ((...args: any[]) => any)[]>();
	let command: any;
	let stoppedTui = 0;
	const ctx: any = {
		mode: "tui", hasUI: true,
		scopedModels: [{ model: { provider: "provider-a", id: "model-one" } }],
		sessionManager: { getSessionId: () => "parent-test", getSessionFile: () => "/parent-test" },
		ui: {
			setWidget() {}, notify(message: string) { throw new Error(message); },
			theme: { fg: (_: string, text: string) => text, bold: (text: string) => text },
			custom: (factory: any) => new Promise((resolve) => {
				const component = factory({ stop() { stoppedTui++; }, requestRender() {} }, ctx.ui.theme, {}, resolve);
				component.handleInput("\r");
			}),
		},
	};
	const emit = async (name: string, event: any) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	try {
		const runDir = join(dir, "agent/subagents/abc123");
		mkdirSync(runDir, { recursive: true });
		const run: RunMetadata = {
			version: 1, backend: "herdr", herdr: { socketPath: join(dir, "test.sock"), workspaceId: "w1" },
			handle: "abc123", parentSessionId: "parent-test", tmuxSession: "unused",
			runDir, sessionFile: join(runDir, "session.jsonl"), cwd: dir,
			provider: "provider-a", model: "model-one", thinking: "medium",
			state: "starting", hasStarted: false, createdAt: "now", updatedAt: "now",
		};
		writeFileSync(run.sessionFile, "");
		writeMetadata(run);
		await launchRun(run, ["original prompt"]);
		subagentExtension({
			on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			registerCommand(_name: string, definition: any) { command = definition; },
		} as any);
		await emit("session_start", { reason: "startup" });
		await command.handler("", ctx);
		assert.equal(stoppedTui, 0);
		const calls = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(calls().at(-1), ["agent", "focus", "w1:p1"]);
		await emit("session_shutdown", { reason: "reload" });
		assert.equal(calls().some((a) => a[1] === "close"), false);
		await emit("session_shutdown", { reason: "quit" });
		assert.equal(readMetadata(runDir)!.suspended, true);
		assert.deepEqual(JSON.parse(readFileSync(state, "utf8")).panes, []);
		await emit("session_start", { reason: "resume" });
		assert.equal(readMetadata(runDir)!.herdr!.paneId, "w1:p2");
		assert.doesNotMatch(readFileSync(join(runDir, "launch.sh"), "utf8"), /original prompt/);
		assert.deepEqual(publications, [], "launch/resume must not publish before a child session is accepted");
		await emit("session_shutdown", { reason: "reload" });

		// A child startup/reload confirms both aliases and publishes the latest name.
		process.env.PI_SUBAGENT_RUN_DIR = runDir;
		handlers.clear();
		subagentExtension({
			on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			registerCommand() {}, setSessionName() {},
		} as any);
		ctx.isIdle = () => true;
		ctx.sessionManager = { getSessionId: () => "child-id", getSessionFile: () => run.sessionFile };
		await emit("session_start", { reason: "startup" });
		assert.deepEqual(publications.at(-1).context.session, { id: "child-id", path: run.sessionFile });
		updateMetadata(runDir, { name: "renamed" });
		await emit("session_start", { reason: "reload" });
		assert.equal(publications.at(-1).context.task_name, "renamed");
		assert.equal(publications.at(-1).terminal.terminalId, "term-2");
	} finally {
		await emit("session_shutdown", { reason: "quit" });
		metadataPublisher.publish = originalPublish;
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
	}
});
