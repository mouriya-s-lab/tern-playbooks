import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseBlockId, parseLaunchId, parseRunId, type BlockId, type RunId } from "../domain/model";
import { socketPath, type EventPayload, type Request, type ServerFrame } from "../domain/protocol";
import { K1Client, type Reply } from "./client";

type LockRecord = { readonly client: K1Client; readonly run?: RunId; readonly block: BlockId; readonly request: string; readonly abort: () => void };
type Operation = { readonly locks: Map<string, LockRecord> };

export default function (pi: ExtensionAPI): void {
	const z = pi.zod;
	const block = z.string().regex(/^b[1-9][0-9]*$/).transform(value => {
		const id = parseBlockId(value); if (id === null) throw new Error("Invalid block id"); return id;
	});
	const run = z.string().regex(/^r[1-9][0-9]*$/).transform(value => {
		const id = parseRunId(value); if (id === null) throw new Error("Invalid Run id"); return id;
	});
	const launch = z.string().regex(/^l[1-9][0-9]*$/).transform(value => {
		const id = parseLaunchId(value); if (id === null) throw new Error("Invalid Launch id"); return id;
	});
	const kind = z.enum(["update", "result", "failure", "retrospective"]);
	const positive = z.number().int().positive();
	const scope = { run: run.optional() };
	const scopedBlock = { ...scope, block };
	const blocks = { ...scope, blocks: z.array(block) };
	const report = z.union([
		z.object({ kind: z.literal("answers"), answers: z.record(z.string(), z.number()) }).strict(),
		z.object({ kind: z.literal("judge_unavailable") }).strict(),
	]);
	const parameters = z.union([
		z.object({ doc: z.string(), op: z.literal("lock"), args: z.object(scopedBlock).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("unlock"), args: z.object(scopedBlock).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("read"), args: z.object({ ...scope, block: block.optional() }).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("set"), args: z.union([
			z.object({ ...scopedBlock, field: z.literal("title"), value: z.string() }).strict(),
			z.object({ ...scopedBlock, field: z.literal("done"), value: z.boolean() }).strict(),
		]) }).strict(),
		z.object({ doc: z.string(), op: z.literal("edit"), args: z.object({ ...scopedBlock, find: z.string(), replace: z.string() }).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("insert"), args: z.object({ ...scope, after: block.optional(), title: z.string(), body: z.string() }).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("delete"), args: z.object(scopedBlock).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("refetch"), args: z.object({ ...scope, targets: z.array(z.string()) }).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("compile"), args: z.object(blocks).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("inspect"), args: z.object(blocks).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("report"), args: z.object({ ...blocks, version: z.string(), result: report }).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("launch"), args: z.object({ run, blocks: z.array(block) }).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("bind"), args: z.object({ launch, agent: z.string() }).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("rebase"), args: z.object({ launch }).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("close"), args: z.object({ launch }).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("launch_info"), args: z.object({ launch }).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("start_run"), args: z.object({ name: z.string(), update_every: positive.optional() }).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("finish_run"), args: z.object({ run }).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("runs"), args: z.object({}).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("timeline"), args: z.object({ run, after: z.number().int().nonnegative().optional() }).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("post"), args: z.object({ run, kind, text: z.string(), block: block.optional(), launch: launch.optional(), next: positive.optional(), quote: z.string().optional() }).strict() }).strict(),
		z.object({ doc: z.string(), op: z.literal("snooze"), args: z.object({ run, after: positive }).strict() }).strict(),
	]);
	const site = z.object({ block, reference: z.string() });
	const compileError = z.union([
		z.object({ kind: z.literal("UnknownBlock"), block, at: site }),
		z.object({ kind: z.literal("UnknownTarget"), at: site }),
		z.object({ kind: z.literal("BadExpression"), reason: z.string(), at: site }),
		z.object({ kind: z.literal("Cycle"), path: z.array(block), at: site }),
		z.object({ kind: z.literal("TooDeep"), at: site }),
		z.object({ kind: z.literal("NoResult"), block, at: site }),
		z.object({ kind: z.literal("FetchFailed"), target: z.string(), error: z.string(), at: site }),
	]);
	const sourceFields = { target: z.string(), expression: z.string().nullable() };
	const source = z.union([
		z.object({ kind: z.literal("block"), ...sourceFields }),
		z.object({ kind: z.literal("result"), ...sourceFields, seq: z.number(), origin: z.enum(["human", "coordinator", "disk", "service"]), launch: launch.nullable() }),
		z.object({ kind: z.literal("external"), ...sourceFields, fetchedAt: z.number() }),
	]);
	const events = z.union([
		z.object({ event: z.literal("block_changed"), data: z.object({ id: z.string(), launch: z.object({ id: launch, kind: z.enum(["prompt", "orchestration"]), run }), agents: z.array(z.string()), changed: z.array(block), diff: z.string(), current: z.union([
			z.object({ kind: z.literal("Ok"), text: z.string(), sources: z.array(source) }),
			z.object({ kind: z.literal("Err"), error: compileError }),
		]) }) }),
		z.object({ event: z.literal("launch_requested"), data: z.object({ run, blocks: z.array(block) }) }),
		z.object({ event: z.literal("check_requested"), data: z.object({ run: run.nullable(), blocks: z.array(block) }) }),
		z.object({ event: z.literal("run_started"), data: z.object({ run, name: z.string() }) }),
		z.object({ event: z.literal("run_finished"), data: z.object({ run }) }),
		z.object({ event: z.literal("done_changed"), data: z.object({ run, block, done: z.boolean() }) }),
		z.object({ event: z.literal("update_due"), data: z.object({ run, due: z.number(), last_update: z.number().nullable() }) }),
		z.object({ event: z.literal("interrupted"), data: z.object({ ...scopedBlock, request: z.string() }) }),
	]);
	const error = z.object({ code: z.enum(["Busy", "NotHello", "Locked", "NotLocked", "UnknownBlock", "UnknownRun", "RunFinished", "BadValue", "NotFound", "Ambiguous", "BadLaunch", "CompileError", "UnknownTarget", "BadReport", "UnknownLaunch", "NotOwner", "UnknownEvent"]), message: z.string(), detail: z.unknown().optional() });
	const frames = z.union([events, z.object({ id: z.string(), ok: z.literal(true), result: z.unknown().optional() }).strict().transform(frame => ({ ...frame, result: frame.result })), z.object({ id: z.string(), ok: z.literal(false), error }).strict()]);
	const summary = z.object({ id: run, name: z.string(), status: z.enum(["running", "finished"]), started_at: z.number(), finished_at: z.number().nullable(), done: z.number(), total: z.number(), update_due: z.number().nullable(), update_overdue: z.boolean(), retrospective: z.boolean() });
	const runsResult = z.object({ runs: z.array(summary) });
	const helloResult = z.object({ blocks: z.array(block), runs: z.array(summary), pane: z.string().optional() });
	const readResult = z.object({ title: z.string(), blocks: z.array(z.object({ id: block, title: z.string(), body: z.string(), done: z.boolean() })) });
	const postResult = z.object({ seq: positive });
	const clients = new Map<string, K1Client>();
	let operation: Operation = { locks: new Map() };
	let session: string | undefined;
	let stopped = false;

	async function clientFor(doc: string, ctx: ExtensionContext): Promise<K1Client> {
		if (stopped) throw new Error("Disconnected: coordinator session has ended");
		const currentSession = ctx.sessionManager.getSessionId();
		if (session !== undefined && session !== currentSession) {
			for (const client of clients.values()) client.close();
			clients.clear(); operation = { locks: new Map() };
		}
		session = currentSession;
		let absolute: string;
		try { absolute = await realpath(doc); }
		catch { throw new Error(`NoService: cannot resolve Playbook ${doc}`); }
		let client = clients.get(absolute);
		if (!client) {
			client = new K1Client(socketPath(tmpdir(), absolute), { session: currentSession, ...(process.env.TERN_PANE ? { pane: process.env.TERN_PANE } : {}) }, (input): ServerFrame => frames.parse(input), async (event: EventPayload) => {
				switch (event.event) {
					case "interrupted": {
						const lock = [...operation.locks.values()].find(item => item.request === event.data.request);
						if (lock) lock.abort();
						return;
					}
					case "block_changed": case "launch_requested": case "check_requested": case "run_started": case "run_finished": case "done_changed": case "update_due":
						await pi.sendMessage({ customType: "playbook-event", content: "这是 Playbook 文档服务的通知，不是用户消息\n" + JSON.stringify({ doc: absolute, ...event }), display: true }, { deliverAs: "aside", triggerTurn: true });
						return;
				}
			});
			clients.set(absolute, client);
		}
		return client;
	}

	pi.registerTool({
		name: "playbook", label: "Playbook", loadMode: "essential",
		description: "Operate a running Playbook document service using K1 operations. Omit run to operate on the template. Block writes require lock; locks end when this agent operation ends. hello and ack are managed by the extension. post records coordinator-authored text.",
		parameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let reply: Reply;
			try {
				const parsed = parameters.parse(params);
				const client = await clientFor(parsed.doc, ctx);
				const current = operation;
				const id = randomUUID();
				if (parsed.op === "unlock") {
					const key = JSON.stringify([client.path, parsed.args.run ?? null, parsed.args.block]);
					const lock = current.locks.get(key);
					reply = lock ? await client.request({ op: "unlock", args: { ...parsed.args, request: lock.request } }, id) : { id, ok: true, result: undefined };
					if (reply.ok && lock) current.locks.delete(key);
				} else {
					const request: Request = parsed;
					reply = await client.request(request, id, response => {
						if (parsed.op === "lock" && response.ok) {
							const key = JSON.stringify([client.path, parsed.args.run ?? null, parsed.args.block]);
							current.locks.set(key, { client, ...parsed.args, request: id, abort: () => ctx.abort() });
						}
					});
				}
			} catch (error) {
				reply = { id: "", ok: false, error: { code: "NoService", message: error instanceof Error ? error.message : String(error) } };
			}
			return { content: [{ type: "text", text: JSON.stringify(reply.ok ? reply.result ?? null : { error: reply.error }) }], isError: !reply.ok };
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!process.env.PLAYBOOK_DOC) return;
		try {
			const client = await clientFor(process.env.PLAYBOOK_DOC, ctx);
			const ready = await client.connect();
			if (!ready.ok) ctx.ui.notify(`${ready.error.code}: ${ready.error.message}`, "error");
		} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
	});

	pi.on("agent_start", () => { operation = { locks: new Map() }; });
	pi.on("agent_end", async () => {
		const ended = operation;
		for (const lock of ended.locks.values()) {
			await lock.client.request({ op: "unlock", args: { run: lock.run, block: lock.block, request: lock.request } });
		}
		ended.locks.clear();
	});
	pi.on("session_shutdown", () => {
		stopped = true;
		for (const client of clients.values()) client.close();
		clients.clear(); operation.locks.clear();
	});

	async function commandClient(args: string, ctx: ExtensionContext): Promise<K1Client | undefined> {
		let doc = args.trim();
		if (!doc) {
			const connected = [...clients.entries()].filter(([, client]) => client.connected);
			if (connected.length === 1) doc = connected[0]![0];
			else if (connected.length > 1) { const selected = await ctx.ui.select("Choose Playbook", connected.map(([path]) => path)); if (selected === undefined) return; doc = selected; }
			else doc = process.env.PLAYBOOK_DOC ?? "";
			if (!doc) { ctx.ui.notify("请指定 Playbook 文件路径", "error"); return; }
		}
		const client = await clientFor(doc, ctx);
		const ready = await client.connect();
		if (!ready.ok) throw new Error(`${ready.error.code}: ${ready.error.message}`);
		return client;
	}
	async function result(client: K1Client, request: Request): Promise<unknown> {
		const reply = await client.request(request);
		if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
		return reply.result;
	}

	pi.registerCommand("playbook-add", {
		description: "Add a recent session message to a Playbook Run timeline",
		handler: async (args, ctx) => {
			try {
				const client = await commandClient(args, ctx); if (!client) return;
				const messages = ctx.sessionManager.getBranch().flatMap(entry => {
					if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return [];
					const content = entry.message.content;
					const text = typeof content === "string" ? content : content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
					return text ? [{ id: entry.id, text, label: `${entry.id}: ${text.replace(/\s+/g, " ").slice(0, 90)}` }] : [];
				}).slice(-20).reverse();
				if (!messages.length) { ctx.ui.notify("No user or assistant messages with text", "warning"); return; }
				const messageLabel = await ctx.ui.select("Choose session message", messages.map(message => message.label)); if (messageLabel === undefined) return;
				const message = messages.find(item => item.label === messageLabel); if (!message) throw new Error("Unknown message selection");
				const runs = runsResult.parse(await result(client, { op: "runs", args: {} })).runs;
				if (!runs.length) { ctx.ui.notify("This Playbook has no Runs", "warning"); return; }
				const runChoices = runs.map(item => ({ id: item.id, label: `${item.id}: ${item.name} (${item.status})` }));
				const runLabel = await ctx.ui.select("Choose Run", runChoices.map(item => item.label)); if (runLabel === undefined) return;
				const chosenRun = runChoices.find(item => item.label === runLabel); if (!chosenRun) throw new Error("Unknown Run selection");
				const kindLabel = await ctx.ui.select("Choose record kind", ["update", "result", "failure", "retrospective"]); if (kindLabel === undefined) return;
				const chosenKind = kind.parse(kindLabel);
				const document = readResult.parse(await result(client, { op: "read", args: { run: chosenRun.id } }));
				const blockChoices = document.blocks.map(item => ({ id: item.id, label: `${item.id}: ${item.title}` }));
				const blockLabel = await ctx.ui.select("Choose block", ["不关于块", ...blockChoices.map(item => item.label)]); if (blockLabel === undefined) return;
				const chosenBlock = blockLabel === "不关于块" ? undefined : blockChoices.find(item => item.label === blockLabel)?.id;
				if (blockLabel !== "不关于块" && chosenBlock === undefined) throw new Error("Unknown block selection");
				const posted = postResult.parse(await result(client, { op: "post", args: { run: chosenRun.id, kind: chosenKind, text: message.text, ...(chosenBlock ? { block: chosenBlock } : {}), quote: message.id, origin: "human" } }));
				ctx.ui.notify(`Playbook timeline entry ${posted.seq} written`, "info");
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});
	pi.registerCommand("playbook-show", {
		description: "Focus the Playbook document pane in Tern",
		handler: async (args, ctx) => {
			try {
				const client = await commandClient(args, ctx); if (!client) return;
				const hello = helloResult.parse(client.hello);
				if (!hello.pane) { ctx.ui.notify("文档服务不在 session daemon 托管的 pane 中", "error"); return; }
				if (!process.env.TERN_PANE) throw new Error("Playbook focus requires a coordinator Tern pane");
				const child = Bun.spawn(["tern", "focus", hello.pane, "--json"], { env: process.env, stdout: "pipe", stderr: "pipe" });
				const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
				if (exit !== 0) throw new Error(`tern focus exited ${exit}: ${stderr.trim()}`);
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});
}
