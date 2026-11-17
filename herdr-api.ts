import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";

export type Request = (socket: string, method: string, params: object) => Promise<any>;

/** Newline-framed public JSON API; no dependency on private client wire codecs. */
export const rawRequest: Request = (path, method, params) => new Promise((resolve, reject) => {
	const endpoint = process.platform === "win32" && !path.startsWith("\\\\.\\pipe\\") ? `\\\\.\\pipe\\${path}` : path;
	const socket = createConnection(endpoint);
	const id = `pi-subagent-${process.pid}-${Math.random().toString(36).slice(2)}`;
	let data = "";
	const decoder = new StringDecoder("utf8");
	let done = false;
	const deadline = setTimeout(() => finish(new Error("Herdr JSON API timeout")), 1500);
	const finish = (error?: Error, value?: unknown) => {
		if (done) return;
		done = true;
		clearTimeout(deadline);
		socket.destroy();
		if (error) reject(error); else resolve(value);
	};
	socket.on("error", (error) => finish(error));
	socket.on("end", () => finish(new Error("Herdr JSON API closed without response")));
	socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
	socket.on("data", (chunk) => {
		data += decoder.write(chunk);
		if (data.length > 2_000_000) return finish(new Error("Herdr JSON response too large"));
		const newline = data.indexOf("\n");
		if (newline < 0) return;
		try {
			const response = JSON.parse(data.slice(0, newline));
			if (response.id !== id || response.error || !response.result || typeof response.result !== "object") {
				return finish(new Error(`Herdr JSON API rejected ${method}: ${JSON.stringify(response.error ?? response)}`));
			}
			finish(undefined, response.result);
		} catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
	});
});
