import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import subagentExtension from "./index.ts";
import { launchRun, readMetadata, writeMetadata, type RunMetadata } from "./shared.ts";
import { MODEL_SCOPE_ENV } from "./model-scope.ts";

test("/subagent focuses Herdr without suspending TUI; reload, parent quit and resume retain lifecycle", async () => {
	initTheme("light", false);
	const previous = { ...process.env };
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
		PATH: `${dir}:${process.env.PATH}`, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_SUBAGENT_RUN_DIR: "",
		TEST_STATE: state, TEST_LOG: log,
		[MODEL_SCOPE_ENV]: JSON.stringify([{ provider: "provider-a", id: "model-one" }]),
	});
	const handlers = new Map<string, ((...args: any[]) => any)[]>();
	let command: any;
	let stoppedTui = 0;
	const ctx: any = {
		mode: "tui", hasUI: true,
		scopedModels: [{ model: { provider: "provider-a", id: "model-one" } }],
		sessionManager: { getSessionId: () => "parent-test" },
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
		launchRun(run, ["original prompt"]);
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
	} finally {
		await emit("session_shutdown", { reason: "quit" });
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
	}
});
