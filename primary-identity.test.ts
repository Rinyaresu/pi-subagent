import assert from "node:assert/strict";
import { test } from "node:test";
import { identifyPrimaryTerminal } from "./primary-identity.ts";

const panes = [{ pane_id: "stale", terminal_id: "other" }, { pane_id: "moved", terminal_id: "ours" }];
const tty = (path: string) => path === "/proc/10/fd/0" ? "/dev/pts/other" : "/dev/pts/ours";

test("identifies our moved terminal from foreground PID and local shell TTY", async () => {
	const request = async (_socket: string, method: string, params: any) => {
		assert.equal(method, "pane.process_info");
		const ours = params.pane_id === "moved";
		return { process_info: { pane_id: params.pane_id, shell_pid: ours ? 20 : 10, foreground_processes: [{ pid: ours ? 42 : 43 }] } };
	};
	assert.equal(await identifyPrimaryTerminal("server", panes, request, tty, 42), "ours");
});

test("fails closed for ambiguous ownership, missing tty, or incomplete server replies", async () => {
	const ambiguous = async (_s: string, _m: string, p: any) => ({ process_info: { pane_id: p.pane_id, shell_pid: 20, foreground_processes: [{ pid: 42 }] } });
	await assert.rejects(identifyPrimaryTerminal("server", panes, ambiguous, tty, 42), /not uniquely/);
	await assert.rejects(identifyPrimaryTerminal("server", panes, ambiguous, () => { throw Error("no tty"); }, 42), /no stable/);
	const incomplete = async (_s: string, _m: string, p: any) => { if (p.pane_id === "stale") throw Error("unavailable"); return ambiguous(_s, _m, p); };
	await assert.rejects(identifyPrimaryTerminal("server", panes, incomplete, tty, 42), /unavailable/);
});
