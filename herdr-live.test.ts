import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { launchRun, readMetadata, writeMetadata, type RunMetadata } from "./shared.ts";
import { focusHerdrTerminal, herdrCall, stopTerminal, terminalIsRunning } from "./terminal.ts";
import { MODEL_SCOPE_ENV } from "./model-scope.ts";

// Opt-in: a real isolated headless Herdr plus a real idle Pi. No model request is sent.
test("real Herdr launches an idle Pi natively, focuses it, and closes only its pane", {
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
	const session = "smoke";
	const env = { ...process.env, XDG_CONFIG_HOME: join(alias, "xdg"), HERDR_CONFIG_PATH: config, HERDR_SOCKET_PATH: "", HERDR_ENV: "", HERDR_SESSION: "" };
	const server = spawn("herdr", ["--session", session, "server"], { env, stdio: ["ignore", "pipe", "pipe"] });
	let serverLog = "";
	server.stderr!.on("data", (data) => { serverLog += data; });
	server.stdout!.on("data", (data) => { serverLog += data; });
	let run: RunMetadata | undefined;
	const previousScope = process.env[MODEL_SCOPE_ENV];
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
			["workspace", "create", "--cwd", dir, "--label", "subagent-test", "--no-focus"]);
		context.workspaceId = created.workspace.workspace_id;
		const parentPane = created.root_pane.pane_id;
		const scope = [{ provider: "codex-rotator", id: "gpt-6-luna" }];
		process.env[MODEL_SCOPE_ENV] = JSON.stringify(scope);
		const runDir = join(dir, "run");
		mkdirSync(runDir);
		run = {
			version: 1, backend: "herdr", herdr: context, handle: "live-test",
			tmuxSession: "unused-native-test", runDir, sessionFile: join(runDir, "session.jsonl"), cwd: dir,
			provider: "codex-rotator", model: "gpt-6-luna", thinking: "low",
			launchArgs: ["--no-skills", "--no-prompt-templates", "--no-context-files"],
			state: "starting", hasStarted: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		};
		writeFileSync(run.sessionFile, "");
		writeMetadata(run);
		launchRun(run);
		for (let i = 0; i < 200; i++) {
			const current = readMetadata(runDir)!;
			if (current.childSessionId && current.state === "idle") break;
			if (i === 199) {
				const output = herdrCall(run.herdr!, ["pane", "read", run.herdr!.paneId!, "--lines", "40"]);
				throw new Error(`Pi did not become idle: ${JSON.stringify(current)}; ${JSON.stringify(output)}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.equal(terminalIsRunning(run), true);
		focusHerdrTerminal(run);
		const pane = herdrCall<{ pane: { focused: boolean; agent: string } }>(run.herdr!, ["pane", "get", run.herdr!.paneId!]).pane;
		assert.equal(pane.focused, true);
		assert.equal(pane.agent, "pi");
		const originalPaneId = run.herdr!.paneId;
		herdrCall(run.herdr!, ["pane", "move", originalPaneId!, "--new-workspace", "--no-focus"]);
		assert.equal(terminalIsRunning(run), true);
		assert.notEqual(run.herdr!.paneId, originalPaneId);
		focusHerdrTerminal(run);
		stopTerminal(run);
		assert.equal(terminalIsRunning(run), false);
		const remaining = herdrCall<{ panes: { pane_id: string }[] }>(context, ["pane", "list"]).panes;
		assert.ok(remaining.some((pane) => pane.pane_id === parentPane));
		writeFileSync(join(dir, "result.json"), JSON.stringify({ ok: true, socketPath, child: readMetadata(runDir), parentPane }, null, 2));
		// A launcher that exits without Pi's shutdown hook must not look alive forever.
		writeFileSync(join(dir, "pi-test.sh"), "#!/bin/sh\nexit 17\n", { mode: 0o700 });
		run.herdr = { ...run.herdr!, workspaceId: context.workspaceId };
		writeMetadata({ ...run, state: "starting" });
		launchRun(run);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(terminalIsRunning(run), false, "Crashed terminal must not remain running");
	} finally {
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
