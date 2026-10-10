import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompileError, EntryData, Launch, PlaybookDoc, RunMeta, TimelineEntry } from "../src/domain/model";
import { createStore } from "../src/service/store";

const directories: string[] = [];
function fixture() {
	const directory = mkdtempSync("/tmp/tern-store-test-");
	directories.push(directory);
	const path = join(directory, "incident.yaml");
	return { directory, path, store: createStore(path) };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const doc: PlaybookDoc = { title: "Incident: #237", blocks: [{ id: "b1", title: "First step", body: "alpha\nbeta\ngamma\n", done: false }] };
const run: RunMeta = { id: "r1", name: "Night shift", status: "running", startedAt: Date.parse("2026-10-11T00:00:00.123Z"), finishedAt: null, updateEvery: 60, updateDue: Date.parse("2026-10-11T00:01:00.123Z") };
const launch: Launch = {
	id: "l1", run: "r1", session: "session-1", blocks: ["b1"], kind: "prompt",
	snapshot: {
		result: { kind: "Ok", text: "snapshot", sources: [
			{ kind: "block", target: "b1", expression: null },
			{ kind: "external", target: "file:a", expression: "L1", fetchedAt: 11 },
			{ kind: "result", target: "b2.result", expression: null, seq: 1, origin: "human", launch: "l2" },
		] },
		fetches: [["file:a", { ok: true, at: 11, value: { kind: "file", text: "fetched\n" } }]],
		results: [["b2", { text: "result", at: 10, seq: 1, origin: "human", launch: "l2" }]],
	},
	agents: [], baselines: ["snapshot"], notified: null, dirty: [], fetches: [], closed: null,
};

describe("YAML persistence", () => {
	for (const body of ["", "plain", "one\ntwo\nthree", "```ts\nconst x = 1;\n```\n", "  first\n    nested\n last ", "\n\n  leading\n", "one\n", "one\n\n", "one\n\n\n\n", "\n", "\n\n", " \n \n", "\tfirst\n\tsecond", "中文 😀 café", "---\n# comment\n: colon\n", "  \n \n   "]) {
		test(`literal body roundtrip ${JSON.stringify(body)}`, () => {
			const { store } = fixture();
			const value = { ...doc, blocks: [{ ...doc.blocks[0]!, body }] };
			const text = store.serialize(value, null);
			expect(text).toContain("body: |2");
			expect(store.parse(text, false)).toEqual({ ok: true, doc: value, run: null });
		});
	}
	for (const body of ["a\r\nb", "a\rb", "a\0b", "a\u0007b", "a\u0085b", "a\u2028b", "a\u2029b", "a\uFFFEb", "a\uFFFFb"]) {
		test(`escaped body roundtrip ${JSON.stringify(body)}`, () => {
			const { store } = fixture();
			const value = { ...doc, blocks: [{ ...doc.blocks[0]!, body }] };
			const text = store.serialize(value, null);
			expect(text).toContain('body: "');
			expect(store.parse(text, false)).toEqual({ ok: true, doc: value, run: null });
		});
	}
	test("all byte-valued code points roundtrip through the escaped fallback", () => {
		const { store } = fixture();
		const body = Array.from({ length: 256 }, (_, code) => String.fromCharCode(code)).join("");
		const value = { ...doc, blocks: [{ ...doc.blocks[0]!, body }] };
		expect(store.parse(store.serialize(value, null), false)).toEqual({ ok: true, doc: value, run: null });
	});
	test("malformed Unicode is rejected before filesystem mutation", () => {
		const { directory, path, store } = fixture();
		const original = store.serialize(doc, null);
		store.write({ kind: "template" }, original);
		for (const text of ["a\uD800b", "a\uDC00b"]) {
			for (const invalid of [
				{ ...doc, title: text },
				{ ...doc, blocks: [{ ...doc.blocks[0]!, title: text }] },
				{ ...doc, blocks: [{ ...doc.blocks[0]!, body: text }] },
			]) {
				expect(() => store.write({ kind: "template" }, store.serialize(invalid, null))).toThrow(RangeError);
				expect(readFileSync(path, "utf8")).toBe(original);
			}
			expect(() => store.write({ kind: "run", run: "r1" }, store.serialize(doc, { ...run, name: text }))).toThrow(RangeError);
			expect(store.stat({ kind: "run", run: "r1" })).toBeNull();
		}
		expect(readdirSync(directory)).toEqual(["incident.yaml"]);
	});
	test("title and run metadata preserve values with ISO timestamps", () => {
		const { store } = fixture();
		const value = { ...doc, title: "\ncolon: \"quoted\" 😀\u0085" };
		const text = store.serialize(value, run);
		expect(text).toContain('started_at: "2026-10-11T00:00:00.123Z"');
		expect(text).toContain("status: running");
		expect(store.parse(text, true)).toEqual({ ok: true, doc: value, run });
		const finished = { ...run, status: "finished" as const, finishedAt: run.startedAt + 1000, updateEvery: null, updateDue: null };
		expect(store.parse(store.serialize(doc, finished), true)).toEqual({ ok: true, doc, run: finished });
	});
	test("empty block sequence is a document", () => {
		const { store } = fixture();
		const value = { title: "", blocks: [] };
		expect(store.parse(store.serialize(value, null), false)).toEqual({ ok: true, doc: value, run: null });
	});
	for (const invalid of ["[", "null", "[]", "title: x\nblocks: {}", "title: 3\nblocks: []", "title: x\nblocks: []\nextra: true", "title: x\nblocks:\n - id: b0\n   title: x\n   body: x\n   done: false", "title: x\nblocks:\n - id: b1\n   title: x\n   body: x\n   done: 1", "title: x\nblocks:\n - id: b1\n   title: x\n   done: false", "title: x\nblocks:\n - {id: b1, title: x, body: x, done: false}\n - {id: b1, title: y, body: y, done: true}"]) {
		test(`invalid document rejects ${JSON.stringify(invalid)}`, () => {
			const { store } = fixture();
			const result = store.parse(invalid, false);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
		});
	}
	test("run metadata validates fields, dates and lifecycle shape", () => {
		const { store } = fixture();
		const text = store.serialize(doc, run);
		for (const invalid of [text.replace("r1", "r0"), text.replace("running", "waiting"), text.replace("2026-10-11", "2026-02-30"), text.replace("update_every: 60", "update_every: 0"), text.replace("finished_at: null", 'finished_at: "2026-10-12T00:00:00Z"'), text.replace("running", "finished"), text.replace("  update_due:", "  extra:")]) expect(store.parse(invalid, true).ok).toBe(false);
		expect(store.parse(text, false).ok).toBe(false);
		expect(store.parse(store.serialize(doc, null), true).ok).toBe(false);
	});
});

describe("filesystem persistence", () => {
	test("write, stat, template and run discovery use their real files", () => {
		const { directory, path, store } = fixture();
		expect(store.stat({ kind: "template" })).toBeNull();
		expect(store.readTemplate().ok).toBe(false);
		expect(store.readRuns().size).toBe(0);
		store.write({ kind: "template" }, store.serialize(doc, null));
		store.write({ kind: "run", run: "r1" }, store.serialize(doc, run));
		expect(readFileSync(path, "utf8")).toBe(store.serialize(doc, null));
		expect(readFileSync(join(directory, "incident.runs/r1.yaml"), "utf8")).toBe(store.serialize(doc, run));
		expect(store.stat({ kind: "template" })).toEqual({ text: store.serialize(doc, null), mtimeMs: statSync(path).mtimeMs });
		expect(store.readTemplate()).toEqual({ ok: true, doc, run: null });
		expect(store.readRuns().get("r1")).toEqual({ ok: true, doc, run });
		writeFileSync(join(directory, "incident.runs/r2.yaml"), store.serialize(doc, run));
		writeFileSync(join(directory, "incident.runs/r3.yaml"), "invalid: true");
		expect(store.readRuns().get("r2")?.ok).toBe(false);
		expect(store.readRuns().get("r3")?.ok).toBe(false);
		writeFileSync(path, "title: x\nblocks: invalid\n");
		expect(store.readTemplate().ok).toBe(false);
	});
	test("replacement is atomic: existing reader keeps old inode, new reader sees complete new text", () => {
		const { directory, path, store } = fixture();
		const oldText = store.serialize(doc, null);
		store.write({ kind: "template" }, oldText);
		const fd = openSync(path, "r");
		try {
			const newText = store.serialize({ ...doc, title: "replacement" }, null);
			store.write({ kind: "template" }, newText);
			expect(readFileSync(fd, "utf8")).toBe(oldText);
			expect(readFileSync(path, "utf8")).toBe(newText);
			expect(readdirSync(directory)).toEqual(["incident.yaml"]);
		} finally { closeSync(fd); }
	});
	test("failed replacement leaves no temporary file and preserves destination", () => {
		const { directory, path, store } = fixture();
		mkdirSync(path);
		expect(() => store.write({ kind: "template" }, "replacement")).toThrow();
		expect(statSync(path).isDirectory()).toBe(true);
		expect(readdirSync(directory)).toEqual(["incident.yaml"]);
	});
	test("changing one body line produces just that removed and added physical line", () => {
		const { store } = fixture();
		const before = store.serialize(doc, null).split("\n");
		const after = store.serialize({ ...doc, blocks: [{ ...doc.blocks[0]!, body: "alpha\nBETA\ngamma\n" }] }, null).split("\n");
		expect(before.length).toBe(after.length);
		expect(before.filter((line, i) => line !== after[i])).toEqual(["      beta"]);
		expect(after.filter((line, i) => line !== before[i])).toEqual(["      BETA"]);
	});
});

describe("append-only facts", () => {
	test("allocated IDs append to the template service record and read back in order", () => {
		const { path, store } = fixture();
		expect(store.readServiceRecords()).toEqual([]);
		const records = [{ kind: "block", id: "b2" }, { kind: "run", id: "r1" }, { kind: "launch", id: "l1" }] as const;
		store.appendServiceRecord(records[0]);
		const prefix = readFileSync(`${path}.pb.jsonl`, "utf8");
		for (const record of records.slice(1)) store.appendServiceRecord(record);
		expect(readFileSync(`${path}.pb.jsonl`, "utf8").startsWith(prefix)).toBe(true);
		expect(store.readServiceRecords()).toEqual([...records]);
		writeFileSync(`${path}.pb.jsonl`, `${prefix}{"kind":"block","id":"b0"}\n`);
		expect(() => store.readServiceRecords()).toThrow(`${path}.pb.jsonl:2:`);
	});
	test("all timeline variants flatten their tag on disk and restore exact payload", () => {
		const { directory, store } = fixture();
		const payloads: EntryData[] = [
			{ type: "run_started", name: "Shift" }, { type: "run_finished" },
			{ type: "block_edited", block: "b1", field: "body", text: "\nnew\n", edit: 1 },
			{ type: "block_added", block: "b2", title: "New", body: "body" },
			{ type: "block_deleted", block: "b2", title: "New", body: "body" },
			{ type: "blocks_reordered", order: ["b2", "b1"] }, { type: "done_changed", block: "b1", done: true },
			{ type: "launch_created", launch: "l1", kind: "prompt", blocks: ["b1"] },
			{ type: "agent_bound", launch: "l1", agent: "agent-1" }, { type: "launch_closed", launch: "l1" },
			{ type: "event_sent", event: "run_started", data: { run: "r1", name: "Shift" } },
			{ type: "interrupted", block: "b1", request: "req" },
			{ type: "check_reported", blocks: ["b1"], version: "v1", result: { kind: "answers", answers: { completeness: 1 } } },
			{ type: "check_reported", blocks: ["b1"], version: "v2", result: { kind: "judge_unavailable" } },
			{ type: "post", kind: "result", text: "line\nline", block: "b1", launch: "l1", quote: "message", session: "session" },
			{ type: "post", kind: "retrospective", text: "Done" },
			{ type: "update_due", due: 100 }, { type: "update_snoozed", due: 200 },
		];
		const entries: TimelineEntry[] = payloads.map((data, index) => ({ seq: index + 1, at: index, origin: "service", data }));
		store.appendEntry("r1", entries[0]!);
		const path = join(directory, "incident.runs/r1.jsonl");
		const prefix = readFileSync(path, "utf8");
		expect(JSON.parse(prefix)).toEqual({ entry: { seq: 1, at: 0, type: "run_started", origin: "service", data: { name: "Shift" } } });
		for (const entry of entries.slice(1)) store.appendEntry("r1", entry);
		expect(readFileSync(path, "utf8").startsWith(prefix)).toBe(true);
		expect(readFileSync(path, "utf8").split("\n").length).toBe(entries.length + 1);
		expect(store.readRunLog("r1").entries).toEqual(entries);
	});
	test("Launch keeps its full nested state; the last line for each Launch wins", () => {
		const { store } = fixture();
		expect(store.readRunLog("r1")).toEqual({ entries: [], launches: new Map() });
		store.appendLaunch("r1", launch);
		store.appendLaunch("r1", { ...launch, id: "l2" });
		const latest: Launch = { ...launch, agents: ["agent-1"], dirty: [["b1", 2]], baselines: ["snapshot", "new baseline"], notified: { kind: "Ok", text: "changed", sources: [] }, fetches: [
			["missing", { ok: false, at: 13, error: "Missing" }],
			["issue", { ok: true, at: 14, value: { kind: "issue", issue: { title: "Issue", body: "Body", comments: [{ author: "A", createdAt: "now", body: "Reply" }] } } }],
		], closed: { at: 15, by: "run_finished" } };
		store.appendLaunch("r1", latest);
		const result = store.readRunLog("r1");
		expect(result.entries).toEqual([]);
		expect(result.launches.get("l1")).toEqual(latest);
		expect(result.launches.get("l2")).toEqual({ ...launch, id: "l2" });
	});
	test("every persisted compile-error variant is decoded", () => {
		const { store } = fixture();
		const at = { block: "b1" as const, reference: "((x))" };
		const errors: CompileError[] = [{ kind: "UnknownBlock", block: "b2", at }, { kind: "UnknownTarget", at }, { kind: "BadExpression", reason: "invalid", at }, { kind: "Cycle", path: ["b1", "b2", "b1"], at }, { kind: "TooDeep", at }, { kind: "NoResult", block: "b2", at }, { kind: "FetchFailed", target: "file:a", error: "missing", at }];
		for (const error of errors) {
			const updated = { ...launch, notified: { kind: "Err" as const, error } };
			store.appendLaunch("r1", updated);
			expect(store.readRunLog("r1").launches.get("l1")).toEqual(updated);
		}
	});
	test("malformed logs do not masquerade as empty or partial valid logs", () => {
		const { directory, store } = fixture();
		mkdirSync(join(directory, "incident.runs"));
		const path = join(directory, "incident.runs/r1.jsonl");
		const valid = JSON.stringify({ entry: { seq: 1, at: 0, type: "run_finished", origin: "service", data: {} } });
		for (const bad of ["{", "", '{"entry":{"seq":2,"at":0,"type":"unknown","origin":"service","data":{}}}', '{"entry":{"seq":2,"at":0,"type":"done_changed","origin":"service","data":{"block":"b1","done":"yes"}}}', valid, JSON.stringify({ launch: { ...launch, run: "r2" } }), JSON.stringify({ launch: { ...launch, dirty: [["b1"]] } })]) {
			writeFileSync(path, `${valid}\n${bad}\n`);
			expect(() => store.readRunLog("r1")).toThrow(`${path}:2:`);
		}
	});
});
