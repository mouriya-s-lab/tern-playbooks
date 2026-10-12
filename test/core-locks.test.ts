import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BlockField, BlockId, DocRef, FetchOutcome, PlaybookDoc, RunId } from "../src/domain/model";
import type { Connection, CoreApi, Fetcher, K1Handler, Store } from "../src/domain/ports";
import type { ErrorCode, EventPayload, Outcome, Request } from "../src/domain/protocol";
import { checks } from "../src/service/checks";
import { Core, type PaneControl } from "../src/service/core";
import { references } from "../src/service/references";
import { createStore } from "../src/service/store";

const template: DocRef = { kind: "template" };
const original: PlaybookDoc = {
	title: "Lock integration",
	blocks: [
		{ id: "b1", title: "First", body: "alpha unique repeated repeated aaa", done: false },
		{ id: "b2", title: "Second", body: "second committed body", done: true },
		{ id: "b3", title: "Third", body: "third committed body", done: false },
	],
};
const directories: string[] = [];
const activeCores = new Set<Core>();

const panes: PaneControl = {
	ownPane: () => "service-pane",
	async focusPane() { return { ok: true }; },
};

function connection(id: number) {
	const events: EventPayload[] = [];
	const conn: Connection = {
		id,
		send: frame => { events.push(frame); },
		close() {},
	};
	return { conn, events };
}

interface CoreHarness {
	readonly core: Core;
	readonly api: CoreApi;
	readonly handler: K1Handler;
	readonly conn: Connection;
	readonly events: EventPayload[];
	readonly store: Store;
	fetchCount(): number;
	request(request: Request, id?: string): Promise<Outcome<unknown>>;
	stop(): void;
}

function startCore(store: Store, paneControl: PaneControl = panes): CoreHarness {
	let fetchCount = 0;
	const fetched: FetchOutcome = { ok: true, at: 123, value: { kind: "file", text: "fixed external content" } };
	const fetcher: Fetcher = { async fetch() { fetchCount++; return fetched; } };
	const core = new Core({ store, references, checks, fetcher, panes: paneControl, now: () => 123_000 });
	activeCores.add(core);
	expect(core.load()).toBeNull();
	const api: CoreApi = core;
	const handler: K1Handler = core;
	const { conn, events } = connection(1);
	handler.connected(conn);
	let sequence = 0;
	return {
		core, api, handler, conn, events, store,
		fetchCount: () => fetchCount,
		request: (request: Request, id = `request-${++sequence}`) => handler.handle(conn, id, request),
		stop() { core.stop(); activeCores.delete(core); },
	};
}

function fixture(paneControl: PaneControl = panes) {
	const directory = mkdtempSync("/tmp/tern-core-locks-");
	directories.push(directory);
	const store = createStore(join(directory, "playbook.yaml"));
	store.write(template, store.serialize(original, null));
	return startCore(store, paneControl);
}

function expectError(outcome: Outcome<unknown>, code: ErrorCode) {
	expect(outcome).toMatchObject({ ok: false, error: { code } });
}

function persistedTemplate(store: Store): PlaybookDoc {
	const parsed = store.readTemplate();
	expect(parsed.ok).toBe(true);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.doc;
}

async function hello(h: CoreHarness) {
	expect(await h.request({ op: "hello", args: { session: "session-one", pane: "coordinator-pane" } }, "hello-one")).toEqual({
		ok: true,
		result: { blocks: ["b1", "b2", "b3"], runs: [], pane: "service-pane" },
	});
}

function run(h: CoreHarness): { ref: DocRef; id: RunId } {
	expect(h.api.startRun("Run with locks", null)).toBeNull();
	const id = h.api.runs().at(-1)!.id;
	return { ref: { kind: "run", run: id }, id };
}

function visible(h: CoreHarness, ref: DocRef, id: BlockId) {
	const block = h.api.view(ref).blocks.find(item => item.block.id === id);
	if (!block) throw new Error(`Missing visible block ${id}`);
	return block;
}

afterEach(() => {
	for (const core of activeCores) core.stop();
	activeCores.clear();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("K1 hello and lock ownership", () => {
	test("reveal before hello focuses its own pane without taking the coordinator slot", async () => {
		const focused: string[] = [];
		let ownPaneCalls = 0;
		const paneControl: PaneControl = {
			ownPane() { ownPaneCalls++; return "reveal-pane"; },
			async focusPane(pane) { focused.push(pane); return { ok: true }; },
		};
		const h = fixture(paneControl);
		expect(await h.request({ op: "reveal", args: {} })).toEqual({ ok: true, result: null });
		expect(ownPaneCalls).toBe(1);
		expect(focused).toEqual(["reveal-pane"]);
		expect(h.api.coordinator()).toEqual({ connected: false, session: null, pane: null });
		const second = connection(2);
		h.handler.connected(second.conn);
		expect(await h.handler.handle(second.conn, "hello-two", { op: "hello", args: { session: "session-two", pane: "pane-two" } })).toEqual({
			ok: true,
			result: { blocks: ["b1", "b2", "b3"], runs: [], pane: "reveal-pane" },
		});
		expect(h.api.coordinator()).toEqual({ connected: true, session: "session-two", pane: "pane-two" });
	});

	test("another connection can reveal while a coordinator is connected without replacing it or releasing its locks", async () => {
		const focused: string[] = [];
		let ownPaneCalls = 0;
		const paneControl: PaneControl = {
			ownPane() { ownPaneCalls++; return "service-pane"; },
			async focusPane(pane) { focused.push(pane); return { ok: true }; },
		};
		const h = fixture(paneControl);
		await hello(h);
		expect(await h.request({ op: "lock", args: { block: "b1" } }, "first-lock")).toEqual({
			ok: true,
			result: { block: original.blocks[0] },
		});
		const callsBeforeReveal = ownPaneCalls;
		const second = connection(2);
		h.handler.connected(second.conn);
		expect(await h.handler.handle(second.conn, "reveal-two", { op: "reveal", args: {} })).toEqual({ ok: true, result: null });
		expect(ownPaneCalls).toBe(callsBeforeReveal + 1);
		expect(focused).toEqual(["service-pane"]);
		expect(h.api.coordinator()).toEqual({ connected: true, session: "session-one", pane: "coordinator-pane" });
		expect(visible(h, template, "b1").lock).toEqual({ kind: "coordinator", request: "first-lock" });
	});

	test("reveal without an own pane returns RevealFailed without attempting focus", async () => {
		const focused: string[] = [];
		let ownPaneCalls = 0;
		const paneControl: PaneControl = {
			ownPane() { ownPaneCalls++; return null; },
			async focusPane(pane) { focused.push(pane); return { ok: true }; },
		};
		const h = fixture(paneControl);
		expect(await h.request({ op: "reveal", args: {} })).toEqual({
			ok: false,
			error: { code: "RevealFailed", message: "文档服务不在 session daemon 托管的 pane 中" },
		});
		expect(ownPaneCalls).toBe(1);
		expect(focused).toEqual([]);
		expect(h.api.coordinator()).toEqual({ connected: false, session: null, pane: null });
	});

	test("reveal propagates focusPane failure as RevealFailed", async () => {
		const focused: string[] = [];
		let ownPaneCalls = 0;
		const paneControl: PaneControl = {
			ownPane() { ownPaneCalls++; return "unfocusable-pane"; },
			async focusPane(pane) { focused.push(pane); return { ok: false, error: "pane focus was rejected" }; },
		};
		const h = fixture(paneControl);
		expect(await h.request({ op: "reveal", args: {} })).toEqual({
			ok: false,
			error: { code: "RevealFailed", message: "pane focus was rejected" },
		});
		expect(ownPaneCalls).toBe(1);
		expect(focused).toEqual(["unfocusable-pane"]);
		expect(h.api.coordinator()).toEqual({ connected: false, session: null, pane: null });
	});

	test("read before hello is NotHello; hello establishes status and allows unlocked reads", async () => {
		const h = fixture();
		expectError(await h.request({ op: "read", args: {} }), "NotHello");
		expect(h.api.coordinator()).toEqual({ connected: false, session: null, pane: null });
		await hello(h);
		expect(h.api.coordinator()).toEqual({ connected: true, session: "session-one", pane: "coordinator-pane" });
		expect(await h.request({ op: "read", args: {} })).toEqual({ ok: true, result: original });
		expect(await h.request({ op: "read", args: { block: "b2" } })).toEqual({ ok: true, result: original.blocks[1] });
		expect(h.fetchCount()).toBe(0);
	});

	test("an idle connection does not block hello, gets Busy after another coordinator joins, and allows replacement after disconnect", async () => {
		const h = fixture();
		expect(h.api.coordinator()).toEqual({ connected: false, session: null, pane: null });
		const second = connection(2);
		h.handler.connected(second.conn);
		expect(await h.handler.handle(second.conn, "hello-two", { op: "hello", args: { session: "session-two", pane: "pane-two" } })).toEqual({
			ok: true,
			result: { blocks: ["b1", "b2", "b3"], runs: [], pane: "service-pane" },
		});
		expect(h.api.coordinator()).toEqual({ connected: true, session: "session-two", pane: "pane-two" });
		expectError(await h.request({ op: "read", args: {} }), "Busy");
		expect(h.api.coordinator()).toEqual({ connected: true, session: "session-two", pane: "pane-two" });
		h.handler.disconnected(second.conn);
		expect(h.api.coordinator()).toEqual({ connected: false, session: null, pane: null });
		const third = connection(3);
		h.handler.connected(third.conn);
		expect(await h.handler.handle(third.conn, "hello-three", { op: "hello", args: { session: "session-three", pane: "pane-three" } })).toEqual({
			ok: true,
			result: { blocks: ["b1", "b2", "b3"], runs: [], pane: "service-pane" },
		});
		expect(h.api.coordinator()).toEqual({ connected: true, session: "session-three", pane: "pane-three" });
	});

	test("second connection gets Busy without replacing or unlocking the first coordinator", async () => {
		const h = fixture();
		await hello(h);
		await h.request({ op: "lock", args: { block: "b1" } }, "first-lock");
		const second = connection(2);
		h.handler.connected(second.conn);
		expectError(await h.handler.handle(second.conn, "hello-two", { op: "hello", args: { session: "session-two" } }), "Busy");
		expectError(await h.handler.handle(second.conn, "foreign-set", { op: "set", args: { block: "b1", field: "title", value: "foreign" } }), "Busy");
		h.handler.disconnected(second.conn);
		expect(h.api.coordinator().session).toBe("session-one");
		expect(visible(h, template, "b1").lock).toEqual({ kind: "coordinator", request: "first-lock" });
		expect(await h.request({ op: "set", args: { block: "b1", field: "title", value: "owned" } })).toEqual({ ok: true, result: null });
		expect(visible(h, template, "b1").block.title).toBe("owned");
	});

	for (const request of [
		{ op: "set", args: { block: "b1", field: "title", value: "unowned title" } },
		{ op: "set", args: { block: "b1", field: "done", value: true } },
		{ op: "edit", args: { block: "b1", find: "unique", replace: "unowned body" } },
		{ op: "delete", args: { block: "b1" } },
	] satisfies Request[]) {
		test(`${request.op} without a held lock returns NotLocked and leaves committed content unchanged (${JSON.stringify(request.args)})`, async () => {
			const h = fixture();
			await hello(h);
			expectError(await h.request(request), "NotLocked");
			expect(await h.request({ op: "read", args: {} })).toEqual({ ok: true, result: original });
			expect(visible(h, template, "b1").lock).toEqual({ kind: "none" });
			expect(persistedTemplate(h.store)).toEqual(original);
		});
	}

	test("lock returns latest committed content; re-lock supersedes request and only matching unlock releases that block", async () => {
		const h = fixture();
		await hello(h);
		expect(h.api.pencil(template, "b1", "title")).toBeNull();
		expect(h.api.setDraft(template, "b1", "human committed title")).toBeNull();
		expect(h.api.commit(template, "b1")).toBeNull();
		const committed = { ...original.blocks[0]!, title: "human committed title" };
		expect(await h.request({ op: "lock", args: { block: "b1" } }, "old-lock")).toEqual({ ok: true, result: { block: committed } });
		expect(await h.request({ op: "set", args: { block: "b1", field: "done", value: true } })).toEqual({ ok: true, result: null });
		expect(await h.request({ op: "lock", args: { block: "b1" } }, "new-lock")).toEqual({ ok: true, result: { block: { ...committed, done: true } } });
		await h.request({ op: "lock", args: { block: "b2" } }, "other-block-lock");
		for (const request of ["old-lock", "other-block-lock", "never-issued"]) {
			expect(await h.request({ op: "unlock", args: { block: "b1", request } })).toEqual({ ok: true, result: null });
			expect(visible(h, template, "b1").lock).toEqual({ kind: "coordinator", request: "new-lock" });
		}
		expect(await h.request({ op: "unlock", args: { block: "b1", request: "new-lock" } })).toEqual({ ok: true, result: null });
		expect(visible(h, template, "b1").lock).toEqual({ kind: "none" });
		expect(visible(h, template, "b2").lock).toEqual({ kind: "coordinator", request: "other-block-lock" });
		expectError(await h.request({ op: "set", args: { block: "b1", field: "title", value: "too late" } }), "NotLocked");
	});

	test("edit rejects missing and multiple matches atomically, including overlapping matches, and replaces one unique match", async () => {
		const h = fixture();
		await hello(h);
		await h.request({ op: "lock", args: { block: "b1" } }, "edit-lock");
		for (const [find, code] of [["absent", "NotFound"], ["repeated", "Ambiguous"], ["aa", "Ambiguous"]] as const) {
			expectError(await h.request({ op: "edit", args: { block: "b1", find, replace: "replacement" } }), code);
			expect(await h.request({ op: "read", args: { block: "b1" } })).toEqual({ ok: true, result: original.blocks[0] });
			expect(visible(h, template, "b1").lock).toEqual({ kind: "coordinator", request: "edit-lock" });
			expect(persistedTemplate(h.store)).toEqual(original);
		}
		expect(await h.request({ op: "edit", args: { block: "b1", find: "unique", replace: "changed" } })).toEqual({ ok: true, result: null });
		expect(visible(h, template, "b1").block.body).toBe("alpha changed repeated repeated aaa");
		h.stop();
		expect(persistedTemplate(h.store).blocks[0]!.body).toBe("alpha changed repeated repeated aaa");
	});

	test("unknown blocks and runs return their domain errors without altering the template", async () => {
		const h = fixture();
		await hello(h);
		for (const request of [
			{ op: "read", args: { block: "b999" } },
			{ op: "lock", args: { block: "b999" } },
			{ op: "set", args: { block: "b999", field: "title", value: "missing" } },
			{ op: "edit", args: { block: "b999", find: "x", replace: "y" } },
			{ op: "delete", args: { block: "b999" } },
		] satisfies Request[]) expectError(await h.request(request), "UnknownBlock");
		expectError(await h.request({ op: "read", args: { run: "r999" } }), "UnknownRun");
		expectError(await h.request({ op: "lock", args: { run: "r999", block: "b1" } }), "UnknownRun");
		expect(await h.request({ op: "read", args: {} })).toEqual({ ok: true, result: original });
	});
});

describe("K4 human drafts and coordinator interruption", () => {
	for (const field of ["title", "body"] satisfies BlockField[]) {
		test(`${field} pencil and draft leave committed document untouched until commit; coordinator cannot lock the draft`, async () => {
			const h = fixture();
			await hello(h);
			const r = run(h);
			const before = h.store.readRunLog(r.id).entries;
			expect(h.api.pencil(r.ref, "b1", field)).toBeNull();
			expect(visible(h, r.ref, "b1").lock).toEqual({ kind: "human", field, draft: original.blocks[0]![field] });
			expect(h.api.setDraft(r.ref, "b1", `uncommitted ${field}`)).toBeNull();
			expect(visible(h, r.ref, "b1").block).toEqual(original.blocks[0]!);
			expect(await h.request({ op: "read", args: { run: r.id, block: "b1" } })).toEqual({ ok: true, result: original.blocks[0] });
			expect(await h.request({ op: "read", args: { run: r.id } })).toMatchObject({ ok: true, result: { title: original.title, blocks: [{ ...original.blocks[0]! }, { ...original.blocks[1]!, done: false }, original.blocks[2]], run: { id: r.id } } });
			expectError(await h.request({ op: "lock", args: { run: r.id, block: "b1" } }, "draft-lock"), "Locked");
			expectError(await h.request({ op: "set", args: { run: r.id, block: "b1", field: "title", value: "overwrite" } }), "NotLocked");
			expect(visible(h, r.ref, "b1").lock).toEqual({ kind: "human", field, draft: `uncommitted ${field}` });
			expect(h.store.readRunLog(r.id).entries).toEqual(before);
			expect(h.store.readRuns().get(r.id)).toMatchObject({ ok: true, doc: { blocks: [original.blocks[0], { ...original.blocks[1]!, done: false }, original.blocks[2]] } });
			expect(h.api.commit(r.ref, "b1")).toBeNull();
			const committed = { ...original.blocks[0]!, [field]: `uncommitted ${field}` };
			expect(visible(h, r.ref, "b1").block).toEqual(committed);
			expect(visible(h, r.ref, "b1").lock).toEqual({ kind: "none" });
			expect(h.store.readRunLog(r.id).entries.slice(before.length)).toEqual([
				{ seq: before.length + 1, at: 123_000, origin: "human", data: { type: "block_edited", block: "b1", field, text: `uncommitted ${field}`, edit: 1 } },
			]);
			expect(await h.request({ op: "lock", args: { run: r.id, block: "b1" } }, "committed-lock")).toEqual({ ok: true, result: { block: committed } });
			h.stop();
			expect(h.store.readRuns().get(r.id)).toMatchObject({ ok: true, doc: { blocks: [committed, { ...original.blocks[1]!, done: false }, original.blocks[2]] } });
			expect(persistedTemplate(h.store)).toEqual(original);
		});
	}

	test("another pencil is rejected across fields, blocks, and documents while one human draft exists", async () => {
		const h = fixture();
		await hello(h);
		const r = run(h);
		expect(h.api.pencil(template, "b1", "body")).toBeNull();
		expect(h.api.setDraft(template, "b1", "private human draft")).toBeNull();
		for (const [ref, block, field] of [[template, "b1", "title"], [template, "b2", "body"], [r.ref, "b1", "body"], [r.ref, "b2", "title"]] as const) {
			expect(h.api.pencil(ref, block, field)).toBeTypeOf("string");
		}
		expect(visible(h, template, "b1").lock).toEqual({ kind: "human", field: "body", draft: "private human draft" });
		expect(visible(h, template, "b2").lock).toEqual({ kind: "none" });
		expect(visible(h, r.ref, "b1").lock).toEqual({ kind: "none" });
		expect(h.api.commit(template, "b1")).toBeNull();
		expect(h.api.pencil(r.ref, "b2", "title")).toBeNull();
	});

	for (const inRun of [false, true]) {
		test(`interrupt sends precise request identity, redraws and releases only the chosen lock (${inRun ? "Run" : "template"})`, async () => {
			const h = fixture();
			await hello(h);
			const r = inRun ? run(h) : null;
			const ref = r?.ref ?? template;
			const scope = r ? { run: r.id } : {};
			await h.request({ op: "lock", args: { ...scope, block: "b1" } }, "interrupted-lock");
			await h.request({ op: "lock", args: { ...scope, block: "b2" } }, "untouched-lock");
			expect(h.api.pencil(ref, "b1", "body")).toBeTypeOf("string");
			const changes: (DocRef | null)[] = [];
			const unsubscribe = h.api.onChange(changed => { changes.push(changed); });
			h.events.splice(0);
			expect(h.api.interrupt(ref, "b1")).toBeNull();
			expect(h.events).toEqual([{ event: "interrupted", data: { ...scope, block: "b1", request: "interrupted-lock" } }]);
			expect(changes).toContainEqual(ref);
			unsubscribe();
			expect(visible(h, ref, "b1").lock).toEqual({ kind: "none" });
			expect(visible(h, ref, "b2").lock).toEqual({ kind: "coordinator", request: "untouched-lock" });
			expectError(await h.request({ op: "set", args: { ...scope, block: "b1", field: "title", value: "after interruption" } }), "NotLocked");
			expect(visible(h, ref, "b1").block).toEqual(original.blocks[0]!);
			expect(h.api.pencil(ref, "b1", "body")).toBeNull();
			if (r) expect(h.store.readRunLog(r.id).entries).toContainEqual({ seq: 3, at: 123_000, origin: "human", data: { type: "interrupted", block: "b1", request: "interrupted-lock" } });
		});
	}

	test("disconnect releases all coordinator locks across template and Runs, preserves human draft, and reconnect does not restore locks", async () => {
		const h = fixture();
		await hello(h);
		const r = run(h);
		for (const args of [{ block: "b1" }, { block: "b2" }, { run: r.id, block: "b1" }, { run: r.id, block: "b2" }] satisfies Extract<Request, { op: "lock" }>["args"][]) {
			expect((await h.request({ op: "lock", args })).ok).toBe(true);
		}
		expect(h.api.pencil(r.ref, "b3", "body")).toBeNull();
		expect(h.api.setDraft(r.ref, "b3", "surviving human draft")).toBeNull();
		const changes: (DocRef | null)[] = [];
		const unsubscribe = h.api.onChange(ref => { changes.push(ref); });
		h.handler.disconnected(h.conn);
		expect(changes).toContain(null);
		unsubscribe();
		expect(h.api.coordinator()).toEqual({ connected: false, session: null, pane: null });
		for (const ref of [template, r.ref]) for (const block of ["b1", "b2"] satisfies BlockId[]) expect(visible(h, ref, block).lock).toEqual({ kind: "none" });
		expect(visible(h, r.ref, "b3").lock).toEqual({ kind: "human", field: "body", draft: "surviving human draft" });
		const next = connection(2);
		h.handler.connected(next.conn);
		expect((await h.handler.handle(next.conn, "rehello", { op: "hello", args: { session: "session-one" } })).ok).toBe(true);
		for (const scope of [{}, { run: r.id }]) {
			expectError(await h.handler.handle(next.conn, "not-restored", { op: "set", args: { ...scope, block: "b1", field: "title", value: "unowned after reconnect" } }), "NotLocked");
		}
		expect((await h.handler.handle(next.conn, "fresh-lock", { op: "lock", args: { block: "b1" } })).ok).toBe(true);
		expect(visible(h, template, "b1").lock).toEqual({ kind: "coordinator", request: "fresh-lock" });
	});
});

describe("K1 insert allocation and deletion lifetime", () => {
	test("insert appends by default, inserts after an anchor, starts unlocked/undone, and never reuses a deleted ID even after restart", async () => {
		const h = fixture();
		await hello(h);
		expect(await h.request({ op: "insert", args: { title: "Allocated", body: "allocated body" } })).toEqual({ ok: true, result: { block: "b4" } });
		expect(h.api.view(template).blocks.map(item => item.block.id)).toEqual(["b1", "b2", "b3", "b4"]);
		expect(visible(h, template, "b4")).toMatchObject({ block: { id: "b4", title: "Allocated", body: "allocated body", done: false }, lock: { kind: "none" } });
		await h.request({ op: "lock", args: { block: "b4" } }, "delete-lock");
		expect(await h.request({ op: "delete", args: { block: "b4" } })).toEqual({ ok: true, result: null });
		expect(h.api.view(template).blocks.some(item => item.block.id === "b4")).toBe(false);
		expectError(await h.request({ op: "lock", args: { block: "b4" } }), "UnknownBlock");
		expect(await h.request({ op: "insert", args: { after: "b1", title: "Next", body: "next body" } })).toEqual({ ok: true, result: { block: "b5" } });
		expect(h.api.view(template).blocks.map(item => item.block.id)).toEqual(["b1", "b5", "b2", "b3"]);
		await h.request({ op: "lock", args: { block: "b5" } }, "delete-next-lock");
		expect(await h.request({ op: "delete", args: { block: "b5" } })).toEqual({ ok: true, result: null });
		h.stop();
		expect(persistedTemplate(h.store)).toEqual(original);
		expect(h.store.readServiceRecords()).toEqual([{ kind: "block", id: "b4" }, { kind: "block", id: "b5" }]);
		const restarted = startCore(h.store);
		await hello(restarted);
		expect(await restarted.request({ op: "insert", args: { title: "Restart allocated", body: "fresh body" } })).toEqual({ ok: true, result: { block: "b6" } });
		restarted.stop();
		expect(persistedTemplate(h.store).blocks.at(-1)).toEqual({ id: "b6", title: "Restart allocated", body: "fresh body", done: false });
	});
});
