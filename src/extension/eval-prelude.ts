// Runs inside the coordinator's JS `eval` kernel, never in the extension process
// (contracts.md K2 "eval 辅助"). The extension imports it into a cell that uses `playbook.*`.
// It only composes the public playbook_* tools with the kernel's own `agent()`, so the
// document service stays the single owner of Launch state.

type ToolCall = (args: Record<string, unknown>) => Promise<unknown>;
type AgentHandle = { readonly id: string; wait(timeout?: number): Promise<unknown> };
type AgentOptions = { readonly agent?: string; readonly label?: string; readonly schema?: unknown; readonly schemaMode?: string; readonly isolated?: boolean };
type Spawn = (prompt: string, options?: AgentOptions) => Promise<AgentHandle>;
type RecordKind = "update" | "result" | "failure" | "retrospective";

/** Where the cell runs: set by `playbook.exec` for an orchestration Launch, empty otherwise. */
export type PlaybookContext = { readonly doc?: string; readonly run?: string; readonly launch?: string };

export type PlaybookDeps = PlaybookContext & {
	readonly tool: Readonly<Record<string, ToolCall>>;
	readonly agent: Spawn;
};

/** One subagent started for a Launch and already bound to it. */
export type Spawned = { readonly doc?: string; readonly run: string; readonly launch: string; readonly id: string; readonly handle: AgentHandle };

export type AgentRequest = AgentOptions & { readonly doc?: string; readonly run?: string; readonly blocks: readonly string[] };

class PlaybookError extends Error {}

type Created = { readonly launch: string; readonly kind: string; readonly text: string };
type LaunchInfo = { readonly run: string; readonly kind: string; readonly text: string };

function objectOf(value: unknown): object {
	if (typeof value !== "object" || value === null) throw new PlaybookError(`unexpected tool result: ${JSON.stringify(value)}`);
	return value;
}
function stringAt(value: object, key: string): string {
	const field: unknown = key in value ? Reflect.get(value, key) : undefined;
	if (typeof field !== "string") throw new PlaybookError(`tool result has no string ${key}`);
	return field;
}

/** Tool results arrive as the tool's JSON text; `{error}` is a failed call. */
function decode(value: unknown): unknown {
	const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
	if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
		const error: unknown = parsed.error;
		const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "Error";
		const message = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : JSON.stringify(error);
		throw new PlaybookError(`${code}: ${message}`);
	}
	return parsed;
}
function created(value: unknown): Created {
	const result = objectOf(value);
	return { launch: stringAt(result, "launch"), kind: stringAt(result, "kind"), text: stringAt(result, "text") };
}
function launchInfo(value: unknown): LaunchInfo {
	const record = objectOf(value);
	const snapshot = objectOf("snapshot" in record ? record.snapshot : undefined);
	const result = objectOf("result" in snapshot ? snapshot.result : undefined);
	return { run: stringAt(record, "run"), kind: stringAt(record, "kind"), text: stringAt(result, "text") };
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** `handle.wait()` without a schema returns the final text JSON-encoded (`"\"text\""`); decode that layer. */
function unwrap(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try { return JSON.parse(value); } catch { return value; }
}

export function createPlaybook(deps: PlaybookDeps) {
	const context: PlaybookContext = { ...(deps.doc ? { doc: deps.doc } : {}), ...(deps.run ? { run: deps.run } : {}), ...(deps.launch ? { launch: deps.launch } : {}) };
	const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
		const tool = deps.tool[name];
		if (!tool) throw new PlaybookError(`tool ${name} is not available in this session`);
		return decode(await tool(args));
	};
	const docArg = (doc: string | undefined): { doc?: string } => {
		const file = doc ?? context.doc;
		return file === undefined ? {} : { doc: file };
	};
	const scope = (doc: string | undefined, run: string | undefined): { doc?: string; run: string } => {
		const chosen = run ?? context.run;
		if (!chosen) throw new PlaybookError("run is required (for example run: \"r1\")");
		return { ...docArg(doc), run: chosen };
	};
	const agentOptions = (request: AgentOptions): AgentOptions => {
		const { agent, label, schema, schemaMode, isolated } = request;
		return { ...(agent !== undefined ? { agent } : {}), ...(label !== undefined ? { label } : {}), ...(schema !== undefined ? { schema } : {}), ...(schemaMode !== undefined ? { schemaMode } : {}), ...(isolated !== undefined ? { isolated } : {}) };
	};

	/**
	 * Bind before any wait: the Launch records the agent even if the cell is cut short later.
	 * When `agent()` itself fails on a Launch this call created, the Launch is closed so it does
	 * not stay open with no agent; an existing Launch (spawn) is left as it is.
	 */
	async function start(target: { doc?: string; run: string }, launch: string, prompt: string, options: AgentOptions, fresh: boolean): Promise<Spawned> {
		let handle: AgentHandle;
		try {
			handle = await deps.agent(prompt, options);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (fresh) await call("playbook_launch", { ...docArg(target.doc), op: "close", launch });
			throw new PlaybookError(`agent() failed for Launch ${launch}${fresh ? " (closed)" : ""}: ${reason}. When the default subagent is disabled, pass agent: "<name>", for example agent: "task:mid".`);
		}
		await call("playbook_launch", { ...docArg(target.doc), op: "bind", launch, agent: handle.id });
		return { ...target, launch, id: handle.id, handle };
	}

	/** launch → agent() → bind; returns at once, without waiting for the subagent. */
	async function agent(request: AgentRequest): Promise<Spawned> {
		const target = scope(request.doc, request.run);
		const launch = created(await call("playbook_launch", { ...target, op: "launch", blocks: [...request.blocks] }));
		if (launch.kind === "orchestration") {
			throw new PlaybookError(`${request.blocks.join(", ")} is an orchestration block: run it with \`await playbook.exec("${launch.launch}")\` in its own eval call`);
		}
		return start(target, launch.launch, launch.text, agentOptions(request), true);
	}

	/** Wait for a spawned subagent and record its outcome on the Run timeline. */
	async function result(spawned: Spawned, options: { readonly block?: string } = {}): Promise<unknown> {
		const target = { ...docArg(spawned.doc), run: spawned.run };
		const about = { launch: spawned.launch, ...(options.block ? { block: options.block } : {}) };
		let value: unknown;
		try {
			value = unwrap(await spawned.handle.wait());
		} catch (error) {
			await call("playbook_timeline", { ...target, op: "post", kind: "failure", text: error instanceof Error ? error.message : String(error), ...about });
			throw error;
		}
		await call("playbook_timeline", { ...target, op: "post", kind: "result", text: textOf(value), ...about });
		return value;
	}

	return {
		context,
		agent,
		result,

		/** Another subagent on an existing Launch, with the Launch's frozen snapshot text. */
		async spawn(launch: string, request: AgentOptions & { readonly doc?: string } = {}): Promise<Spawned> {
			const info = launchInfo(await call("playbook_launch", { ...docArg(request.doc), op: "info", launch }));
			if (info.kind === "orchestration") throw new PlaybookError(`${launch} is an orchestration Launch; it is not a subagent prompt`);
			return start(scope(request.doc, info.run), launch, info.text, agentOptions(request), false);
		},

		/** agent() then result(): start one subagent for the blocks and record what it returns. */
		async run(request: AgentRequest & { readonly block?: string }): Promise<unknown> {
			const spawned = await agent(request);
			const block = request.block ?? (request.blocks.length === 1 ? request.blocks[0] : undefined);
			return result(spawned, block ? { block } : {});
		},

		post(request: { readonly doc?: string; readonly run?: string; readonly kind: RecordKind; readonly text: string; readonly block?: string; readonly launch?: string; readonly next?: number }): Promise<unknown> {
			const { doc, run, ...entry } = request;
			return call("playbook_timeline", { ...scope(doc, run), op: "post", ...entry });
		},

		timeline(request: { readonly doc?: string; readonly run?: string; readonly after?: number } = {}): Promise<unknown> {
			const { doc, run, after } = request;
			return call("playbook_timeline", { ...scope(doc, run), op: "read", ...(after !== undefined ? { after } : {}) });
		},

		read(request: { readonly doc?: string; readonly run?: string; readonly block?: string } = {}): Promise<unknown> {
			const { doc, run, block } = request;
			const chosen = run ?? context.run;
			return call("playbook_read", { ...docArg(doc), ...(chosen ? { run: chosen } : {}), ...(block ? { block } : {}) });
		},
	};
}
