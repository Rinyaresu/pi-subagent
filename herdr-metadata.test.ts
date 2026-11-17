import assert from "node:assert/strict";
import { test } from "node:test";
import { createMetadataPublisher, metadataFields, metadataSessionKey, METADATA_TTL_MS, type MetadataContext } from "./herdr-metadata.ts";
import type { HerdrTerminal } from "./terminal.ts";

const context: MetadataContext = { agent: "pi", role: "subagent", session: { id: "child", path: "/child.jsonl" }, parent_session: { agent: "pi", id: "parent", path: "/parent.jsonl" }, task_name: "investigate", run_id: "abcdef" };
function fixture() {
	const terminal: HerdrTerminal = { socketPath: "official.sock", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", terminalId: "stable" };
	const pane: any = { pane_id: "w2:p8", terminal_id: "stable", workspace_id: "w2", tab_id: "w2:t9", agent: "pi", agent_status: "blocked", agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: "/child.jsonl" }, tokens: {} };
	const parent: any = { pane_id: "w1:p9", terminal_id: "parent-terminal", agent: "pi", agent_session: { source: "herdr:pi", agent: "pi", kind: "path", value: "/parent.jsonl" } };
	const panes = [pane, parent];
	const calls: { method: string; params: any }[] = [];
	const request = async (_socket: string, method: string, params: any) => {
		calls.push({ method, params });
		if (method === "pane.list") return { panes: structuredClone(panes) };
		if (method === "pane.get") return { pane: structuredClone(pane) };
		assert.equal(method, "pane.report_metadata");
		pane.display_agent = params.display_agent;
		for (const [key, value] of Object.entries(params.tokens)) if (value === null) delete pane.tokens[key]; else pane.tokens[key] = value;
		return { type: "ok" };
	};
	return { terminal, pane, parent, panes, calls, request };
}

test("official metadata follows stable terminal without changing state, identity, focus or sound", async () => {
	const f = fixture();
	const originalSession = structuredClone(f.pane.agent_session);
	assert.equal(await createMetadataPublisher(f.request).publish(f.terminal, context), true);
	assert.equal(f.terminal.paneId, "w2:p8");
	assert.equal(f.terminal.workspaceId, "w2");
	assert.equal(f.pane.agent, "pi");
	assert.equal(f.pane.agent_status, "blocked");
	assert.deepEqual(f.pane.agent_session, originalSession);
	assert.match(f.pane.display_agent, /^pi subagent \[p:[a-f0-9]{8}\] investigate$/);
	assert.deepEqual(f.calls.map(c => c.method), ["pane.list", "pane.get", "pane.report_metadata", "pane.get"]);
	const params = f.calls[2].params;
	assert.equal(params.applies_to_source, "herdr:pi");
	assert.equal(params.ttl_ms, METADATA_TTL_MS);
	for (const forbidden of ["state", "state_labels", "title", "completion_sound", "parent_session", "expected_terminal_id"]) assert.equal(forbidden in params, false);
});

test("metadata uses bounded opaque identity rather than leaking or truncating session paths", () => {
	const path = "/private/" + "long/".repeat(100) + "session.jsonl";
	const fields = metadataFields({ ...context, session: { path }, parent_session: { agent: "pi", path }, task_name: "\n" + "題".repeat(120) + "\u0007" });
	assert.equal(fields.tokens.pi_session_key.length, 64);
	assert.equal(fields.tokens.pi_parent_key, fields.tokens.pi_session_key);
	assert.equal(Array.from(fields.tokens.pi_task!).length, 80);
	assert.ok(Array.from(fields.display_agent).length <= 80);
	assert.equal(JSON.stringify(fields).includes("private"), false);
	assert.equal(metadataSessionKey({ id: "parent", path }), metadataSessionKey({ id: "parent" }));
	assert.notEqual(metadataSessionKey({ id: path }), metadataSessionKey({ path }));
	assert.throws(() => metadataFields({ ...context, session: {} }), /identity/);
});

test("primary presentation explicitly clears stale child tokens", async () => {
	const f = fixture();
	Object.assign(f.pane.tokens, { pi_parent_key: "old", pi_run_id: "old", unrelated: "keep" });
	assert.equal(await createMetadataPublisher(f.request).publish(f.terminal, { agent: "pi", role: "primary", session: context.session }), true);
	assert.equal(f.pane.tokens.pi_parent_key, undefined);
	assert.equal(f.pane.tokens.pi_run_id, undefined);
	assert.equal(f.pane.tokens.unrelated, "keep");
});

test("Algorant aliases use the exact native path tuple, independently of pi ID hashes", async () => {
	const f = fixture();
	f.pane.agent_session.value = "/tmp/session.jsonl";
	const current = { ...context, session: { id: "child", path: "/tmp/session.jsonl" } };
	assert.equal(await createMetadataPublisher(f.request).publish(f.terminal, current), true);
	assert.equal(f.pane.tokens.role, "subagent");
	assert.equal(f.pane.tokens.agency_self, "82985f7d63b627e59d1c5e6386576a0a39a378bfa8ab86bc4e59ef720d8970e3");
	assert.equal(f.pane.tokens.agency_parent, "fc2d06ab2f4f5e87982c6896aa35720278ac7d9628e97d0558a8833b91e7dd88");
	for (const [name, value] of Object.entries(metadataFields(current).tokens)) {
		assert.equal(f.pane.tokens[name], value ?? undefined);
	}
	assert.notEqual(f.pane.tokens.agency_self, f.pane.tokens.pi_session_key);
	assert.notEqual(f.pane.tokens.agency_parent, f.pane.tokens.pi_parent_key);
	assert.equal(f.pane.tokens.agency_lead, undefined);
	assert.equal(f.calls.filter(c => c.method === "pane.report_metadata").length, 1);
	assert.equal(f.calls[2].params.ttl_ms, METADATA_TTL_MS);
	assert.equal(Object.keys(f.calls[2].params.tokens).length, 8);
});

test("aliases preserve raw path spelling and do not resolve IDs, normalize or leak paths", async () => {
	const f = fixture();
	const publisher = createMetadataPublisher(f.request);
	const hashes = [];
	for (const path of ["/a/../b", "/b", "/a//b", "/a/b", "/TMP/題\\\".jsonl"]) {
		f.pane.agent_session.value = path;
		assert.equal(await publisher.publish(f.terminal, { ...context, session: { id: "same-id", path } }), true);
		hashes.push(f.pane.tokens.agency_self);
		assert.equal(JSON.stringify(f.pane.tokens).includes(path), false);
	}
	assert.equal(new Set(hashes).size, hashes.length);
});

test("missing, relative, ID-only, self and ambiguous references clear aliases, not pi tokens", async () => {
	const cases: { name: string; change: (f: ReturnType<typeof fixture>, c: MetadataContext) => void }[] = [
		{ name: "missing parent", change: (_f, c) => { c.parent_session = null; } },
		{ name: "ID-only parent", change: (_f, c) => { c.parent_session = { agent: "pi", id: "parent" }; } },
		{ name: "relative parent", change: (_f, c) => { c.parent_session!.path = "parent.jsonl"; } },
		{ name: "absent parent", change: (_f, c) => { c.parent_session!.path = "/absent"; } },
		{ name: "foreign parent authority", change: f => { f.parent.agent_session.source = "foreign"; } },
		{ name: "non-Pi parent", change: f => { f.parent.agent = "codex"; } },
		{ name: "native ID parent", change: f => { f.parent.agent_session.kind = "id"; f.parent.agent_session.value = "parent"; } },
		{ name: "native ID child despite context path", change: f => { f.pane.agent_session.kind = "id"; f.pane.agent_session.value = "child"; } },
		{ name: "relative child", change: (f, c) => { c.session.path = f.pane.agent_session.value = "child.jsonl"; } },
		{ name: "self parent", change: (_f, c) => { c.parent_session!.path = c.session.path; } },
		{ name: "duplicate parent path", change: f => { f.panes.push({ ...f.parent, pane_id: "duplicate", terminal_id: "duplicate" }); } },
		{ name: "duplicate child path", change: f => { f.panes.push({ ...f.pane, pane_id: "duplicate", terminal_id: "duplicate" }); } },
		{ name: "primary context", change: (_f, c) => { c.role = "primary"; } },
	];
	for (const { name, change } of cases) {
		const f = fixture();
		Object.assign(f.pane.tokens, { role: "subagent", agency_self: "old", agency_parent: "old", sentinel: "keep" });
		const current = structuredClone(context);
		change(f, current);
		assert.equal(await createMetadataPublisher(f.request).publish(f.terminal, current), true, name);
		for (const key of ["role", "agency_self", "agency_parent"]) assert.equal(f.pane.tokens[key], undefined, name);
		assert.equal(f.pane.tokens.sentinel, "keep", name);
		assert.equal(f.pane.tokens.pi_session_key, metadataSessionKey(current.session), name);
		assert.equal(f.pane.tokens.pi_role, current.role, name);
		assert.equal(f.calls.filter(c => c.method === "pane.report_metadata").length, 1, name);
	}
});

test("renewal republishes aliases with existing TTL and context reset removes stale links", async () => {
	const f = fixture();
	const publisher = createMetadataPublisher(f.request);
	for (let i = 0; i < 2; i++) {
		assert.equal(await publisher.publish(f.terminal, context), true);
		assert.equal(f.pane.tokens.role, "subagent");
	}
	assert.equal(await publisher.publish(f.terminal, { ...context, parent_session: null }), true);
	for (const key of ["role", "agency_self", "agency_parent"]) assert.equal(f.pane.tokens[key], undefined);
	const writes = f.calls.filter(c => c.method === "pane.report_metadata");
	assert.equal(writes.length, 3);
	assert.ok(writes.every(c => c.params.ttl_ms === METADATA_TTL_MS));
	assert.equal(writes[2].params.tokens.agency_parent, null);
});

test("success requires read-back of the aliases too", async () => {
	const f = fixture();
	const request = async (s: string, method: string, params: any) => {
		if (method === "pane.report_metadata") {
			return f.request(s, method, { ...params, tokens: Object.fromEntries(Object.entries(params.tokens).filter(([key]) => key.startsWith("pi_"))) });
		}
		return f.request(s, method, params);
	};
	assert.equal(await createMetadataPublisher(request).publish(f.terminal, context), false);
});

test("prelaunch, foreign session, foreign authority and missing terminal fail closed without writes", async () => {
	for (const mutation of [(p: any) => { p.agent = null; }, (p: any) => { p.agent_session = null; }, (p: any) => { p.agent_session.value = "/other"; }, (p: any) => { p.agent_session.source = "another-hook"; }, (p: any) => { p.agent_session.agent = "other"; }, (p: any) => { p.terminal_id = "replacement"; }]) {
		const f = fixture(); mutation(f.pane);
		assert.equal(await createMetadataPublisher(f.request).publish(f.terminal, context), false);
		assert.equal(f.calls.some(c => c.method === "pane.report_metadata"), false);
	}
});

test("accepted ID sessions work without pretending path and ID are equivalent", async () => {
	const f = fixture();
	f.pane.agent_session.kind = "id"; f.pane.agent_session.value = "child";
	assert.equal(await createMetadataPublisher(f.request).publish(f.terminal, context), true);
	f.pane.agent_session.value = "/child.jsonl";
	assert.equal(await createMetadataPublisher(f.request).publish(f.terminal, context), false);
});

test("ambiguous terminal and changed occupant between list and get cannot be attributed", async () => {
	for (const ambiguous of [true, false]) {
		const f = fixture();
		const request = async (s: string, method: string, params: any) => {
			if (method === "pane.list" && ambiguous) return { panes: [f.pane, { ...f.pane, pane_id: "w2:p10" }] };
			if (method === "pane.get" && !ambiguous) return { pane: { ...f.pane, terminal_id: "new" } };
			return f.request(s, method, params);
		};
		assert.equal(await createMetadataPublisher(request).publish(f.terminal, context), false);
		assert.equal(f.calls.some(c => c.method === "pane.report_metadata"), false);
	}
});

test("metadata rejection or ignored presentation does not report success", async () => {
	for (const reject of [true, false]) {
		const f = fixture();
		const request = async (s: string, method: string, params: any) => {
			if (method === "pane.report_metadata") { if (reject) throw Error("unknown_method"); return { type: "ok" }; }
			return f.request(s, method, params);
		};
		assert.equal(await createMetadataPublisher(request, () => {}).publish(f.terminal, context), false);
	}
});

test("a concurrent session change after write is not a successful binding (official API has no CAS)", async () => {
	const f = fixture();
	const request = async (s: string, method: string, params: any) => {
		const result = await f.request(s, method, params);
		if (method === "pane.report_metadata") f.pane.agent_session.value = "/replacement";
		return result;
	};
	assert.equal(await createMetadataPublisher(request).publish(f.terminal, context), false);
	assert.equal(f.terminal.paneId, "w1:p1");
	assert.equal(f.calls.filter(c => c.method === "pane.report_metadata").length, 1);
});

test("warnings are per endpoint; not-yet-ready session does not warn", async () => {
	const warnings: string[] = [];
	const publisher = createMetadataPublisher(async () => { throw Error("offline"); }, message => warnings.push(message));
	const f = fixture();
	await publisher.publish(f.terminal, context); await publisher.publish(f.terminal, context);
	await publisher.publish({ ...f.terminal, socketPath: "other.sock" }, context);
	assert.equal(warnings.length, 2);
	f.pane.agent_session = undefined;
	await createMetadataPublisher(f.request, message => warnings.push(message)).publish(f.terminal, context);
	assert.equal(warnings.length, 2);
});
