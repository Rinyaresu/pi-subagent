import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { test } from "node:test";
import { rawRequest } from "./herdr-api.ts";

test("public transport decodes split UTF-8 and rejects errors or mismatched request IDs", async () => {
	const base = join(homedir(), ".local/state/pi/work-artifacts/pi-subagent/metadata-api");
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "socket-"));
	for (const mode of ["unicode", "error", "wrong-id", "early-close"] as const) {
		const path = join(dir, `${mode}.sock`);
		const server = createServer(socket => socket.once("data", data => {
			const request = JSON.parse(data.toString());
			assert.equal(request.method, "ping");
			if (mode === "early-close") { socket.end(); return; }
			const response = mode === "error" ? { id: request.id, error: { code: "unknown_method" } } : { id: mode === "wrong-id" ? "foreign" : request.id, result: { label: "題" } };
			const bytes = Buffer.from(JSON.stringify(response) + "\n");
			const offset = bytes.indexOf(Buffer.from("題")) + 1;
			if (mode === "unicode") { socket.write(bytes.subarray(0, offset)); setTimeout(() => socket.end(bytes.subarray(offset)), 10); }
			else socket.end(bytes);
		}));
		await new Promise<void>(resolve => server.listen(path, resolve));
		try {
			if (mode === "unicode") assert.deepEqual(await rawRequest(path, "ping", {}), { label: "題" });
			else await assert.rejects(rawRequest(path, "ping", {}), mode === "early-close" ? /closed without/ : /rejected/);
		} finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
	}
});
