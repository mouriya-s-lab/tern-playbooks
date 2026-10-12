import { expect, test } from "bun:test";
import { createPlaybook, type PlaybookDeps } from "../src/extension/eval-prelude";

type Call = { readonly kind: "tool"; readonly name: string; readonly args: Record<string, unknown> }
	| { readonly kind: "agent"; readonly prompt: string; readonly options: Parameters<PlaybookDeps["agent"]>[1] }
	| { readonly kind: "wait" };

function harness(context: { doc?: string; run?: string; launch?: string } = { doc: "/book.yaml", run: "r1" }) {
	const calls: Call[] = [];
	const outcome = Promise.withResolvers<unknown>();
	const waiting = Promise.withResolvers<void>();
	const binding = Promise.withResolvers<void>();
	const bound = Promise.withResolvers<void>();
	let holdBind = false;
	let launchKind = "prompt";
	let toolFailure: { code: string; message: string } | undefined;
	let agentFailure: Error | undefined;
	const deps: PlaybookDeps = {
		...context,
		tool: {
			playbook_launch: async args => {
				calls.push({ kind: "tool", name: "playbook_launch", args });
				if (toolFailure) return JSON.stringify({ error: toolFailure });
				if (args.op === "launch") return JSON.stringify({ launch: "l1", kind: launchKind, text: "Frozen prompt" });
				if (args.op === "info") return JSON.stringify({ run: "r2", kind: launchKind, snapshot: { result: { text: "Existing snapshot" } } });
				if (args.op === "bind") { binding.resolve(); if (holdBind) await bound.promise; }
				return "null";
			},
			playbook_timeline: async args => {
				calls.push({ kind: "tool", name: "playbook_timeline", args });
				return JSON.stringify({ seq: 7 });
			},
			playbook_read: async args => {
				calls.push({ kind: "tool", name: "playbook_read", args });
				return JSON.stringify({ title: "Book", blocks: [] });
			},
		},
		agent: async (prompt, options) => {
			calls.push({ kind: "agent", prompt, options });
			if (agentFailure) throw agentFailure;
			return { id: "worker-1", wait: async () => { calls.push({ kind: "wait" }); waiting.resolve(); return outcome.promise; } };
		},
	};
	return {
		playbook: createPlaybook(deps), calls, outcome, waiting: waiting.promise, binding: binding.promise, bound,
		set holdBind(value: boolean) { holdBind = value; },
		set launchKind(value: string) { launchKind = value; },
		set toolFailure(value: typeof toolFailure) { toolFailure = value; },
		set agentFailure(value: Error | undefined) { agentFailure = value; },
	};
}

test("agent() failing on a Launch it created closes that Launch and names the agent option; spawn leaves an existing Launch open", async () => {
	const h = harness(); h.agentFailure = new Error('Agent "task" is disabled in settings');
	await expect(h.playbook.agent({ blocks: ["b1"] })).rejects.toThrow(/Agent "task" is disabled in settings[\s\S]*agent: "task:mid"/);
	expect(h.calls).toEqual([
		{ kind: "tool", name: "playbook_launch", args: { doc: "/book.yaml", run: "r1", op: "launch", blocks: ["b1"] } },
		{ kind: "agent", prompt: "Frozen prompt", options: {} },
		{ kind: "tool", name: "playbook_launch", args: { doc: "/book.yaml", op: "close", launch: "l1" } },
	]);
	h.calls.length = 0;
	await expect(h.playbook.spawn("l1")).rejects.toThrow('Agent "task" is disabled in settings');
	expect(h.calls.some(call => call.kind === "tool" && call.args.op === "close")).toBe(false);
	expect(h.calls.some(call => call.kind === "tool" && call.args.op === "bind")).toBe(false);
});

test("agent launches, spawns and completes binding before exposing the handle or waiting", async () => {
	const h = harness(); h.holdBind = true;
	const options = { agent: "worker", label: "Task", schema: { type: "string" }, schemaMode: "strict", isolated: false };
	const starting = h.playbook.agent({ blocks: ["b1"], ...options });
	await h.binding;
	expect(h.calls).toEqual([
		{ kind: "tool", name: "playbook_launch", args: { doc: "/book.yaml", run: "r1", op: "launch", blocks: ["b1"] } },
		{ kind: "agent", prompt: "Frozen prompt", options },
		{ kind: "tool", name: "playbook_launch", args: { doc: "/book.yaml", op: "bind", launch: "l1", agent: "worker-1" } },
	]);
	h.bound.resolve(); const spawned = await starting;
	expect(spawned).toMatchObject({ doc: "/book.yaml", run: "r1", launch: "l1", id: "worker-1" });
	const recording = h.playbook.result(spawned, { block: "b1" });
	await h.waiting;
	expect(h.calls.at(-1)).toEqual({ kind: "wait" });
	const answer = { accepted: true, items: [1, 2] };
	h.outcome.resolve(answer);
	expect(await recording).toBe(answer);
	expect(h.calls.at(-1)).toEqual({ kind: "tool", name: "playbook_timeline", args: { doc: "/book.yaml", run: "r1", op: "post", kind: "result", text: JSON.stringify(answer, null, 2), launch: "l1", block: "b1" } });
});

test("wait rejection posts a failure before rethrowing the original error", async () => {
	const h = harness(); const spawned = await h.playbook.agent({ blocks: ["b1"] });
	const recording = h.playbook.result(spawned, { block: "b1" });
	const failure = new Error("subagent failed");
	await h.waiting; h.outcome.reject(failure);
	await expect(recording).rejects.toBe(failure);
	expect(h.calls.slice(-2)).toEqual([
		{ kind: "wait" },
		{ kind: "tool", name: "playbook_timeline", args: { doc: "/book.yaml", run: "r1", op: "post", kind: "failure", text: "subagent failed", launch: "l1", block: "b1" } },
	]);
});

for (const method of ["agent", "spawn"] as const) {
	test(`${method} rejects orchestration before creating or binding a subagent`, async () => {
		const h = harness(); h.launchKind = "orchestration";
		await expect(method === "agent" ? h.playbook.agent({ blocks: ["b1"] }) : h.playbook.spawn("l1")).rejects.toThrow("orchestration");
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]).toMatchObject({ kind: "tool", name: "playbook_launch", args: { op: method === "agent" ? "launch" : "info" } });
	});
}

for (const [blocks, explicit, expected] of [
	[["b1"], undefined, "b1"],
	[["b1", "b2"], undefined, undefined],
	[["b1", "b2"], "b2", "b2"],
	[["b1"], "b2", "b2"],
] as const) {
	test(`run records ${blocks.length} blocks with ${explicit ? "explicit " + explicit : "default block association"}`, async () => {
		const h = harness(); const running = h.playbook.run({ blocks, ...(explicit ? { block: explicit } : {}) });
		await h.waiting; h.outcome.resolve("Result text");
		expect(await running).toBe("Result text");
		expect(h.calls.at(-1)).toEqual({ kind: "tool", name: "playbook_timeline", args: { doc: "/book.yaml", run: "r1", op: "post", kind: "result", text: "Result text", launch: "l1", ...(expected ? { block: expected } : {}) } });
	});
}

test("spawn uses the existing Launch snapshot and Run rather than the coordinator context", async () => {
	const h = harness(); const spawned = await h.playbook.spawn("l1", { doc: "/other.yaml", label: "More work" });
	expect(spawned).toMatchObject({ doc: "/other.yaml", run: "r2", launch: "l1" });
	expect(h.calls).toEqual([
		{ kind: "tool", name: "playbook_launch", args: { doc: "/other.yaml", op: "info", launch: "l1" } },
		{ kind: "agent", prompt: "Existing snapshot", options: { label: "More work" } },
		{ kind: "tool", name: "playbook_launch", args: { doc: "/other.yaml", op: "bind", launch: "l1", agent: "worker-1" } },
	]);
});

test("tool error JSON propagates instead of starting an agent; missing Run fails before requesting a Launch", async () => {
	const h = harness(); h.toolFailure = { code: "RunFinished", message: "Run is finished" };
	await expect(h.playbook.agent({ blocks: ["b1"] })).rejects.toThrow("RunFinished: Run is finished");
	expect(h.calls).toHaveLength(1);
	const noRun = harness({});
	await expect(noRun.playbook.run({ blocks: ["b1"] })).rejects.toThrow("run is required");
	expect(noRun.calls).toEqual([]);
});

test("read, timeline and post decode JSON text and respect explicit scope overrides", async () => {
	const h = harness({ doc: "/book.yaml", run: "r1", launch: "l1" });
	expect(await h.playbook.read({ block: "b1" })).toEqual({ title: "Book", blocks: [] });
	expect(await h.playbook.timeline({ doc: "/other.yaml", run: "r2", after: 0 })).toEqual({ seq: 7 });
	expect(await h.playbook.post({ run: "r2", kind: "update", text: "Working", next: 30 })).toEqual({ seq: 7 });
	expect(h.calls).toEqual([
		{ kind: "tool", name: "playbook_read", args: { doc: "/book.yaml", run: "r1", block: "b1" } },
		{ kind: "tool", name: "playbook_timeline", args: { doc: "/other.yaml", run: "r2", op: "read", after: 0 } },
		{ kind: "tool", name: "playbook_timeline", args: { doc: "/book.yaml", run: "r2", op: "post", kind: "update", text: "Working", next: 30 } },
	]);
});

test("result decodes the eval agent wait JSON envelope before returning or recording text", async () => {
	const h = harness(); const spawned = await h.playbook.agent({ blocks: ["b1"] });
	const recording = h.playbook.result(spawned);
	await h.waiting; h.outcome.resolve(JSON.stringify("hello"));
	expect(await recording).toBe("hello");
	expect(h.calls.at(-1)).toEqual({ kind: "tool", name: "playbook_timeline", args: { doc: "/book.yaml", run: "r1", op: "post", kind: "result", text: "hello", launch: "l1" } });
});
