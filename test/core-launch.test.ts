import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Block, BlockId, CompileResult, DocRef, FetchOutcome, LaunchId } from "../src/domain/model";
import type { Connection } from "../src/domain/ports";
import type { ErrorCode, EventPayload, Outcome, Request } from "../src/domain/protocol";
import { checks } from "../src/service/checks";
import { Core } from "../src/service/core";
import { references } from "../src/service/references";
import { createStore } from "../src/service/store";

type ChangedEvent = Extract<EventPayload, { event: "block_changed" }>;
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function block(id: BlockId, body: string): Block {
	return { id, title: id, body, done: false };
}

async function fixture(blocks: readonly Block[] = [block("b1", "Task:\n((b2))"), block("b2", "before")]) {
	const directory = mkdtempSync("/tmp/tern-core-launch-");
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const store = createStore(join(directory, "playbook.yaml"));
	store.write({ kind: "template" }, store.serialize({ title: "Launch integration", blocks }, null));
	const fetchCalls: string[] = [];
	let fetchOutcome: FetchOutcome = { ok: true, at: Date.parse("2026-01-01T00:00:00Z"), value: { kind: "file", text: "external before" } };
	const core = new Core({
		store, references, checks,
		fetcher: { async fetch(target, baseDir) {
			expect(baseDir).toBe(directory);
			fetchCalls.push(references.targetKey(target));
			return fetchOutcome;
		} },
		panes: {
			ownPane: () => null,
			async focusPane() { return { ok: false, error: "not used by launch tests" }; },
		},
	});
	cleanups.push(() => core.stop());
	expect(core.load()).toBeNull();
	const events: EventPayload[] = [];
	let connectionId = 0;
	let requestId = 0;
	let conn: Connection;
	async function connect(session = "launch-owner") {
		conn = { id: ++connectionId, send: event => events.push(event), close() {} };
		core.connected(conn);
		expect((await core.handle(conn, `q${++requestId}`, { op: "hello", args: { session } })).ok).toBe(true);
	}
	await connect();
	const send = (request: Request) => core.handle(conn, `q${++requestId}`, request);
	async function success(request: Request): Promise<unknown> {
		const outcome = await send(request);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
		return outcome.result;
	}
	expect(core.startRun("Test run", null)).toBeNull();
	const run = core.runs()[0]!.id;
	const ref: DocRef = { kind: "run", run };
	const changed = () => events.filter((event): event is ChangedEvent => event.event === "block_changed");
	function edit(id: BlockId, body: string, field: "body" | "title" = "body") {
		expect(core.pencil(ref, id, field)).toBeNull();
		expect(core.setDraft(ref, id, body)).toBeNull();
		expect(core.commit(ref, id)).toBeNull();
	}
	async function launch(ids: readonly BlockId[] = ["b1"]) {
		const result = await success({ op: "launch", args: { run, blocks: ids } });
		const record = [...store.readRunLog(run).launches.values()].at(-1);
		if (!record) throw new Error("launch did not persist a record");
		expect(result).toEqual({ launch: record.id, kind: record.kind, text: record.snapshot.result.text });
		return record.id;
	}
	return {
		core, store, run, ref, send, success, changed, edit, launch, connect, events, fetchCalls,
		disconnect: () => core.disconnected(conn),
		setFetchOutcome: (outcome: FetchOutcome) => { fetchOutcome = outcome; },
	};
}

// Integration exception: Core owns real timers and exposes no fake-timer seam.
// These tests intentionally exercise the platform's 2 s debounce and full no-event window.
// Positive assertions wait for the observable event with a bounded deadline.
const debounce = () => Bun.sleep(2_150);
async function awaitChanges(changed: () => readonly ChangedEvent[], count: number, timeout = 3_000) {
	const deadline = Date.now() + timeout;
	while (changed().length < count && Date.now() < deadline) await Bun.sleep(10);
	expect(changed()).toHaveLength(count);
	return changed()[count - 1]!;
}
function error(outcome: Outcome<unknown>, code: ErrorCode) {
	expect(outcome.ok).toBe(false);
	if (outcome.ok) throw new Error(`Expected ${code}, got success`);
	expect(outcome.error.code).toBe(code);
	return outcome.error;
}

// launch-events.md §1–§4; references.md §4–§5.
describe("Core Launch integration", () => {
	test("human dependency edits emit after 2 s with compiled current, diff, agents and changed ids", async () => {
		const f = await fixture();
		const preview = await f.core.preview(f.ref, ["b1"]);
		expect(await f.success({ op: "compile", args: { run: f.run, blocks: ["b1"] } })).toEqual(preview);
		const launch = await f.launch();
		expect<unknown>(f.core.launchInfo(launch)!.snapshot.result).toEqual(preview);
		await f.success({ op: "bind", args: { launch, agent: "agent-alpha" } });
		await f.success({ op: "bind", args: { launch, agent: "agent-beta" } });
		const editedAt = Date.now();
		f.edit("b2", "after");
		await Bun.sleep(150);
		expect(f.changed()).toEqual([]);
		const event = await awaitChanges(f.changed, 1);
		expect(Date.now() - editedAt).toBeGreaterThanOrEqual(1_950);
		const current = references.compile(["b1"], {
			blocks: new Map([["b1", "Task:\n((b2))"], ["b2", "after"]]), fetches: new Map(), results: new Map(), inTemplate: false,
		});
		expect(event.data).toEqual({
			id: expect.any(String), launch: { id: launch, kind: "prompt", run: f.run },
			agents: ["agent-alpha", "agent-beta"], changed: ["b2"],
			diff: references.unifiedDiff("Task:\nbefore", "Task:\nafter"), current,
		});
		expect(event.data.diff).toContain("-before");
		expect(event.data.diff).toContain("+after");
		expect<unknown>(f.core.launchInfo(launch)!.snapshot.result).toEqual(preview);
		expect(f.store.readRunLog(f.run).entries.some(entry => entry.data.type === "event_sent" && entry.data.event === "block_changed")).toBe(true);
	}, 8_000);

	test("BadLaunch, UnknownBlock, template launch and CompileError never create a Launch", async () => {
		const f = await fixture([block("b1", "plain"), block("b2", "```js\nconsole.log(1);\n```"), block("b3", "((b99))")]);
		error(await f.send({ op: "launch", args: { run: f.run, blocks: [] } }), "BadLaunch");
		error(await f.send({ op: "launch", args: { run: f.run, blocks: ["b2", "b1"] } }), "BadLaunch");
		error(await f.send({ op: "launch", args: { run: f.run, blocks: ["b99"] } }), "UnknownBlock");
		// Malformed K1 boundary: omitting run targets the template in other operations,
		// but launch requires a Run and must not create a template Launch.
		// @ts-expect-error Deliberately exercise missing run at the runtime boundary.
		const templateLaunch: Request = { op: "launch", args: { blocks: ["b1"] } };
		error(await f.send(templateLaunch), "UnknownRun");
		const failure = error(await f.send({ op: "launch", args: { run: f.run, blocks: ["b3"] } }), "CompileError");
		expect(failure.detail).toMatchObject({ kind: "UnknownBlock", block: "b99" });
		expect(f.store.readRunLog(f.run).launches.size).toBe(0);
		const prompt = await f.launch(["b1"]);
		const orchestration = await f.launch(["b2"]);
		expect(prompt).toBe("l1");
		expect(f.core.launchInfo(orchestration)!.kind).toBe("orchestration");
	});

	test("ordered multi-block snapshot equals compile and is frozen across edits and rebase", async () => {
		const f = await fixture([block("b1", "first"), block("b2", "second")]);
		const ids: readonly BlockId[] = ["b2", "b1"];
		const compiled = await f.success({ op: "compile", args: { run: f.run, blocks: ids } });
		const launch = await f.launch(ids);
		const snapshot = f.core.launchInfo(launch)!.snapshot;
		expect<unknown>(snapshot.result).toEqual(compiled);
		expect(snapshot.result.text).toBe("second\n\nfirst");
		f.edit("b1", "new first");
		await f.success({ op: "rebase", args: { launch } });
		expect(f.core.launchInfo(launch)!.snapshot).toEqual(snapshot);
		expect(f.store.readRunLog(f.run).launches.get(launch)!.snapshot).toEqual(snapshot);
	});

	test("pending ack suppresses a second event; ack immediately judges later edits after the deadline", async () => {
		const f = await fixture();
		const launch = await f.launch();
		f.edit("b2", "first change");
		const first = await awaitChanges(f.changed, 1);
		f.edit("b2", "second change");
		await debounce();
		expect(f.changed()).toHaveLength(1);
		expect(f.core.launchInfo(launch)!.notified).toBeNull();
		expect(f.core.launchInfo(launch)!.dirty.map(([id]) => id)).toEqual(["b2"]);
		await f.success({ op: "ack", args: { event: first.data.id } });
		const second = await awaitChanges(f.changed, 2, 500);
		expect(second.data.id).not.toBe(first.data.id);
		expect(second.data.current).toMatchObject({ kind: "Ok", text: "Task:\nsecond change" });
		expect(f.core.launchInfo(launch)!.notified).toEqual(first.data.current);
		await f.success({ op: "ack", args: { event: second.data.id } });
		expect(f.core.launchInfo(launch)!.dirty).toEqual([]);
		expect(f.core.launchInfo(launch)!.notified).toEqual(second.data.current);
	}, 10_000);

	test("after ack a dirty edit with the same compiled result is not resent", async () => {
		const f = await fixture([block("b1", "((b2 | lines(1..1)))"), block("b2", "before\nignored")]);
		const launch = await f.launch();
		f.edit("b2", "after\nignored");
		const first = await awaitChanges(f.changed, 1);
		await f.success({ op: "ack", args: { event: first.data.id } });
		f.edit("b2", "after\ndifferent ignored line");
		await debounce();
		expect(f.changed()).toHaveLength(1);
		expect(f.core.launchInfo(launch)!.dirty).toEqual([]);
		expect(f.core.launchInfo(launch)!.notified).toEqual(first.data.current);
	}, 10_000);

	test("returning to baseline emits nothing, resets notified and allows a later repeat change", async () => {
		const f = await fixture();
		const launch = await f.launch();
		f.edit("b2", "after");
		const first = await awaitChanges(f.changed, 1);
		await f.success({ op: "ack", args: { event: first.data.id } });
		f.edit("b2", "before");
		await debounce();
		expect(f.changed()).toHaveLength(1);
		expect(f.core.launchInfo(launch)!.notified).toBeNull();
		expect(f.core.launchInfo(launch)!.dirty).toEqual([]);
		f.edit("b2", "after");
		const second = await awaitChanges(f.changed, 2);
		expect(second.data.current).toEqual(first.data.current);
	}, 12_000);

	test("coordinator edits and human title/done edits do not trigger changes, including reconnect", async () => {
		const f = await fixture();
		const launch = await f.launch();
		await f.success({ op: "lock", args: { run: f.run, block: "b2" } });
		await f.success({ op: "edit", args: { run: f.run, block: "b2", find: "before", replace: "coordinator edit" } });
		f.disconnect(); // Releases the coordinator lock without a human body edit.
		await f.connect();
		f.edit("b2", "human title", "title");
		expect(f.core.setDone(f.ref, "b2", true)).toBeNull();
		await debounce();
		expect(f.changed()).toEqual([]);
		expect(f.core.launchInfo(launch)!.dirty).toEqual([]);
		expect(await f.core.preview(f.ref, ["b1"])).toMatchObject({ kind: "Ok", text: "Task:\ncoordinator edit" });
	}, 8_000);

	test("deleting a referenced block emits Err with an empty diff; failed rebase preserves state", async () => {
		const f = await fixture();
		const launch = await f.launch();
		expect(f.core.deleteBlock(f.ref, "b2")).toBeNull();
		const event = await awaitChanges(f.changed, 1);
		expect(event.data.changed).toEqual(["b2"]);
		expect(event.data.diff).toBe("");
		expect(event.data.current).toMatchObject({ kind: "Err", error: { kind: "UnknownBlock", block: "b2", at: { block: "b1", reference: "((b2))" } } });
		const before = f.core.launchInfo(launch)!;
		error(await f.send({ op: "rebase", args: { launch } }), "CompileError");
		expect(f.core.launchInfo(launch)).toEqual(before);
		await f.success({ op: "ack", args: { event: event.data.id } });
		expect(f.core.launchInfo(launch)!.notified).toEqual(event.data.current);
	}, 8_000);

	test("rebase discards pending event and moves the diff reference to the newest baseline", async () => {
		const f = await fixture();
		const launch = await f.launch();
		const snapshot = f.core.launchInfo(launch)!.snapshot;
		f.edit("b2", "rebased");
		const first = await awaitChanges(f.changed, 1);
		expect(await f.success({ op: "rebase", args: { launch } })).toEqual({ baseline: "Task:\nrebased" });
		expect(f.core.launchInfo(launch)!.baselines).toEqual(["Task:\nbefore", "Task:\nrebased"]);
		expect(f.core.launchInfo(launch)!.dirty).toEqual([]);
		expect(f.core.launchInfo(launch)!.notified).toBeNull();
		error(await f.send({ op: "ack", args: { event: first.data.id } }), "UnknownEvent");
		f.edit("b2", "changed again");
		const second = await awaitChanges(f.changed, 2);
		expect(second.data.diff).toBe(references.unifiedDiff("Task:\nrebased", "Task:\nchanged again"));
		expect(second.data.diff).toContain("-rebased");
		expect(f.core.launchInfo(launch)!.snapshot).toEqual(snapshot);
	}, 10_000);

	test("bind, close and rebase reject unknown Launches and non-owner sessions", async () => {
		const f = await fixture();
		const launch = await f.launch();
		const initial = f.core.launchInfo(launch)!;
		f.disconnect();
		await f.connect("other-session");
		function operations(id: LaunchId): Request[] {
			return [{ op: "bind", args: { launch: id, agent: "intruder" } }, { op: "close", args: { launch: id } }, { op: "rebase", args: { launch: id } }];
		}
		for (const request of operations("l999")) error(await f.send(request), "UnknownLaunch");
		for (const request of operations(launch)) error(await f.send(request), "NotOwner");
		expect(f.core.launchInfo(launch)).toEqual(initial);
		f.disconnect();
		await f.connect();
		await f.success({ op: "bind", args: { launch, agent: "owner-agent" } });
		await f.success({ op: "close", args: { launch } });
		expect(f.core.launchInfo(launch)!.closed?.by).toBe("coordinator");
	});

	test("disconnect drops pending delivery; same session reconnect immediately judges dirty edits", async () => {
		const f = await fixture();
		const launch = await f.launch();
		f.edit("b2", "first unacknowledged");
		const first = await awaitChanges(f.changed, 1);
		f.disconnect();
		f.edit("b2", "offline change");
		await debounce();
		expect(f.changed()).toHaveLength(1);
		expect(f.core.launchInfo(launch)!.notified).toBeNull();
		// A newly edited value has not yet reached its 2 s deadline; hello overrides it.
		f.edit("b2", "just before reconnect");
		await f.connect();
		const second = await awaitChanges(f.changed, 2, 500);
		expect(second.data.id).not.toBe(first.data.id);
		expect(second.data.current).toMatchObject({ kind: "Ok", text: "Task:\njust before reconnect" });
		error(await f.send({ op: "ack", args: { event: first.data.id } }), "UnknownEvent");
		await f.success({ op: "ack", args: { event: second.data.id } });
		expect(f.core.launchInfo(launch)!.dirty).toEqual([]);
	}, 10_000);

	test("human close discards pending and queued judgments and prevents later events", async () => {
		const f = await fixture();
		const launch = await f.launch();
		f.edit("b2", "pending change");
		const first = await awaitChanges(f.changed, 1);
		const queued = await f.launch();
		const beforeCount = f.changed().length;
		f.edit("b2", "future change");
		expect(f.core.closeLaunch(launch)).toBeNull();
		expect(f.core.closeLaunch(queued)).toBeNull();
		expect(f.core.launchInfo(queued)!.closed?.by).toBe("human");
		expect(f.core.launchInfo(launch)!.closed?.by).toBe("human");
		const closed = f.core.launchInfo(first.data.launch.id)!;
		error(await f.send({ op: "ack", args: { event: first.data.id } }), "UnknownEvent");
		expect(f.core.launchInfo(first.data.launch.id)).toEqual(closed);
		await debounce();
		f.disconnect();
		await f.connect();
		await Bun.sleep(50);
		expect(f.changed()).toHaveLength(beforeCount);
	}, 10_000);

	test("external references fetch once until explicit refetch; existing Launch judgments and rebase retain their fetch table", async () => {
		const f = await fixture([block("b1", "Task:\n((file:context.txt))")]);
		const compile = await f.success({ op: "compile", args: { run: f.run, blocks: ["b1"] } });
		const launch = await f.launch();
		const snapshot = f.core.launchInfo(launch)!.snapshot;
		expect<unknown>(snapshot.result).toEqual(compile);
		expect(snapshot.fetches).toHaveLength(1);
		await f.core.preview(f.ref, ["b1"]);
		await f.success({ op: "inspect", args: { run: f.run, blocks: ["b1"] } });
		f.core.view(f.ref);
		expect(f.fetchCalls).toEqual(["file:context.txt"]);
		f.setFetchOutcome({ ok: true, at: Date.parse("2026-01-02T00:00:00Z"), value: { kind: "file", text: "external refetched" } });
		await f.success({ op: "refetch", args: { run: f.run, targets: ["file:context.txt"] } });
		expect(f.fetchCalls).toEqual(["file:context.txt", "file:context.txt"]);
		const documentPreview = await f.core.preview(f.ref, ["b1"]);
		if (documentPreview.kind !== "Ok") throw new Error("expected successful refetched preview");
		expect(documentPreview.text).toContain("external refetched");
		expect(f.core.launchInfo(launch)!.fetches).toEqual(snapshot.fetches);
		f.edit("b1", "Modified task:\n((file:context.txt))");
		const event = await awaitChanges(f.changed, 1);
		const frozen: CompileResult = references.compile(["b1"], {
			blocks: new Map([["b1", "Modified task:\n((file:context.txt))"]]),
			fetches: new Map(snapshot.fetches), results: new Map(snapshot.results), inTemplate: false,
		});
		expect(event.data.current).toEqual(frozen);
		if (frozen.kind !== "Ok") throw new Error("expected successful frozen compile");
		expect(frozen.text).toContain("external before");
		expect(frozen.text).not.toContain("external refetched");
		await f.success({ op: "ack", args: { event: event.data.id } });
		expect(await f.success({ op: "rebase", args: { launch } })).toEqual({ baseline: frozen.text });
		expect(f.core.launchInfo(launch)!.snapshot).toEqual(snapshot);
		expect(f.core.launchInfo(launch)!.fetches).toEqual(snapshot.fetches);
		expect(f.fetchCalls).toHaveLength(2);
		// A newly introduced target is fetched once and appended without replacing the old one.
		f.edit("b1", "Modified task:\n((file:context.txt))\n((file:new.txt))");
		const second = await awaitChanges(f.changed, 2);
		const extended = f.core.launchInfo(launch)!;
		expect(second.data.current).toEqual(references.compile(["b1"], {
			blocks: new Map([["b1", "Modified task:\n((file:context.txt))\n((file:new.txt))"]]),
			fetches: new Map(extended.fetches), results: new Map(snapshot.results), inTemplate: false,
		}));
		if (second.data.current.kind !== "Ok") throw new Error("expected successful extended compile");
		expect(second.data.current.text).toContain("external before");
		expect(second.data.current.text).toContain("external refetched");
		expect(f.fetchCalls).toEqual(["file:context.txt", "file:context.txt", "file:new.txt"]);
		expect(f.core.launchInfo(launch)!.fetches.map(([key]) => key)).toEqual(["file:context.txt", "file:new.txt"]);
		expect(f.core.launchInfo(launch)!.snapshot).toEqual(snapshot);
		expect(f.store.readRunLog(f.run).launches.get(launch)!.fetches).toEqual(f.core.launchInfo(launch)!.fetches);
		await f.success({ op: "ack", args: { event: second.data.id } });
		const beforeHumanRefetch = f.core.launchInfo(launch)!.fetches;
		f.setFetchOutcome({ ok: true, at: Date.parse("2026-01-03T00:00:00Z"), value: { kind: "file", text: "human refetched" } });
		expect(await f.core.refetch(f.ref, "file:context.txt")).toBeNull();
		expect(f.fetchCalls).toEqual(["file:context.txt", "file:context.txt", "file:new.txt", "file:context.txt"]);
		expect(f.core.launchInfo(launch)!.fetches).toEqual(beforeHumanRefetch);
		expect(f.core.launchInfo(launch)!.snapshot).toEqual(snapshot);
		expect(f.core.launchInfo(launch)!.dirty).toEqual([]);
	}, 12_000);
});
