import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { effectiveRunState, launchRun, readMetadata, updateMetadata, writeMetadata, type RunMetadata } from "./shared.ts";
import { attachCommand, currentHerdrTerminal, focusHerdrTerminal, stopTerminal, terminalIsRunning } from "./terminal.ts";
import { MODEL_SCOPE_ENV } from "./model-scope.ts";

const root = dirname(fileURLToPath(import.meta.url));
const scope = [{ provider: "provider-a", id: "model-one", thinkingLevel: "high" }];
const fakeHerdr = `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({args:a, socket:process.env.HERDR_SOCKET_PATH, workspace:process.env.HERDR_WORKSPACE_ID, pane:process.env.HERDR_PANE_ID})+'\\n');
if (process.env.FAKE_FAIL === a.slice(0,2).join(' ')) { console.error('server unavailable'); process.exit(1); }
let result = {};
if ((a[0] === 'tab' || a[0] === 'workspace') && a[1] === 'create') {
 const fresh = a[0] === 'workspace';
 const workspace = fresh ? 'w-subagents' : a[a.indexOf('--workspace')+1];
 const tab = workspace+':t'+(++state.next);
 const pane = workspace+':p'+state.next;
 const terminal = 'term-'+state.next;
 state.panes.push({pane_id:pane,tab_id:tab,workspace_id:workspace,terminal_id:terminal});
 const root_pane = {pane_id:pane,terminal_id:terminal};
 if (fresh) {
   const created = {workspace_id:workspace,active_tab_id:tab,tokens:{}};
   state.workspaces.push(created);
   result = {workspace:created,root_pane};
 } else result = {tab:{tab_id:tab,workspace_id:workspace},root_pane};
} else if (a[0] === 'workspace' && a[1] === 'list') result = {workspaces:state.workspaces};
else if (a[0] === 'workspace' && a[1] === 'report-metadata') {
 const [key, value] = a[a.indexOf('--token')+1].split('=');
 state.workspaces.find(w=>w.workspace_id===a[2]).tokens[key] = value;
} else if (a[0] === 'pane' && a[1] === 'list') result = {panes:state.panes};
else if (a[0] === 'pane' && a[1] === 'close') state.panes = state.panes.filter(p=>p.pane_id!==a[2]);
fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(state));
console.log(JSON.stringify({result}));
`;

function fixture() {
	const artifacts = join(homedir(), ".local/state/pi/work-artifacts/pi-subagent");
	mkdirSync(artifacts, { recursive: true });
	const dir = mkdtempSync(join(artifacts, "terminal-test-"));
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const stateFile = join(dir, "state.json");
	const socket = join(dir, "owner.sock");
	writeFileSync(socket, "");
	const log = join(dir, "calls.jsonl");
	writeFileSync(stateFile, JSON.stringify({ next: 0, workspaces: [{ workspace_id: "w-test" }], panes: [] }));
	writeFileSync(log, "");
	writeFileSync(join(bin, "herdr"), fakeHerdr, { mode: 0o700 });
	writeFileSync(join(bin, "tmux"), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.FAKE_LOG, JSON.stringify({tmux:process.argv.slice(2)})+'\\n');\n`, { mode: 0o700 });
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		PI_CODING_AGENT_DIR: join(dir, "agent"),
		PI_SUBAGENT_RUN_DIR: "",
		PI_SESSION_ID: "terminal-test-parent",
		PI_PROVIDER: "provider-a", PI_MODEL: "model-one",
		HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_WORKSPACE_ID: "w-test",
		HERDR_PANE_ID: "w-parent:p1", HERDR_TAB_ID: "w-parent:t1",
		FAKE_STATE: stateFile, FAKE_LOG: log,
		[MODEL_SCOPE_ENV]: JSON.stringify(scope),
	};
	const cli = (args: string[], overrides: Record<string, string | undefined> = {}) => spawnSync(
		process.execPath, [join(root, "subagent.ts"), ...args], { encoding: "utf8", env: { ...env, ...overrides } },
	);
	const spawn = (args: string[] = [], overrides: Record<string, string | undefined> = {}) => cli(
		["spawn", "--cwd", dir, "--prompt", "test", ...args], overrides,
	);
	const runsDir = join(env.PI_CODING_AGENT_DIR, "subagents");
	const run = (): RunMetadata => readMetadata(join(runsDir, readdirSync(runsDir)[0]))!;
	const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	return { dir, env, cli, spawn, run, calls, runsDir, stateFile };
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
	const previous = { ...process.env };
	try {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		return await fn();
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
	}
}

test("Herdr spawn creates an unfocused workspace, persists IDs, and never invokes tmux", async () => {
	const f = fixture();
	const result = f.spawn(["--name", "review"]);
	assert.equal(result.status, 0, result.stderr);
	const run = f.run();
	assert.equal(run.backend, "herdr");
	assert.equal(run.herdr?.paneId, "w-subagents:p1");
	assert.equal(run.herdr?.tabId, "w-subagents:t1");
	assert.match(result.stdout, /herdr agent focus/);
	assert.doesNotMatch(result.stdout, /tmux attach/);
	assert.equal(f.calls().some((c) => c.tmux), false);
	const creation = f.calls().find((call) => call.args[1] === "create");
	assert.ok(creation.args.includes("--no-focus"));
	assert.equal(creation.workspace, "w-test");
	assert.equal(creation.pane, "");
	const launcher = f.calls().find((call) => call.args[1] === "run");
	assert.match(launcher.args[3], /^exec \/bin\/sh /);
	await withEnv(f.env, () => {
		assert.equal(terminalIsRunning(run), true);
		focusHerdrTerminal(run);
	});
	assert.deepEqual(f.calls().at(-1).args, ["agent", "focus", "w-subagents:p1"]);
});

test("launcher preserves literal prompts, paths, isolation flags and the parent's model scope", () => {
	const f = fixture();
	const capture = join(f.dir, "argv.json");
	writeFileSync(join(f.dir, "pi-test.sh"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({argv:process.argv.slice(2),scope:process.env.PI_SUBAGENT_SCOPED_MODELS,agentDir:process.env.PI_CODING_AGENT_DIR,runDir:process.env.PI_SUBAGENT_RUN_DIR}));\n`, { mode: 0o700 });
	const prompt = "quoted ' text\n$(touch SHOULD_NOT_EXIST); unicode: ação";
	const result = f.spawn(["--prompt", prompt, "--no-extensions", "--no-skills", "--tools", "read"]);
	assert.equal(result.status, 0, result.stderr);
	const run = f.run();
	const launch = spawnSync("/bin/sh", [join(run.runDir, "launch.sh")], { env: { ...f.env, [MODEL_SCOPE_ENV]: "wrong-server-scope" }, encoding: "utf8", cwd: f.dir });
	assert.equal(launch.status, 0, launch.stderr);
	const args = JSON.parse(readFileSync(capture, "utf8"));
	assert.equal(args.argv.at(-1), `Task:\ntest\n\n${prompt}`);
	assert.equal(args.scope, JSON.stringify(scope));
	assert.equal(args.runDir, run.runDir);
	assert.equal(args.agentDir, f.env.PI_CODING_AGENT_DIR);
	assert.equal(args.argv[args.argv.indexOf("--models") + 1], "provider-a/model-one:high");
	assert.equal(args.argv[args.argv.indexOf("--thinking") + 1], "high");
	assert.ok(args.argv.includes("--extension"));
	assert.ok(args.argv.includes("--no-skills"));
	assert.equal(existsSync(join(f.dir, "SHOULD_NOT_EXIST")), false);
});

test("native send/wait/stop use durable state and close only the owned pane", () => {
	const f = fixture();
	assert.equal(f.spawn().status, 0);
	const run = f.run();
	updateMetadata(run.runDir, { state: "idle", hasStarted: true });
	assert.equal(f.cli(["send", run.handle, "follow up"]).status, 0);
	const inbox = join(run.runDir, "inbox");
	assert.equal(readdirSync(inbox).length, 1);
	rmSync(join(inbox, readdirSync(inbox)[0]));
	writeFileSync(run.sessionFile, JSON.stringify({ type: "message", id: "reply", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "DURABLE_RESULT" }] } }) + "\n");
	assert.match(f.cli(["wait", run.handle, "--timeout", "1"]).stdout, /DURABLE_RESULT/);
	const state = JSON.parse(readFileSync(f.stateFile, "utf8"));
	state.panes.push({ pane_id: "w-test:unowned", tab_id: run.herdr!.tabId });
	writeFileSync(f.stateFile, JSON.stringify(state));
	const stopped = f.cli(["stop", run.handle]);
	assert.equal(stopped.status, 0, stopped.stderr);
	assert.equal(existsSync(run.runDir), false);
	assert.deepEqual(JSON.parse(readFileSync(f.stateFile, "utf8")).panes, [{ pane_id: "w-test:unowned", tab_id: run.herdr!.tabId }]);
	assert.equal(f.calls().some((c) => c.tmux), false);
});

test("server failures retain run metadata; launch failures clean their owned pane", async () => {
	const f = fixture();
	assert.equal(f.spawn().status, 0);
	const run = f.run();
	const stopped = f.cli(["stop", run.handle], { FAKE_FAIL: "pane list" });
	assert.notEqual(stopped.status, 0);
	assert.equal(existsSync(run.runDir), true);
	await withEnv({ ...f.env, FAKE_FAIL: "pane list" }, () => assert.equal(effectiveRunState(run), "error"));
	const failed = fixture();
	assert.notEqual(failed.spawn([], { FAKE_FAIL: "pane run" }).status, 0);
	assert.equal(readdirSync(failed.runsDir).length, 0);
	assert.deepEqual(JSON.parse(readFileSync(failed.stateFile, "utf8")).panes, []);
});

test("suspended native runs keep their recorded workspace without replaying the original prompt", async () => {
	const f = fixture();
	assert.equal(f.spawn().status, 0);
	let run = f.run();
	await withEnv(f.env, async () => {
		updateMetadata(run.runDir, { suspended: true });
		stopTerminal(run);
		assert.equal(terminalIsRunning(run), false);
		run = updateMetadata(run.runDir, { state: "starting" })!;
		await launchRun(run);
	});
	run = f.run();
	assert.equal(run.herdr!.paneId, "w-subagents:p2");
	assert.doesNotMatch(readFileSync(join(run.runDir, "launch.sh"), "utf8"), /Task:/);
	assert.match(readFileSync(join(run.runDir, "launch.sh"), "utf8"), /--session/);
});

test("legacy metadata and new runs outside Herdr continue using tmux", async () => {
	const f = fixture();
	const result = f.spawn([], { HERDR_ENV: "" });
	assert.equal(result.status, 0, result.stderr);
	const run = f.run();
	assert.equal(run.backend, "tmux");
	delete run.backend;
	writeMetadata(run);
	await withEnv(f.env, () => {
		assert.equal(terminalIsRunning(readMetadata(run.runDir)!), true);
		assert.match(attachCommand(run), /^tmux attach/);
		stopTerminal(run);
	});
	assert.ok(f.calls().every((c) => c.tmux));
});

test("moving the owned terminal follows its identity; reused pane IDs never target another terminal", async () => {
	const f = fixture();
	assert.equal(f.spawn().status, 0);
	const run = f.run();
	const state = JSON.parse(readFileSync(f.stateFile, "utf8"));
	Object.assign(state.panes[0], { pane_id: "w-other:p9", tab_id: "w-other:t8", workspace_id: "w-other" });
	writeFileSync(f.stateFile, JSON.stringify(state));
	await withEnv(f.env, () => {
		assert.equal(terminalIsRunning(run), true);
		focusHerdrTerminal(run);
		assert.equal(f.calls().at(-1).args[2], "w-other:p9");
		assert.equal(f.calls().at(-1).workspace, "w-other");
		stopTerminal(run);
	});
	assert.deepEqual(JSON.parse(readFileSync(f.stateFile, "utf8")).panes, []);

	const original = f.run();
	writeFileSync(f.stateFile, JSON.stringify({ next: 1, panes: [{
		pane_id: original.herdr!.paneId, tab_id: original.herdr!.tabId,
		workspace_id: original.herdr!.workspaceId, terminal_id: "different-server-terminal",
	}] }));
	await withEnv(f.env, () => {
		assert.equal(terminalIsRunning(original), false);
		stopTerminal(original);
	});
	assert.equal(JSON.parse(readFileSync(f.stateFile, "utf8")).panes.length, 1);
});

test("uncertain workspace creation retains a recovery record instead of deleting it or retrying blindly", async () => {
	const f = fixture();
	const result = f.spawn([], { FAKE_FAIL: "workspace create" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /run retained/);
	const run = f.run();
	assert.equal(run.herdr!.creationPending, true);
	assert.equal(run.state, "error");
	assert.doesNotMatch(attachCommand(run), /tmux/);
	await withEnv(f.env, () => {
		assert.throws(() => terminalIsRunning(run), /uncertain/);
		assert.throws(() => stopTerminal(run), /uncertain/);
	});
});

test("new runs reuse the marked workspace and leave a name lookalike alone", () => {
	const f = fixture();
	const state = JSON.parse(readFileSync(f.stateFile, "utf8"));
	state.workspaces.push({ workspace_id: "w-unrelated", label: "Subagents" });
	writeFileSync(f.stateFile, JSON.stringify(state));
	assert.equal(f.spawn().status, 0);
	const placed = JSON.parse(readFileSync(f.stateFile, "utf8"));
	placed.workspaces.find((workspace) => workspace.workspace_id === "w-subagents").label = "renamed";
	writeFileSync(f.stateFile, JSON.stringify(placed));
	assert.equal(f.spawn().status, 0);
	const latest = JSON.parse(readFileSync(f.stateFile, "utf8"));
	assert.equal(latest.workspaces.length, 3);
	assert.deepEqual(latest.panes.map((pane) => pane.workspace_id), ["w-subagents", "w-subagents"]);
});

test("resume does not use an unrelated workspace with the old dedicated ID", async () => {
	const f = fixture();
	assert.equal(f.spawn().status, 0);
	const spawned = f.run();
	const state = JSON.parse(readFileSync(f.stateFile, "utf8"));
	state.workspaces.push({ workspace_id: "w-recycled" });
	writeFileSync(f.stateFile, JSON.stringify(state));
	const run = updateMetadata(spawned.runDir, { herdr: {
		...spawned.herdr!, workspaceId: "w-recycled", subagentsWorkspaceId: "w-recycled",
	} })!;
	await withEnv(f.env, () => launchRun(run));
	assert.equal(f.run().herdr?.workspaceId, "w-subagents");
});

test("uncertain tab creation preserves the run even in an existing workspace", () => {
	const f = fixture();
	assert.equal(f.spawn().status, 0);
	const result = f.spawn([], { FAKE_FAIL: "tab create" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /run retained/);
	const runs = readdirSync(f.runsDir).map((handle) => readMetadata(join(f.runsDir, handle)));
	assert.equal(runs.filter((run) => run?.herdr?.creationPending && run.state === "error").length, 1);
});

test("Herdr context fails closed and unlisted models never create a pane", async () => {
	await withEnv({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "" }, () => assert.throws(currentHerdrTerminal, /requires/));
	const f = fixture();
	assert.notEqual(f.spawn(["--model", "unlisted"]).status, 0);
	assert.notEqual(f.spawn([], { [MODEL_SCOPE_ENV]: "[]" }).status, 0);
	assert.deepEqual(f.calls(), []);
});
