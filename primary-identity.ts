import { readlinkSync } from "node:fs";
import { rawRequest, type Request } from "./herdr-api.ts";

type Pane = { pane_id: string; terminal_id: string };

/** Prove local ownership without trusting a potentially stale inherited pane ID. */
export async function identifyPrimaryTerminal(
	socket: string, panes: Pane[], request: Request = rawRequest,
	readlink: (path: string) => string = readlinkSync, pid = process.pid,
): Promise<string> {
	let tty: string;
	try { tty = readlink("/proc/self/fd/0"); } catch { throw new Error("no stable terminal identity available"); }
	if (!tty.startsWith("/dev/") || panes.length > 128) throw new Error("cannot safely resolve terminal TTY");
	const info = await Promise.all(panes.map((pane) => request(socket, "pane.process_info", { pane_id: pane.pane_id })));
	const matches = panes.filter((pane, index) => {
		const processInfo = info[index].process_info;
		if (processInfo?.pane_id !== pane.pane_id || !Number.isSafeInteger(processInfo.shell_pid) || !Array.isArray(processInfo.foreground_processes) || !processInfo.foreground_processes.some((p: { pid: number }) => p.pid === pid)) return false;
		try { return readlink(`/proc/${processInfo.shell_pid}/fd/0`) === tty; } catch { return false; }
	});
	if (matches.length !== 1 || !matches[0].terminal_id) throw new Error("current terminal process/TTY not uniquely identified");
	return matches[0].terminal_id;
}

// Injectable at the boundary for lifecycle tests; production always uses local process evidence.
export const primaryIdentity = { identify: identifyPrimaryTerminal };
