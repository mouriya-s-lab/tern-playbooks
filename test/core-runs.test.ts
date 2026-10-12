import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BlockContent, DocRef, FetchOutcome, PlaybookDoc, Revision, RunId, RunMeta, TimelineEntry } from "../src/domain/model";
import type { Connection } from "../src/domain/ports";
import type { ErrorCode, EventPayload, Outcome, Request, RunSummary } from "../src/domain/protocol";
import { checks } from "../src/service/checks";
import { Core, type PaneControl } from "../src/service/core";
import { references } from "../src/service/references";
import { createStore } from "../src/service/store";

const BASE_TIME = Date.parse("2026-10-11T00:00:00.000Z");
const template: PlaybookDoc = {
	title: "Night operations",
	blocks: [
		{ id: "b1", title: "Prepare", content: { kind: "task", body: "First line\nSecond line\n" }, done: true },
		{ id: "b2", title: "Execute", content: { kind: "task", body: "Review ((b1))" }, done: false },
	],
};
const designTemplate: PlaybookDoc = {
	...template,
	blocks: [
		...template.blocks,
		{
			id: "b3", title: "Deployment design", done: true,
			content: { kind: "design", requirement: "Keep the service available.\n", design: "## A Rollout\n\nDeploy one instance at a time.\n" },
		},
	],
};
const templateRef: DocRef = { kind: "template" };
const runRef: DocRef = { kind: "run", run: "r1" };
const fixtures: { readonly directory: string; readonly cores: Core[] }[] = [];

function expectOk(outcome: Outcome<unknown>): unknown {
	expect(outcome.ok).toBe(true);
	if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
	return outcome.result;
}
function expectError(outcome: Outcome<unknown>, code: ErrorCode): void {
	expect(outcome.ok).toBe(false);
	if (outcome.ok) throw new Error(`Expected ${code}, got success`);
	expect(outcome.error.code).toBe(code);
}
function fixture(doc: PlaybookDoc = template) {
	const directory = mkdtempSync("/tmp/tern-core-runs-");
	const store = createStore(join(directory, "operations.yaml"));
	store.write(templateRef, store.serialize(doc, null));
	const cores: Core[] = [];
	fixtures.push({ directory, cores });
	let clock = BASE_TIME;
	let fetchCalls = 0;
	const fetched: FetchOutcome = { ok: true, at: BASE_TIME, value: { kind: "file", text: "External instruction" } };
	const panes: PaneControl = {
		ownPane: () => null,
		focusPane: async () => ({ ok: true }),
	};
	function newCore(): Core {
		const core = new Core({
			store, references, checks, panes,
			now: () => clock,
			fetcher: { fetch: async () => { fetchCalls++; return fetched; } },
		});
		cores.push(core);
		expect(core.load()).toBeNull();
		return core;
	}
	const core = newCore();
	const events: EventPayload[] = [];
	const eventWaiters = new Set<(event: EventPayload) => void>();
	const connection: Connection = {
		id: 1,
		send: event => {
			events.push(event);
			for (const notify of eventWaiters) notify(event);
		},
		close: () => {},
	};
	function nextEvent(): Promise<EventPayload> {
		const { promise, resolve } = Promise.withResolvers<EventPayload>();
		const notify = (event: EventPayload) => {
			eventWaiters.delete(notify);
			resolve(event);
		};
		eventWaiters.add(notify);
		return promise;
	}
	let requestNumber = 0;
	const request = (value: Request, target = core) => target.handle(connection, `q${++requestNumber}`, value);
	async function connect(target = core, session = "session-one"): Promise<void> {
		target.connected(connection);
		expectOk(await request({ op: "hello", args: { session } }, target));
	}
	function persisted(run: RunId = "r1") {
		const parsed = store.readRuns().get(run);
		if (!parsed || !parsed.ok || !parsed.run) throw new Error(`Missing persisted Run ${run}`);
		return { doc: parsed.doc, run: parsed.run };
	}
	return { core, store, events, connection, request, connect, persisted, newCore, nextEvent,
		setTime: (value: number) => { clock = value; }, fetchCount: () => fetchCalls };
}

afterEach(() => {
	for (const { cores, directory } of fixtures.splice(0)) {
		for (const core of cores) core.stop();
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Run creation and independent copies (runs.md §§1–2)", () => {
	test("start_run copies every template field, resets done and persists its start before returning", async () => {
		const f = fixture();
		await f.connect();
		expect(expectOk(await f.request({ op: "start_run", args: { name: "First run", update_every: 60 } }))).toEqual({ run: "r1" });
		const copied = template.blocks.map(block => ({ ...block, done: false }));
		expect(f.core.view(runRef).blocks.map(view => view.block)).toEqual(copied);
		expect(f.persisted()).toEqual({
			doc: { ...template, blocks: copied },
			run: { id: "r1", name: "First run", status: "running", startedAt: BASE_TIME, finishedAt: null, updateEvery: 60, updateDue: BASE_TIME + 60_000 },
		});
		expect(f.store.readRunLog("r1").entries).toEqual([{ seq: 1, at: BASE_TIME, origin: "coordinator", data: { type: "run_started", name: "First run" } }]);
		expect(f.events).toEqual([]);
		expect(f.core.pencil(templateRef, "b1", "body")).toBeNull();
		expect(f.core.setDraft(templateRef, "b1", "Changed template")).toBeNull();
		expect(f.core.commit(templateRef, "b1")).toBeNull();
		expect(f.core.view(runRef).blocks[0]!.block.content).toEqual(template.blocks[0]!.content);
		expect(f.core.pencil(runRef, "b2", "title")).toBeNull();
		expect(f.core.setDraft(runRef, "b2", "Changed run")).toBeNull();
		expect(f.core.commit(runRef, "b2")).toBeNull();
		expect(f.core.view(templateRef).blocks[1]!.block.title).toBe("Execute");
		expect(expectOk(await f.request({ op: "start_run", args: { name: "Second run" } }))).toEqual({ run: "r2" });
		expect(f.core.view({ kind: "run", run: "r2" }).blocks[0]!.block.content).toEqual({ kind: "task", body: "Changed template" });
		expect(f.core.view({ kind: "run", run: "r2" }).blocks[1]!.block.title).toBe("Execute");
	});

	test("start_run copies design requirement and design, resets done and keeps later edits independent", async () => {
		const f = fixture(designTemplate);
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "Design snapshot" } }));
		const copied = designTemplate.blocks.map(block => ({ ...block, done: false }));
		expect(f.core.view(runRef).blocks.map(view => view.block)).toEqual(copied);
		expect(f.persisted().doc).toEqual({ ...designTemplate, blocks: copied });
		expect(f.persisted().doc.blocks[2]!.done).toBe(false);

		expect(f.core.pencil(templateRef, "b3", "requirement")).toBeNull();
		expect(f.core.setDraft(templateRef, "b3", "Keep the service and database available.\n")).toBeNull();
		expect(f.core.commit(templateRef, "b3")).toBeNull();
		expect(f.core.view(runRef).blocks[2]!.block.content).toEqual(designTemplate.blocks[2]!.content);
		expectOk(await f.request({ op: "lock", args: { run: "r1", block: "b3" } }));
		expectOk(await f.request({ op: "write", args: { run: "r1", block: "b3", text: "## A Rollout\n\nDeploy the canary first.\n" } }));
		const templateContent: BlockContent = {
			kind: "design", requirement: "Keep the service and database available.\n", design: "## A Rollout\n\nDeploy one instance at a time.\n",
		};
		const runContent: BlockContent = {
			kind: "design", requirement: "Keep the service available.\n", design: "## A Rollout\n\nDeploy the canary first.\n",
		};
		expect(f.core.view(templateRef).blocks[2]!.block.content).toEqual(templateContent);
		expect(f.core.view(runRef).blocks[2]!.block.content).toEqual(runContent);
		f.core.stop();
		expect(f.persisted().doc.blocks[2]!.content).toEqual(runContent);
		const parsedTemplate = f.store.readTemplate();
		expect(parsedTemplate.ok).toBe(true);
		if (!parsedTemplate.ok) throw new Error(parsedTemplate.error);
		expect(parsedTemplate.doc.blocks[2]!.content).toEqual(templateContent);
		expect(parsedTemplate.doc.blocks[2]!.done).toBe(true);
		const restarted = f.newCore();
		expect(restarted.view(templateRef).blocks[2]!.block.content).toEqual(templateContent);
		expect(restarted.view(runRef).blocks[2]!.block.content).toEqual(runContent);
		expect(restarted.view(runRef).blocks[2]!.block.done).toBe(false);
	});

	test("Run revision history starts empty and remains separate from queryable template history after restart", async () => {
		const f = fixture(designTemplate);
		await f.connect();
		expect(f.core.pencil(templateRef, "b3", "prompt")).toBeNull();
		expect(f.core.setDraft(templateRef, "b3", "Explain the rollback plan.")).toBeNull();
		expect(f.core.commit(templateRef, "b3")).toBeNull();
		const templateRevisions: Revision[] = [{ seq: 1, at: BASE_TIME, block: "b3", prompt: "Explain the rollback plan." }];
		expect(expectOk(await f.request({ op: "revisions", args: { block: "b3" } }))).toEqual({ revisions: templateRevisions });
		expectOk(await f.request({ op: "start_run", args: { name: "Fresh revisions" } }));
		expect(expectOk(await f.request({ op: "revisions", args: { run: "r1" } }))).toEqual({ revisions: [] });
		expect(f.core.revisions(runRef, "b3")).toEqual([]);
		expect(f.store.readRevisions(runRef)).toEqual([]);
		expect(expectOk(await f.request({ op: "revisions", args: {} }))).toEqual({ revisions: templateRevisions });

		f.setTime(BASE_TIME + 1_000);
		expect(f.core.pencil(runRef, "b3", "prompt")).toBeNull();
		expect(f.core.setDraft(runRef, "b3", "Add a canary health check.")).toBeNull();
		expect(f.core.commit(runRef, "b3")).toBeNull();
		const runRevisions: Revision[] = [{ seq: 1, at: BASE_TIME + 1_000, block: "b3", prompt: "Add a canary health check." }];
		expect(expectOk(await f.request({ op: "revisions", args: { run: "r1", block: "b3" } }))).toEqual({ revisions: runRevisions });
		expect(f.core.revisions(templateRef, "b3")).toEqual(templateRevisions);
		expect(f.store.readRevisions(templateRef)).toEqual(templateRevisions);
		expect(f.store.readRevisions(runRef)).toEqual(runRevisions);
		expectOk(await f.request({ op: "start_run", args: { name: "Another fresh revision stream" } }));
		expect(expectOk(await f.request({ op: "revisions", args: { run: "r2" } }))).toEqual({ revisions: [] });
		f.core.stop();
		const restarted = f.newCore();
		await f.connect(restarted, "session-restarted");
		expect(expectOk(await f.request({ op: "revisions", args: { block: "b3" } }, restarted))).toEqual({ revisions: templateRevisions });
		expect(expectOk(await f.request({ op: "revisions", args: { run: "r1", block: "b3" } }, restarted))).toEqual({ revisions: runRevisions });
		expect(expectOk(await f.request({ op: "revisions", args: { run: "r2" } }, restarted))).toEqual({ revisions: [] });
	});

	test("read returns flattened task and design wire blocks with kind, without revision history", async () => {
		const f = fixture(designTemplate);
		await f.connect();
		expect(f.core.pencil(templateRef, "b3", "prompt")).toBeNull();
		expect(f.core.setDraft(templateRef, "b3", "Describe deployment risks.")).toBeNull();
		expect(f.core.commit(templateRef, "b3")).toBeNull();
		const task = { id: "b1", kind: "task", title: "Prepare", body: "First line\nSecond line\n", done: true };
		const design = {
			id: "b3", kind: "design", title: "Deployment design", done: true,
			requirement: "Keep the service available.\n", design: "## A Rollout\n\nDeploy one instance at a time.\n",
		};
		const wireBlocks = [task, { id: "b2", kind: "task", title: "Execute", body: "Review ((b1))", done: false }, design];
		expect(expectOk(await f.request({ op: "read", args: {} }))).toEqual({ title: designTemplate.title, blocks: wireBlocks });
		expect(expectOk(await f.request({ op: "read", args: { block: "b1" } }))).toEqual(task);
		expect(expectOk(await f.request({ op: "read", args: { block: "b3" } }))).toEqual(design);
		expectOk(await f.request({ op: "start_run", args: { name: "Wire snapshot" } }));
		expect(expectOk(await f.request({ op: "read", args: { run: "r1" } }))).toEqual({
			title: designTemplate.title, blocks: wireBlocks.map(block => ({ ...block, done: false })), run: f.persisted().run,
		});
		expect(expectOk(await f.request({ op: "read", args: { run: "r1", block: "b1" } }))).toEqual({ ...task, done: false });
		expect(expectOk(await f.request({ op: "read", args: { run: "r1", block: "b3" } }))).toEqual({ ...design, done: false });
	});

	test("human start emits run_started and persists its full event record", async () => {
		const f = fixture();
		await f.connect();
		expect(f.core.startRun("Human run", null)).toBeNull();
		expect(f.events).toEqual([{ event: "run_started", data: { run: "r1", name: "Human run" } }]);
		expect(f.core.view(runRef).timeline).toEqual([
			{ seq: 1, at: BASE_TIME, origin: "human", data: { type: "run_started", name: "Human run" } },
			{ seq: 2, at: BASE_TIME, origin: "service", data: { type: "event_sent", event: "run_started", data: { run: "r1", name: "Human run" } } },
		]);
		expect(f.persisted().run.updateDue).toBeNull();
		expect(f.store.readRunLog("r1").entries).toEqual([...f.core.view(runRef).timeline]);
	});

	test("human done changes send events but coordinator set only appends its change", async () => {
		const f = fixture();
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "Checklist" } }));
		expect(f.core.setDone(runRef, "b1", true)).toBeNull();
		expect(f.core.setDone(runRef, "b1", false)).toBeNull();
		expect(f.events).toEqual([
			{ event: "done_changed", data: { run: "r1", block: "b1", done: true } },
			{ event: "done_changed", data: { run: "r1", block: "b1", done: false } },
		]);
		expectOk(await f.request({ op: "lock", args: { run: "r1", block: "b1" } }));
		expectOk(await f.request({ op: "set", args: { run: "r1", block: "b1", field: "done", value: true } }));
		expect(f.events).toHaveLength(2);
		expect(f.core.view(runRef).timeline.filter(entry => entry.data.type === "done_changed").map(entry => ({ origin: entry.origin, data: entry.data }))).toEqual([
			{ origin: "human", data: { type: "done_changed", block: "b1", done: true } },
			{ origin: "human", data: { type: "done_changed", block: "b1", done: false } },
			{ origin: "coordinator", data: { type: "done_changed", block: "b1", done: true } },
		]);
		f.core.stop();
		expect(f.persisted().doc.blocks[0]!.done).toBe(true);
	});
});

describe("Run finish and late records (runs.md §§2,4,6)", () => {
	test("finish_run closes all open launches as service, releases locks and discards drafts", async () => {
		const f = fixture({ ...template, blocks: [{ ...template.blocks[0]!, content: { kind: "task", body: "Read ((file:instructions.txt))" } }, template.blocks[1]!] });
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "Finish", update_every: 30 } }));
		expectOk(await f.request({ op: "launch", args: { run: "r1", blocks: ["b1"] } }));
		expectOk(await f.request({ op: "launch", args: { run: "r1", blocks: ["b2"] } }));
		expect(f.fetchCount()).toBe(1);
		expect(f.core.launchInfo("l1")!.snapshot.result.text).toContain("External instruction");
		expect(f.core.pencil(runRef, "b1", "body")).toBeNull();
		expect(f.core.setDraft(runRef, "b1", "Uncommitted replacement")).toBeNull();
		expectOk(await f.request({ op: "lock", args: { run: "r1", block: "b2" } }));
		f.setTime(BASE_TIME + 5_000);
		expectOk(await f.request({ op: "finish_run", args: { run: "r1" } }));
		expect(f.persisted().run).toMatchObject({ status: "finished", finishedAt: BASE_TIME + 5_000, updateDue: null });
		for (const launch of ["l1", "l2"] as const) {
			expect(f.core.launchInfo(launch)!.closed).toEqual({ at: BASE_TIME + 5_000, by: "run_finished" });
			expect(f.store.readRunLog("r1").launches.get(launch)!.closed).toEqual({ at: BASE_TIME + 5_000, by: "run_finished" });
		}
		expect(f.core.view(runRef).timeline.filter(entry => entry.data.type === "launch_closed")).toEqual([
			{ seq: 4, at: BASE_TIME + 5_000, origin: "service", data: { type: "launch_closed", launch: "l1" } },
			{ seq: 5, at: BASE_TIME + 5_000, origin: "service", data: { type: "launch_closed", launch: "l2" } },
		]);
		expect(f.core.view(runRef).blocks.map(block => block.lock)).toEqual([{ kind: "none" }, { kind: "none" }]);
		expect(f.core.view(runRef).blocks[0]!.notices).toContain("Run 已结束，未提交的修改已丢弃");
		expect(f.core.view(runRef).blocks[0]!.block.content).toEqual({ kind: "task", body: "Read ((file:instructions.txt))" });
		expect(f.core.commit(runRef, "b1")).not.toBeNull();
		expect(f.events).toEqual([]);
	});

	test("finished blocks reject every modification and launch, but late post still succeeds", async () => {
		const f = fixture();
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "Immutable" } }));
		expect(f.core.finishRun("r1")).toBeNull();
		expect(f.events).toEqual([{ event: "run_finished", data: { run: "r1" } }]);
		const mutations: Request[] = [
			{ op: "lock", args: { run: "r1", block: "b1" } },
			{ op: "set", args: { run: "r1", block: "b1", field: "title", value: "Changed" } },
			{ op: "set", args: { run: "r1", block: "b1", field: "done", value: true } },
			{ op: "edit", args: { run: "r1", block: "b1", find: "First", replace: "Other" } },
			{ op: "insert", args: { run: "r1", title: "New", content: { kind: "task", body: "New" } } },
			{ op: "delete", args: { run: "r1", block: "b1" } },
			{ op: "launch", args: { run: "r1", blocks: ["b1"] } },
			{ op: "finish_run", args: { run: "r1" } },
		];
		for (const mutation of mutations) expectError(await f.request(mutation), "RunFinished");
		expect(f.core.pencil(runRef, "b1", "title")).toBe("Run 已结束");
		expect(f.core.setDone(runRef, "b1", true)).toBe("Run 已结束");
		expect(f.core.deleteBlock(runRef, "b1")).toBe("Run 已结束");
		expect(f.core.insertBlock(runRef, null, "task")).toBe("Run 已结束");
		expectOk(await f.request({ op: "post", args: { run: "r1", kind: "result", text: "Late subagent result", block: "b1" } }));
		expect(f.core.post("r1", "failure", "Human follow-up", null, null)).toBeNull();
		expect(f.core.view(runRef).blocks[0]!.latestRecord!.data).toMatchObject({ type: "post", kind: "result", text: "Late subagent result" });
		expect(f.core.view(runRef).blocks.map(view => view.block)).toEqual(template.blocks.map(block => ({ ...block, done: false })));
		expect(f.store.readRunLog("r1").entries).toEqual([...f.core.view(runRef).timeline]);
	});

	test("retrospective is rejected while running and accepted only after finish", async () => {
		const f = fixture();
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "Review" } }));
		expectError(await f.request({ op: "post", args: { run: "r1", kind: "retrospective", text: "Premature" } }), "BadValue");
		expect(f.core.post("r1", "retrospective", "Also premature", null, null)).not.toBeNull();
		expect(f.core.view(runRef).timeline).toHaveLength(1);
		expectOk(await f.request({ op: "finish_run", args: { run: "r1" } }));
		expect(f.core.runs()[0]!.retrospective).toBe(false);
		expectOk(await f.request({ op: "post", args: { run: "r1", kind: "retrospective", text: "Lessons" } }));
		expect(f.core.view(runRef).retrospective).toBe(true);
		expect(f.core.runs()[0]!.retrospective).toBe(true);
	});
});

describe("Status updates and snooze (runs.md §6)", () => {
	test("update uses explicit next before default, preserves update_every and ignores reminders after finish", async () => {
		const f = fixture();
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "Updates", update_every: 60 } }));
		f.setTime(BASE_TIME + 10_000);
		expectOk(await f.request({ op: "post", args: { run: "r1", kind: "update", text: "Explicit", next: 20 } }));
		expect(f.persisted().run.updateDue).toBe(BASE_TIME + 30_000);
		expect(f.persisted().run.updateEvery).toBe(60);
		f.setTime(BASE_TIME + 15_000);
		expect(f.core.post("r1", "update", "Default", null, null)).toBeNull();
		expect(f.persisted().run.updateDue).toBe(BASE_TIME + 75_000);
		expect(f.core.view(runRef).lastUpdateAt).toBe(BASE_TIME + 15_000);
		expectOk(await f.request({ op: "finish_run", args: { run: "r1" } }));
		f.setTime(BASE_TIME + 20_000);
		expectOk(await f.request({ op: "post", args: { run: "r1", kind: "update", text: "Late update", next: 10 } }));
		expect(f.persisted().run.updateDue).toBeNull();
		expect(f.core.view(runRef).lastUpdateAt).toBe(BASE_TIME + 20_000);
	});

	test("without a default interval, updates leave null or an existing explicit due unchanged", async () => {
		const f = fixture();
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "Optional reminders" } }));
		expectOk(await f.request({ op: "post", args: { run: "r1", kind: "update", text: "No schedule" } }));
		expect(f.persisted().run.updateDue).toBeNull();
		expectOk(await f.request({ op: "post", args: { run: "r1", kind: "update", text: "One-off schedule", next: 30 } }));
		f.setTime(BASE_TIME + 5_000);
		expect(f.core.post("r1", "update", "No next", null, null)).toBeNull();
		expect(f.persisted().run).toMatchObject({ updateEvery: null, updateDue: BASE_TIME + 30_000 });
		expectError(await f.request({ op: "post", args: { run: "r1", kind: "result", text: "Invalid next", next: 10 } }), "BadValue");
		expect(f.core.view(runRef).timeline.filter(entry => entry.data.type === "post")).toHaveLength(3);
	});

	test("snooze reschedules from now, records its origin, and returns BadValue without a due", async () => {
		const f = fixture();
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "Snoozable", update_every: 60 } }));
		f.setTime(BASE_TIME + 5_000);
		expect(expectOk(await f.request({ op: "snooze", args: { run: "r1", after: 20 } }))).toEqual({ due: BASE_TIME + 25_000 });
		expect(f.persisted().run.updateDue).toBe(BASE_TIME + 25_000);
		f.setTime(BASE_TIME + 10_000);
		expect(f.core.snooze("r1", 40)).toBeNull();
		expect(f.persisted().run.updateDue).toBe(BASE_TIME + 50_000);
		expect(f.core.view(runRef).timeline.filter(entry => entry.data.type === "update_snoozed")).toEqual([
			{ seq: 2, at: BASE_TIME + 5_000, origin: "coordinator", data: { type: "update_snoozed", due: BASE_TIME + 25_000 } },
			{ seq: 3, at: BASE_TIME + 10_000, origin: "human", data: { type: "update_snoozed", due: BASE_TIME + 50_000 } },
		]);
		expectOk(await f.request({ op: "start_run", args: { name: "No due" } }));
		expectError(await f.request({ op: "snooze", args: { run: "r2", after: 10 } }), "BadValue");
		expect(f.core.snooze("r2", 10)).not.toBeNull();
		expectOk(await f.request({ op: "finish_run", args: { run: "r1" } }));
		expectError(await f.request({ op: "snooze", args: { run: "r1", after: 10 } }), "BadValue");
		expect(f.core.snooze("r1", 10)).not.toBeNull();
	});

	// These integration cases exercise Core's platform timer; `now` controls metadata only.
	// Await the connection's actual event rather than guessing how long scheduling takes.
	test("a due sends its exact event once, stays overdue and can be rescheduled", async () => {
		const f = fixture();
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "Timed", update_every: 1 } }));
		expectOk(await f.request({ op: "post", args: { run: "r1", kind: "update", text: "Current progress" } }));
		f.setTime(BASE_TIME + 1_000);
		await f.nextEvent();
		expect(f.events).toEqual([{ event: "update_due", data: { run: "r1", due: BASE_TIME + 1_000, last_update: BASE_TIME } }]);
		expect(f.core.view(runRef).timeline.filter(entry => entry.data.type === "update_due")).toEqual([
			{ seq: 3, at: BASE_TIME + 1_000, origin: "service", data: { type: "update_due", due: BASE_TIME + 1_000 } },
		]);
		expect(f.persisted().run.updateDue).toBe(BASE_TIME + 1_000);
		expect(f.core.runs()[0]!.update_overdue).toBe(true);
		expect(f.events).toHaveLength(1);
		expect(f.store.readRunLog("r1").entries.filter(entry => entry.data.type === "update_due")).toHaveLength(1);
		expectOk(await f.request({ op: "snooze", args: { run: "r1", after: 1 } }));
		f.setTime(BASE_TIME + 2_000);
		await f.nextEvent();
		expect(f.events).toEqual([
			{ event: "update_due", data: { run: "r1", due: BASE_TIME + 1_000, last_update: BASE_TIME } },
			{ event: "update_due", data: { run: "r1", due: BASE_TIME + 2_000, last_update: BASE_TIME } },
		]);
		expect(f.store.readRunLog("r1").entries.filter(entry => entry.data.type === "update_due")).toHaveLength(2);
	});

	test("restart immediately records an overdue unrecorded value, never replays disconnected events or duplicates it", async () => {
		const f = fixture();
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "Restart", update_every: 1 } }));
		f.core.disconnected(f.connection);
		f.core.stop();
		f.setTime(BASE_TIME + 2_000);
		const restarted = f.newCore();
		expect(f.store.readRunLog("r1").entries.filter(entry => entry.data.type === "update_due")).toEqual([
			{ seq: 2, at: BASE_TIME + 2_000, origin: "service", data: { type: "update_due", due: BASE_TIME + 1_000 } },
		]);
		expect(f.events).toEqual([]);
		await f.connect(restarted, "session-restarted");
		expect(f.events).toEqual([]);
		expect(expectOk(await f.request({ op: "runs", args: {} }, restarted))).toEqual({ runs: restarted.runs() });
		expect(restarted.runs()[0]!).toMatchObject({ update_due: BASE_TIME + 1_000, update_overdue: true });
		restarted.stop();
		const secondRestart = f.newCore();
		expect(secondRestart.view(runRef).timeline.filter(entry => entry.data.type === "update_due")).toHaveLength(1);
		expect(f.store.readRunLog("r1").entries.filter(entry => entry.data.type === "update_due")).toHaveLength(1);
	});

	test("restart catches up a changed due even if a different due was recorded, and ignores finished Runs", async () => {
		const f = fixture();
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "New due", update_every: 60 } }));
		f.core.stop();
		f.store.appendEntry("r1", { seq: 2, at: BASE_TIME - 1_000, origin: "service", data: { type: "update_due", due: BASE_TIME - 1_000 } });
		f.setTime(BASE_TIME + 61_000);
		const restarted = f.newCore();
		expect(restarted.view(runRef).timeline.filter(entry => entry.data.type === "update_due").map(entry => entry.data)).toEqual([
			{ type: "update_due", due: BASE_TIME - 1_000 }, { type: "update_due", due: BASE_TIME + 60_000 },
		]);
		expect(restarted.finishRun("r1")).toBeNull();
		restarted.stop();
		const finishedRestart = f.newCore();
		expect(finishedRestart.view(runRef).run!.updateDue).toBeNull();
		expect(finishedRestart.view(runRef).timeline.filter(entry => entry.data.type === "update_due")).toHaveLength(2);
	});

	test("finishing before the deadline prevents a later due event and log", async () => {
		const f = fixture();
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "No reminder after finish", update_every: 1 } }));
		expectOk(await f.request({ op: "start_run", args: { name: "Live timer control", update_every: 1 } }));
		expectOk(await f.request({ op: "finish_run", args: { run: "r1" } }));
		f.setTime(BASE_TIME + 2_000);
		await f.nextEvent();
		expect(f.events).toEqual([{ event: "update_due", data: { run: "r2", due: BASE_TIME + 1_000, last_update: null } }]);
		expect(f.store.readRunLog("r1").entries.filter(entry => entry.data.type === "update_due")).toEqual([]);
	});
});

describe("Run persistence, timeline and summaries (runs.md §§3,5–7)", () => {
	test("Run mapping is already on disk before each start/update/snooze/due/finish timeline append", async () => {
		const f = fixture();
		await f.connect();
		const observed: { readonly entry: TimelineEntry; readonly meta: RunMeta; readonly alreadyLogged: boolean }[] = [];
		const append = f.store.appendEntry.bind(f.store);
		f.store.appendEntry = (run, entry) => {
			observed.push({ entry, meta: f.persisted(run).run, alreadyLogged: f.store.readRunLog(run).entries.some(prior => prior.seq === entry.seq) });
			append(run, entry);
		};
		expectOk(await f.request({ op: "start_run", args: { name: "Ordered writes", update_every: 60 } }));
		f.setTime(BASE_TIME + 1_000);
		expectOk(await f.request({ op: "post", args: { run: "r1", kind: "update", text: "Reschedule", next: 20 } }));
		f.setTime(BASE_TIME + 2_000);
		expectOk(await f.request({ op: "snooze", args: { run: "r1", after: 1 } }));
		f.setTime(BASE_TIME + 3_000);
		await f.nextEvent();
		expectOk(await f.request({ op: "finish_run", args: { run: "r1" } }));
		expect(observed.every(observation => !observation.alreadyLogged)).toBe(true);
		expect(observed.filter(observation => observation.entry.data.type !== "event_sent").map(({ entry, meta }) => ({ type: entry.data.type, status: meta.status, due: meta.updateDue, finished: meta.finishedAt }))).toEqual([
			{ type: "run_started", status: "running", due: BASE_TIME + 60_000, finished: null },
			{ type: "post", status: "running", due: BASE_TIME + 21_000, finished: null },
			{ type: "update_snoozed", status: "running", due: BASE_TIME + 3_000, finished: null },
			{ type: "update_due", status: "running", due: BASE_TIME + 3_000, finished: null },
			{ type: "run_finished", status: "finished", due: null, finished: BASE_TIME + 3_000 },
		]);
		expect(f.store.readRunLog("r1").entries).toEqual([...f.core.view(runRef).timeline]);
	});

	test("post retains quote, human origin and current session; timeline after is exclusive and omits launch records", async () => {
		const f = fixture();
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "Messages" } }));
		expectOk(await f.request({ op: "launch", args: { run: "r1", blocks: ["b1"] } }));
		expect(expectOk(await f.request({ op: "post", args: { run: "r1", kind: "result", text: "Entire selected message\nSecond line", block: "b1", launch: "l1", quote: "message-42", origin: "human" } }))).toEqual({ seq: 3 });
		f.core.disconnected(f.connection);
		await f.connect(f.core, "session-two");
		expect(expectOk(await f.request({ op: "post", args: { run: "r1", kind: "failure", text: "Coordinator message", quote: "message-43" } }))).toEqual({ seq: 4 });
		expect(f.core.post("r1", "result", "Direct human note", "b2", null)).toBeNull();
		const entries = f.core.view(runRef).timeline;
		expect(entries[2]).toEqual({ seq: 3, at: BASE_TIME, origin: "human", data: { type: "post", kind: "result", text: "Entire selected message\nSecond line", block: "b1", launch: "l1", quote: "message-42", session: "session-one" } });
		expect(entries[3]).toEqual({ seq: 4, at: BASE_TIME, origin: "coordinator", data: { type: "post", kind: "failure", text: "Coordinator message", quote: "message-43", session: "session-two" } });
		expect(entries[4]).toEqual({ seq: 5, at: BASE_TIME, origin: "human", data: { type: "post", kind: "result", text: "Direct human note", block: "b2" } });
		for (const after of [undefined, 0, 2, 3, 5, 100]) {
			expect(expectOk(await f.request({ op: "timeline", args: { run: "r1", ...(after === undefined ? {} : { after }) } }))).toEqual({ entries: entries.filter(entry => entry.seq > (after ?? 0)) });
		}
		expect(f.store.readRunLog("r1").launches.size).toBe(1);
		expect(f.store.readRunLog("r1").entries).toEqual([...entries]);
		expectError(await f.request({ op: "timeline", args: { run: "r99" } }), "UnknownRun");
	});

	test("runs exposes complete running/finished summaries, done counts, overdue and retrospective state", async () => {
		const f = fixture();
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "Running", update_every: 60 } }));
		expect(f.core.setDone(runRef, "b2", true)).toBeNull();
		expectOk(await f.request({ op: "start_run", args: { name: "Finished" } }));
		f.setTime(BASE_TIME + 61_000);
		expectOk(await f.request({ op: "finish_run", args: { run: "r2" } }));
		const summaries: RunSummary[] = [
			{ id: "r1", name: "Running", status: "running", started_at: BASE_TIME, finished_at: null, done: 1, total: 2, update_due: BASE_TIME + 60_000, update_overdue: true, retrospective: false },
			{ id: "r2", name: "Finished", status: "finished", started_at: BASE_TIME, finished_at: BASE_TIME + 61_000, done: 0, total: 2, update_due: null, update_overdue: false, retrospective: false },
		];
		expect(f.core.runs()).toEqual(summaries);
		expect(expectOk(await f.request({ op: "runs", args: {} }))).toEqual({ runs: summaries });
		expectOk(await f.request({ op: "post", args: { run: "r2", kind: "retrospective", text: "Complete review" } }));
		expect(f.core.runs()[1]).toEqual({ ...summaries[1]!, retrospective: true });
	});
});
