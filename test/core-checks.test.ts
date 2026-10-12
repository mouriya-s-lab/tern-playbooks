import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Block, BlockId, DocRef, FetchOutcome, Findings, JudgeReport, RunId } from "../src/domain/model";
import type { Connection, Fetcher, RenderStatus, Store } from "../src/domain/ports";
import type { EventPayload, Outcome, Request } from "../src/domain/protocol";
import { checks } from "../src/service/checks";
import { Core, type PaneControl } from "../src/service/core";
import { references } from "../src/service/references";
import { createStore } from "../src/service/store";

const template: DocRef = { kind: "template" };
const noFindings: Findings = { compile: false, empty_expansion: false, render_error: false, render_pending: false, chart: false };
const answers: JudgeReport = { kind: "answers", answers: { missing: 0.75 } };
const fetched: FetchOutcome = { ok: true, at: 1_000, value: { kind: "file", text: "fixed external material" } };
const panes: PaneControl = {
	ownPane: () => null,
	async focusPane() { return { ok: false, error: "unused in checks integration" }; },
};
const fixtures: { core: Core; connection: Connection; directory: string }[] = [];

interface Fixture {
	readonly core: Core;
	readonly store: Store;
	readonly events: EventPayload[];
	readonly connection: Connection;
	request(request: Request): Promise<Outcome<unknown>>;
	fetchCalls(): number;
	connect(): Promise<void>;
	restart(): Promise<Core>;
}

function block(id: BlockId, body: string): Block {
	return { id, title: `Block ${id}`, body, done: false };
}

function fixture(blocks: readonly Block[] = [block("b1", "Review ((b2))"), block("b2", "dependency material"), block("b3", "unrelated material")]): Fixture {
	const directory = mkdtempSync("/tmp/tern-core-checks-");
	const store = createStore(join(directory, "checks.yaml"));
	store.write(template, store.serialize({ title: "Checks integration", blocks }, null));
	let fetchCalls = 0;
	const fetcher: Fetcher = { async fetch() { fetchCalls++; return fetched; } };
	const events: EventPayload[] = [];
	const connection: Connection = { id: 1, send: event => { events.push(event); }, close() {} };
	const core = new Core({ store, references, checks, fetcher, panes, now: () => 10_000 });
	const tracked = { core, connection, directory };
	fixtures.push(tracked);
	expect(core.load()).toBeNull();
	let requestId = 0;
	const request = (request: Request): Promise<Outcome<unknown>> => core.handle(connection, `checks-${++requestId}`, request);
	return {
		core, store, events, connection, request,
		fetchCalls: () => fetchCalls,
		async connect() {
			core.connected(connection);
			expect(await request({ op: "hello", args: { session: "checks-session" } })).toMatchObject({ ok: true });
			await settle(core);
		},
		async restart() {
			core.disconnected(connection);
			core.stop();
			const next = new Core({ store, references, checks, fetcher, panes, now: () => 10_000 });
			tracked.core = next;
			expect(next.load()).toBeNull();
			await settle(next);
			return next;
		},
	};
}

// Await the real compiler's fetch boundary. Recomputations queued by the preceding
// public operation use that same boundary and settle before this preview returns.
async function settle(core: Core, ref: DocRef = template): Promise<void> {
	await core.preview(ref, core.view(ref).blocks.map(card => card.block.id));
}

function success(outcome: Outcome<unknown>): unknown {
	expect(outcome.ok).toBe(true);
	if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
	return outcome.result;
}

async function inspect(f: Fixture, blocks: readonly BlockId[] = ["b1"], run?: RunId) {
	const state = success(await f.request({ op: "inspect", args: { blocks, ...(run === undefined ? {} : { run }) } }));
	if (state === null || typeof state !== "object" || !("version" in state) || typeof state.version !== "string") {
		throw new Error("inspect did not return a string version");
	}
	expect(state.version).toMatch(/^[0-9a-f]{64}$/);
	return { state, version: state.version };
}

async function startRun(f: Fixture): Promise<RunId> {
	expect(f.core.startRun("Checks run", null)).toBeNull();
	await settle(f.core);
	const run = f.core.runs()[0]?.id;
	if (!run) throw new Error("startRun did not create a Run");
	return run;
}

function editBody(f: Fixture, ref: DocRef, id: BlockId, body: string): void {
	expect(f.core.pencil(ref, id, "body")).toBeNull();
	expect(f.core.setDraft(ref, id, body)).toBeNull();
	expect(f.core.commit(ref, id)).toBeNull();
}

function shownReport(core: Core, ref: DocRef, id: BlockId = "b1") {
	const card = core.view(ref).blocks.find(card => card.block.id === id);
	if (!card) throw new Error(`Missing block card ${id}`);
	return card.report;
}

function reportEntries(f: Fixture, run: RunId) {
	return f.store.readRunLog(run).entries.filter(entry => entry.data.type === "check_reported");
}

async function report(f: Fixture, version: string, result: JudgeReport = answers, run?: RunId, blocks: readonly BlockId[] = ["b1"]) {
	return f.request({ op: "report", args: { blocks, version, result, ...(run === undefined ? {} : { run }) } });
}

afterEach(() => {
	for (const f of fixtures.splice(0)) {
		f.core.disconnected(f.connection);
		f.core.stop();
		rmSync(f.directory, { recursive: true, force: true });
	}
});

describe("Core checks: inspect (checks.md §1; K1)", () => {
	test("returns source, real compiled text, rendered node summaries, findings and a stable dependency version without a Launch", async () => {
		const f = fixture();
		await f.connect();
		const render: RenderStatus = {
			blockError: false, documentError: false, pendingOverdue: false, chartNodes: 1,
			view: { md: ["rendered review", "second md node"], images: ["chart alt"] },
		};
		f.core.setRenderStatus(template, "b1", render);
		await settle(f.core);
		const first = await inspect(f);
		const expected = {
			blocks: ["b1"], source: { b1: "Review ((b2))" },
			compiled: { kind: "Ok", text: "Review dependency material", sources: [{ kind: "block", target: "b2", expression: null }] },
			view: { b1: render.view }, findings: { b1: noFindings }, version: first.version,
		};
		expect(first.state).toEqual(expected);
		expect((await inspect(f)).state).toEqual(first.state);
		expect(f.store.readServiceRecords()).toEqual([]);
		expect(f.core.view(template).blocks.every(card => card.launches.length === 0)).toBe(true);
		expect(f.fetchCalls()).toBe(0);
		editBody(f, template, "b3", "unrelated new material");
		await settle(f.core);
		expect((await inspect(f)).version).toBe(first.version);
		editBody(f, template, "b2", "new dependency material");
		await settle(f.core);
		expect((await inspect(f)).version).not.toBe(first.version);
	});

	test("returns CompileResult.Err inside successful inspect and marks compile finding", async () => {
		const f = fixture([block("b1", "Review ((b99))")]);
		await f.connect();
		const state = await inspect(f);
		expect(state.state).toMatchObject({
			compiled: { kind: "Err", error: { kind: "UnknownBlock", block: "b99", at: { block: "b1", reference: "((b99))" } } },
			findings: { b1: { ...noFindings, compile: true } },
		});
		expect(f.core.view(template).blocks[0]?.findings).toEqual({ ...noFindings, compile: true });
	});

	test("findings distinguish whitespace-only expansion, failed expansion, and an empty non-reference body", async () => {
		const f = fixture([block("b1", "Review ((b2))"), block("b2", " \t\n"), block("b3", "((b99))"), block("b4", "")]);
		await f.connect();
		const first = await inspect(f, ["b1", "b3", "b4"]);
		expect(first.state).toMatchObject({ findings: {
			b1: { ...noFindings, empty_expansion: true },
			b3: { ...noFindings, compile: true },
			b4: noFindings,
		} });
		expect((await inspect(f, ["b1", "b3", "b4"])).state).toEqual(first.state);
		editBody(f, template, "b2", "nonempty material");
		await settle(f.core);
		expect(f.core.view(template).blocks[0]?.findings).toEqual(noFindings);
	});
});

describe("Core checks: report acceptance and recording (checks.md §5)", () => {
	for (const result of [answers, { kind: "answers", answers: { missing: 0.25 } }, { kind: "judge_unavailable" }] satisfies JudgeReport[]) {
		test(`accepts ${JSON.stringify(result)}, shows all checked cards, persists check_reported but not the transient report`, async () => {
			const f = fixture();
			await f.connect();
			const run = await startRun(f);
			const ref: DocRef = { kind: "run", run };
			const blocks: readonly BlockId[] = ["b1", "b2"];
			const { version } = await inspect(f, blocks, run);
			const serviceRecords = f.store.readServiceRecords();
			expect(await report(f, version, result, run, blocks)).toEqual({ ok: true, result: null });
			for (const id of blocks) expect(shownReport(f.core, ref, id)).toEqual({ version, result });
			expect(shownReport(f.core, ref, "b3")).toBeNull();
			const entries = reportEntries(f, run);
			expect(entries).toHaveLength(1);
			expect(entries[0]).toEqual({ seq: 3, at: 10_000, origin: "coordinator", data: { type: "check_reported", blocks, version, result } });
			expect(f.core.view(ref).timeline).toContainEqual(entries[0]!);
			expect(f.store.readServiceRecords()).toEqual(serviceRecords);
			const reopened = await f.restart();
			expect(reopened.view(ref).timeline).toContainEqual(entries[0]!);
			for (const id of blocks) expect(shownReport(reopened, ref, id)).toBeNull();
			expect(f.store.readServiceRecords()).toEqual(serviceRecords);
		});
	}

	test("discards report without inspect and a mismatched version without recording or displaying", async () => {
		const f = fixture();
		await f.connect();
		const run = await startRun(f);
		const ref: DocRef = { kind: "run", run };
		expect(await report(f, "0".repeat(64), answers, run)).toEqual({ ok: true, result: null });
		const { version } = await inspect(f, ["b1"], run);
		const different = version === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
		expect(await report(f, different, answers, run)).toEqual({ ok: true, result: null });
		expect(shownReport(f.core, ref)).toBeNull();
		expect(reportEntries(f, run)).toHaveLength(0);
	});

	test("discards an old version after a dependent body edit and accepts a new inspection", async () => {
		const f = fixture();
		await f.connect();
		const run = await startRun(f);
		const ref: DocRef = { kind: "run", run };
		const previous = await inspect(f, ["b1"], run);
		editBody(f, ref, "b2", "changed dependency");
		await settle(f.core);
		const current = await inspect(f, ["b1"], run);
		expect(current.version).not.toBe(previous.version);
		expect(await report(f, previous.version, answers, run)).toEqual({ ok: true, result: null });
		expect(shownReport(f.core, ref)).toBeNull();
		expect(reportEntries(f, run)).toHaveLength(0);
		expect(await report(f, current.version, answers, run)).toEqual({ ok: true, result: null });
		expect(shownReport(f.core, ref)).toEqual({ version: current.version, result: answers });
		expect(reportEntries(f, run)).toHaveLength(1);
	});

	const invalidReports: JudgeReport[] = [
		{ kind: "answers", answers: {} },
		{ kind: "answers", answers: { missing: 0.1, extra: 0.2 } },
		{ kind: "answers", answers: { missing: -0.01 } },
		{ kind: "answers", answers: { missing: 1.01 } },
		{ kind: "answers", answers: { missing: Number.NaN } },
	];
	for (const invalid of invalidReports) {
		test(`returns BadReport for ${JSON.stringify(invalid)} without replacing an accepted report`, async () => {
			const f = fixture();
			await f.connect();
			const run = await startRun(f);
			const ref: DocRef = { kind: "run", run };
			const { version } = await inspect(f, ["b1"], run);
			expect(await report(f, version, answers, run)).toEqual({ ok: true, result: null });
			expect(await report(f, version, invalid, run)).toMatchObject({ ok: false, error: { code: "BadReport" } });
			expect(shownReport(f.core, ref)).toEqual({ version, result: answers });
			expect(reportEntries(f, run)).toHaveLength(1);
		});
	}
});

describe("Core checks: report invalidation (checks.md §4–§5)", () => {
	test("clears a displayed report after a transitive dependency body changes, not an unrelated body or title", async () => {
		const f = fixture([block("b1", "((b2))"), block("b2", "((b3))"), block("b3", "deep dependency"), block("b4", "unrelated")]);
		await f.connect();
		const { version } = await inspect(f);
		expect(await report(f, version)).toEqual({ ok: true, result: null });
		editBody(f, template, "b4", "unrelated change");
		expect(f.core.pencil(template, "b3", "title")).toBeNull();
		expect(f.core.setDraft(template, "b3", "Changed title")).toBeNull();
		expect(f.core.commit(template, "b3")).toBeNull();
		await settle(f.core);
		expect(shownReport(f.core, template)).toEqual({ version, result: answers });
		editBody(f, template, "b3", "changed deep dependency");
		await settle(f.core);
		expect(shownReport(f.core, template)).toBeNull();
	});

	test("an edit followed by restoring the old body does not revive the old inspection", async () => {
		const f = fixture();
		await f.connect();
		const run = await startRun(f);
		const ref: DocRef = { kind: "run", run };
		const { version } = await inspect(f, ["b1"], run);
		expect(await report(f, version, answers, run)).toEqual({ ok: true, result: null });
		editBody(f, ref, "b2", "temporarily changed");
		await settle(f.core);
		expect(shownReport(f.core, ref)).toBeNull();
		editBody(f, ref, "b2", "dependency material");
		await settle(f.core);
		expect(await report(f, version, answers, run)).toEqual({ ok: true, result: null });
		expect(reportEntries(f, run)).toHaveLength(1);
		expect(shownReport(f.core, ref)).toBeNull();
	});

	for (const entry of ["coordinator", "human"] as const) {
		test(`${entry} refetch clears a displayed report even when fetch content and timestamp are identical`, async () => {
			const f = fixture([block("b1", "Review ((b2))"), block("b2", "((file:material.txt))")]);
			await f.connect();
			const run = await startRun(f);
			const ref: DocRef = { kind: "run", run };
			const { version } = await inspect(f, ["b1"], run);
			expect(f.fetchCalls()).toBe(1);
			expect(await report(f, version, answers, run)).toEqual({ ok: true, result: null });
			expect(shownReport(f.core, ref)).toEqual({ version, result: answers });
			if (entry === "coordinator") {
				expect(await f.request({ op: "refetch", args: { targets: ["file:material.txt"] } })).toEqual({ ok: true, result: { fetched: [{ target: "file:material.txt", ok: true }] } });
			} else {
				expect(await f.core.refetch(ref, "file:material.txt")).toBeNull();
			}
			await settle(f.core);
			expect(f.fetchCalls()).toBe(2);
			expect(shownReport(f.core, ref)).toBeNull();
			expect(reportEntries(f, run)).toHaveLength(1);
		});
	}

	test("discards an in-flight old report after a same-outcome refetch, until a fresh inspect", async () => {
		const f = fixture([block("b1", "((file:material.txt))")]);
		await f.connect();
		const run = await startRun(f);
		const ref: DocRef = { kind: "run", run };
		const old = await inspect(f, ["b1"], run);
		success(await f.request({ op: "refetch", args: { targets: ["file:material.txt"] } }));
		await settle(f.core);
		expect(f.fetchCalls()).toBe(2);
		expect(await report(f, old.version, answers, run)).toEqual({ ok: true, result: null });
		expect(reportEntries(f, run)).toHaveLength(0);
		expect(shownReport(f.core, ref)).toBeNull();
		const current = await inspect(f, ["b1"], run);
		expect(await report(f, current.version, answers, run)).toEqual({ ok: true, result: null });
		expect(shownReport(f.core, ref)).toEqual({ version: current.version, result: answers });
	});
});

describe("Core checks: human check requests (checks.md §4; K1)", () => {
	test("sends selected block ids and run:null for the template, then the Run id for a Run", async () => {
		const f = fixture();
		await f.connect();
		expect(f.core.requestCheck(template, ["b1", "b2"])).toBeNull();
		expect(f.events).toEqual([{ event: "check_requested", data: { run: null, blocks: ["b1", "b2"] } }]);
		const run = await startRun(f);
		expect(f.core.requestCheck({ kind: "run", run }, ["b2"])).toBeNull();
		expect(f.events.at(-1)).toEqual({ event: "check_requested", data: { run, blocks: ["b2"] } });
		expect(f.store.readRunLog(run).entries.at(-1)?.data).toEqual({ type: "event_sent", event: "check_requested", data: { run, blocks: ["b2"] } });
	});

	test("returns 没有协调者连接 without hello and after disconnect, and sends no event", async () => {
		const f = fixture();
		expect(f.core.requestCheck(template, ["b1"])).toBe("没有协调者连接");
		f.core.connected(f.connection);
		expect(f.core.requestCheck(template, ["b1"])).toBe("没有协调者连接");
		await f.connect();
		f.core.disconnected(f.connection);
		expect(f.core.requestCheck(template, ["b1"])).toBe("没有协调者连接");
		expect(f.events).toEqual([]);
	});
});
