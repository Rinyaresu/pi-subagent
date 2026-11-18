import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { MODEL_SCOPE_ENV, modelScopePrompt, readModelScope, requireScopedModel } from "./model-scope.ts";

import { launchRun, type RunMetadata } from "./shared.ts";

const root = dirname(fileURLToPath(import.meta.url));
const scope = [
	{ provider: "provider-a", id: "model-one", thinkingLevel: "high" },
	{ provider: "provider-b", id: "model-two" },
];

function spawn(args: string[], env: Record<string, string | undefined>) {
	return spawnSync(process.execPath, [join(root, "subagent.ts"), "spawn", "--prompt", "test", ...args], {
		encoding: "utf8",
		env: { ...process.env, HERDR_ENV: "", PI_SUBAGENT_RUN_DIR: "", PI_PROVIDER: "provider-a", PI_MODEL: "model-one", ...env },
	});
}

test("scope validation and model guidance", async () => {
	const previous = process.env[MODEL_SCOPE_ENV];
	try {
		delete process.env[MODEL_SCOPE_ENV];
		assert.throws(readModelScope, /unavailable/);
		process.env[MODEL_SCOPE_ENV] = "[]";
		assert.throws(readModelScope, /requires Scoped Models/);
		process.env[MODEL_SCOPE_ENV] = '[{"provider":42}]';
		assert.throws(readModelScope, /Invalid/);
		process.env[MODEL_SCOPE_ENV] = JSON.stringify(scope);
		assert.equal(requireScopedModel("provider-a", "model-one").thinkingLevel, "high");
		assert.throws(() => requireScopedModel("provider-b", "model-one"), /outside/);
		await assert.rejects(launchRun({ provider: "provider-a", model: "removed-model" } as RunMetadata), /outside/);
		assert.match(modelScopePrompt(scope), /provider-b\/model-two/);
		assert.match(modelScopePrompt([]), /blocked/);
	} finally {
		if (previous === undefined) delete process.env[MODEL_SCOPE_ENV];
		else process.env[MODEL_SCOPE_ENV] = previous;
	}
});

test("CLI enforces the parent scope before launch and passes it to children", () => {
	const artifacts = join(homedir(), ".local/state/pi/work-artifacts/pi-subagent");
	mkdirSync(artifacts, { recursive: true });
	const run = mkdtempSync(join(artifacts, "scope-test-"));
	const capture = join(run, "launch.json");
	writeFileSync(join(run, "tmux"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
	const env = {
		PI_CODING_AGENT_DIR: join(run, "agent"),
		PATH: `${run}:${process.env.PATH}`,
		CAPTURE: capture,
		[MODEL_SCOPE_ENV]: JSON.stringify(scope),
	};
	for (const args of [
		["--model", "unlisted"],
		["--provider", "provider-b"],
	]) {
		const result = spawn(args, env);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /outside the parent session's Scoped Models/);
	}
	assert.match(spawn([], { ...env, [MODEL_SCOPE_ENV]: undefined }).stderr, /unavailable/);
	assert.match(spawn([], { ...env, [MODEL_SCOPE_ENV]: "[]" }).stderr, /requires Scoped Models/);
	assert.match(spawn([], { ...env, PI_MODEL: "unlisted" }).stderr, /outside/);
	assert.equal(existsSync(capture), false, "Rejected models must not start tmux");

	for (const [args, expectedThinking] of [[[], "high"], [["--thinking", "low"], "low"]] as const) {
		const result = spawn([...args], env);
		assert.equal(result.status, 0, result.stderr);
		const launched: string[] = JSON.parse(readFileSync(capture, "utf8"));
		assert.equal(launched[launched.indexOf("--models") + 1], "provider-a/model-one:high,provider-b/model-two");
		assert.equal(launched[launched.indexOf("--thinking") + 1], expectedThinking);
	}
	const result = spawn(["--provider", "provider-b", "--model", "model-two"], env);
	assert.equal(result.status, 0, result.stderr);
});
