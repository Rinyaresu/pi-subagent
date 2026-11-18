import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { launchRun, listRuns, readMetadata, updateMetadata, waitForRunShutdown, writeMetadata, type RunMetadata } from "./shared.ts";
import { focusHerdrTerminal, herdrCall, stopTerminal, terminalIsRunning } from "./terminal.ts";
import { MODEL_SCOPE_ENV } from "./model-scope.ts";

// Opt-in: a real isolated headless Herdr plus a real idle Pi. No model request is sent.
test("real Herdr keeps new Pi children in a separate workspace and preserves their lifecycle", {
	skip: process.env.PI_SUBAGENT_HERDR_LIVE !== "1", timeout: 60_000,
}, async () => {
	const artifacts = join(homedir(), ".local/state/pi/work-artifacts/pi-subagent");
	mkdirSync(artifacts, { recursive: true });
	const dir = mkdtempSync(join(artifacts, "live-"));
	const config = join(dir, "config.toml");
	writeFileSync(config, 'onboarding = false\n[terminal]\ndefault_shell = "/bin/bash"\n[update]\nversion_check = false\nmanifest_check = false\n');
	// State lives under artifacts; a temporary symlink keeps Unix socket names below sun_path limits.
	const alias = mkdtempSync(join(tmpdir(), "pi-herdr-"));
	symlinkSync(dir, join(alias, "xdg"), "dir");
	const session = basename(alias);
	const agentDir = join(dir, "agent");
	const otherAgentDir = join(dir, "other-agent");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(otherAgentDir);
	symlinkSync(join(agentDir, "extensions"), join(otherAgentDir, "extensions"), "dir");
	const env = {
		...process.env, XDG_CONFIG_HOME: join(alias, "xdg"), XDG_STATE_HOME: join(dir, "state"),
		HERDR_CONFIG_PATH: config, HERDR_SOCKET_PATH: "", HERDR_ENV: "", HERDR_SESSION: "",
		PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_RUN_DIR: "", OPENAI_API_KEY: "idle-test-only",
	};
	const integration = spawnSync("herdr", ["integration", "install", "pi"], { env, encoding: "utf8", timeout: 5000 });
	assert.equal(integration.status, 0, integration.stderr);
	const server = spawn("herdr", ["--session", session, "server"], { env, stdio: ["ignore", "pipe", "pipe"] });
	let serverLog = "";
	server.stderr!.on("data", (data) => { serverLog += data; });
	server.stdout!.on("data", (data) => { serverLog += data; });
	let run: RunMetadata | undefined;
	const previousScope = process.env[MODEL_SCOPE_ENV];
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		let socketPath: string | undefined;
		for (let i = 0; i < 100; i++) {
			const status = spawnSync("herdr", ["--session", session, "status", "--json"], { env, encoding: "utf8" });
			if (status.status === 0) {
				const parsed = JSON.parse(status.stdout);
				if (parsed.server?.running) {
					const ready = spawnSync("herdr", ["--session", session, "workspace", "list"], { env, encoding: "utf8", timeout: 1000 });
					if (ready.status === 0) { socketPath = parsed.server.socket; break; }
				}
			}
			if (server.exitCode !== null) throw new Error(`Test server exited: ${serverLog}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(socketPath, `Test server did not start: ${serverLog}`);
		const context = { socketPath, workspaceId: "" };
		const created = herdrCall<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(context,
			["workspace", "create", "--cwd", dir, "--label", "subagent-test", "--focus"]);
		context.workspaceId = created.workspace.workspace_id;
		const parentPane = created.root_pane.pane_id;
		const scope = JSON.stringify([{ provider: "openai", id: "gpt-4o" }]);
		process.env[MODEL_SCOPE_ENV] = scope;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(dir, "pi-test.sh"),
			'#!/bin/bash\nargs=("$@")\nif [[ "${!#}" == Task:* ]]; then unset \'args[-1]\'; fi\nexec pi --extension "$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts" "${args[@]}"\n', { mode: 0o700 });
		const exec = promisify(execFile);
		const cli = (piDir: string, name: string) => exec(process.execPath, [
			fileURLToPath(new URL("./subagent.ts", import.meta.url)), "spawn", "--name", name, "--thinking", "off",
			"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--prompt", "Not sent to a model",
		], {
			cwd: dir, timeout: 25_000,
			env: { ...env, PI_CODING_AGENT_DIR: piDir, [MODEL_SCOPE_ENV]: scope, HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath,
				HERDR_WORKSPACE_ID: context.workspaceId, HERDR_PANE_ID: parentPane, PI_SESSION_ID: "smoke-parent",
				PI_SESSION_FILE: "", PI_PROVIDER: "openai", PI_MODEL: "gpt-4o", PI_THINKING: "off" },
		});
		const workspaces = () => herdrCall<{ workspaces: { workspace_id: string; label: string; focused: boolean; tab_count: number }[] }>(
			context, ["workspace", "list"]).workspaces;
		await Promise.all([cli(agentDir, "first"), cli(otherAgentDir, "second")]);
		const firstRuns = listRuns("smoke-parent");
		process.env.PI_CODING_AGENT_DIR = otherAgentDir;
		const spawned = [...firstRuns, ...listRuns("smoke-parent")];
		assert.equal(spawned.length, 2);
		const layout = workspaces();
		const parent = layout.find((workspace) => workspace.workspace_id === context.workspaceId);
		assert.equal(parent?.tab_count, 1, "New children must not add tabs to the parent workspace");
		assert.equal(parent?.focused, true);
		const dedicated = layout.filter((workspace) => workspace.label === "Subagents");
		assert.equal(dedicated.length, 1);
		assert.equal(dedicated[0].tab_count, 2);
		assert.ok(spawned.every((child) => child.herdr?.workspaceId === dedicated[0].workspace_id));
		[run] = spawned;
		const sibling = spawned[1];
		for (let i = 0; i < 200; i++) {
			const current = readMetadata(run!.runDir)!;
			if (current.childSessionId && current.state === "idle") break;
			if (i === 199) {
				const output = herdrCall(run.herdr!, ["pane", "read", run.herdr!.paneId!, "--lines", "40"]);
				throw new Error(`Pi did not become idle: ${JSON.stringify(current)}; ${JSON.stringify(output)}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.equal(terminalIsRunning(run), true);
		const getPane = () => herdrCall<{ pane: { focused: boolean; agent: string; tokens?: Record<string, string> } }>(
			run!.herdr!, ["pane", "get", run!.herdr!.paneId!]).pane;
		for (let i = 0; i < 50 && getPane().tokens?.pi_role !== "subagent"; i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		writeFileSync(join(dir, "pane.json"), JSON.stringify(getPane(), null, 2));
		assert.equal(getPane().tokens?.pi_role, "subagent");
		focusHerdrTerminal(run);
		assert.equal(getPane().focused, true);
		assert.equal(getPane().agent, "pi");
		const originalPaneId = run.herdr!.paneId!;
		herdrCall(run.herdr!, ["pane", "move", originalPaneId!, "--new-workspace", "--no-focus"]);
		assert.equal(terminalIsRunning(run), true);
		assert.notEqual(run.herdr!.paneId, originalPaneId);
		focusHerdrTerminal(run);
		stopTerminal(run);
		assert.equal(terminalIsRunning(run), false);
		const remaining = herdrCall<{ panes: { pane_id: string }[] }>(context, ["pane", "list"]).panes;
		assert.ok(remaining.some((pane) => pane.pane_id === parentPane));
		assert.equal(terminalIsRunning(sibling), true);
		const previousWorkspace = sibling.herdr!.workspaceId;
		updateMetadata(sibling.runDir, { suspended: true });
		stopTerminal(sibling);
		await waitForRunShutdown(sibling.runDir);
		assert.ok(!workspaces().some((workspace) => workspace.workspace_id === previousWorkspace));
		const resume = updateMetadata(sibling.runDir, { state: "starting" })!;
		await launchRun(resume);
		assert.notEqual(resume.herdr!.workspaceId, previousWorkspace);
		assert.equal(workspaces().find((workspace) => workspace.workspace_id === resume.herdr!.workspaceId)?.label, "Subagents");
		assert.equal(terminalIsRunning(resume), true);
		stopTerminal(resume);
		writeFileSync(join(dir, "result.json"), JSON.stringify({ parentTabs: parent?.tab_count, childTabs: dedicated[0].tab_count, resumed: true }, null, 2));

		// A launcher that exits without Pi's shutdown hook must not look alive forever.
		writeFileSync(join(dir, "pi-test.sh"), "#!/bin/sh\nexit 17\n", { mode: 0o700 });
		run.herdr = { ...run.herdr!, workspaceId: context.workspaceId };
		writeMetadata({ ...run, state: "starting" });
		await launchRun(run);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(terminalIsRunning(run), false, "Crashed terminal must not remain running");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousScope === undefined) delete process.env[MODEL_SCOPE_ENV];
		else process.env[MODEL_SCOPE_ENV] = previousScope;
		try { if (run) stopTerminal(run); } catch { /* Stop only the isolated server below. */ }
		spawnSync("herdr", ["--session", session, "server", "stop"], { env, stdio: "ignore", timeout: 5000 });
		if (server.exitCode === null) {
			server.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				server.once("exit", () => resolve());
				setTimeout(resolve, 2000).unref();
			});
		}
		rmSync(alias, { recursive: true, force: true });
		writeFileSync(join(dir, "server.log"), serverLog);
	}
});
