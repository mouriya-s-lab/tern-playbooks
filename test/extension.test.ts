import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { z as zod } from "@oh-my-pi/omptype/zod";
import { parseRunId } from "../src/domain/model";
import { socketPath, type EventPayload, type Request, type ServerFrame } from "../src/domain/protocol";
import extension from "../src/extension/index";
import { K1Client } from "../src/extension/client";

const summary = { id: "r1", name: "Run", status: "running", started_at: 1, finished_at: null, done: 0, total: 1, update_due: null, update_overdue: false, retrospective: false };
const block = { id: "b1", title: "Block", body: "Body", done: false };
type Frame = Request & { readonly id: string };
type Cleanup = () => void | Promise<void>;
const cleanup: Cleanup[] = [];
beforeEach(() => {
	const original = { PATH: process.env.PATH, TERN_PANE: process.env.TERN_PANE };
	delete process.env.TERN_PANE;
	cleanup.push(() => {
		for (const key of ["PATH", "TERN_PANE"] as const) {
			const value = original[key];
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	});
});
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function temporaryDirectory(): Promise<string> {
	const dir = await mkdtemp("/tmp/pb-ext-");
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
function respond(socket: Socket, frame: Frame, result?: unknown): void {
	socket.write(JSON.stringify({ id: frame.id, ok: true, result }) + "\n");
}
async function service(pane: string | undefined = "document-pane", existingDoc?: string) {
	const doc = existingDoc ?? (await temporaryDirectory()) + "/book.yaml";
	if (!existingDoc) await Bun.write(doc, "title: Book\nblocks: []\n");
	await mkdir(tmpdir() + "/tern-playbooks", { recursive: true });
	const path = socketPath(tmpdir(), await realpath(doc));
	const frames: Frame[] = [];
	const sockets: Socket[] = [];
	const received = new Map<Request["op"], ((frame: Frame) => void)[]>();
	let handler = (frame: Frame, socket: Socket): void => {
		const result = frame.op === "hello" ? { blocks: ["b1"], runs: [summary], ...(pane ? { pane } : {}) }
			: frame.op === "lock" ? { block } : frame.op === "runs" ? { runs: [summary] }
			: frame.op === "read" ? { title: "Book", blocks: [block] } : frame.op === "post" ? { seq: 7 } : undefined;
		respond(socket, frame, result);
	};
	const server = createServer(socket => {
		sockets.push(socket);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += chunk;
			for (;;) {
				const end = buffer.indexOf("\n"); if (end < 0) break;
				const frame = JSON.parse(buffer.slice(0, end)) as Frame;
				buffer = buffer.slice(end + 1);
				frames.push(frame); handler(frame, socket);
				for (const resolve of received.get(frame.op) ?? []) resolve(frame);
				received.delete(frame.op);
			}
		});
	});
	const listeningReady = Promise.withResolvers<void>();
	server.once("error", listeningReady.reject);
	server.listen(path, listeningReady.resolve);
	await listeningReady.promise;
	let listening = true;
	async function stop(): Promise<void> {
		for (const socket of sockets) socket.destroy();
		if (!listening) return;
		listening = false;
		const closed = Promise.withResolvers<void>();
		server.close(error => error ? closed.reject(error) : closed.resolve());
		await closed.promise;
	}
	async function disconnect(): Promise<void> {
		const socket = sockets.at(-1)!;
		const closed = once(socket, "close");
		socket.end();
		await closed;
	}
	function nextFrame(op: Request["op"]): Promise<Frame> {
		const next = Promise.withResolvers<Frame>();
		received.set(op, [...received.get(op) ?? [], next.resolve]);
		return next.promise;
	}
	cleanup.push(stop);
	return { doc, path, frames, sockets, stop, disconnect, nextFrame, set handler(value: typeof handler) { handler = value; }, push(frame: EventPayload) { sockets.at(-1)!.write(JSON.stringify(frame) + "\n"); } };
}

type TextPart = { type: "text"; text: string } | { type: "thinking"; thinking: string };
type Entry = { type: "message"; id: string; message: { role: "user" | "assistant" | "toolResult"; content: string | TextPart[] } } | { type: "custom"; id: string };
type Tool = { parameters: { parse(value: unknown): unknown }; execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<{ content: { type: string; text?: string }[]; isError?: boolean }> };
type Handler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
function harness(kind: "main" | "sub" = "main") {
	let tool: Tool | undefined;
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	const messages: { message: { customType: string; content: string; display: boolean }; options: unknown }[] = [];
	const notices: { message: string; type: string }[] = [];
	const menus: { title: string; options: string[] }[] = [];
	const choices: (string | null | undefined)[] = [];
	let aborted = 0;
	let selectHook: ((title: string) => Promise<void>) | undefined;
	let branch: Entry[] = [
		{ type: "message", id: "user-1", message: { role: "user", content: "USER" } },
		{ type: "message", id: "assistant-1", message: { role: "assistant", content: [{ type: "text", text: "FULL FIRST" }, { type: "thinking", thinking: "NO" }, { type: "text", text: "FULL SECOND" }] } },
	];
	const ctx = {
		agent: { kind },
		sessionManager: { getSessionId: () => "session-test", getBranch: () => branch },
		abort: () => { aborted++; },
		ui: {
			select: async (title: string, options: string[]) => {
				menus.push({ title, options }); await selectHook?.(title);
				const choice = choices.shift(); return choice === null ? undefined : typeof choice === "string" ? choice : options[0];
			},
			notify: (message: string, type: string) => { notices.push({ message, type }); },
		},
	} as unknown as ExtensionCommandContext;
	// Only the host surfaces this extension consumes are supplied; production types remain unchanged.
	const api = {
		zod, registerTool: (value: Tool) => { tool = value; },
		on: (event: string, handler: Handler) => { handlers.set(event, handler); },
		registerCommand: (name: string, value: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => { commands.set(name, value); },
		sendMessage: (message: { customType: string; content: string; display: boolean }, options: unknown) => { messages.push({ message, options }); },
	} as unknown as ExtensionAPI;
	extension(api);
	let started = false;
	async function event(name: string): Promise<void> {
		if (name === "session_start") started = true;
		await handlers.get(name)!({}, ctx);
	}
	// omp fires session_start before the session can run tools or commands.
	async function start(): Promise<void> {
		if (!started) await event("session_start");
	}
	cleanup.push(() => event("session_shutdown"));
	return {
		ctx, messages, notices, menus, choices, event,
		get aborted() { return aborted; }, get tool() { return tool!; }, get registered() { return { tool: tool !== undefined, commands: [...commands.keys()] }; },
		set branch(value: Entry[]) { branch = value; }, set selectHook(value: typeof selectHook) { selectHook = value; },
		execute: async (params: unknown) => { await start(); return tool!.execute("tool", params, undefined, undefined, ctx); },
		command: async (name: string, doc = "") => { await start(); return commands.get(name)!.handler(doc, ctx); },
	};
}
async function fakeTern(exit = 0, stdout = "") {
	const dir = await temporaryDirectory();
	const capture = dir + "/args";
	await Bun.write(dir + "/tern", `#!/bin/sh\nprintf '%s\\n' "$@" >> '${capture}'\nprintf '%s' '${stdout}'\nprintf 'focus failed' >&2\nexit ${exit}\n`);
	await chmod(dir + "/tern", 0o755);
	process.env.PATH = dir + ":" + process.env.PATH;
	return { capture, args: async () => (await Bun.file(capture).text()).trim().split("\n") };
}
/** Resolves when the fake tern child has written its arguments: the split happened. */
function fileAppears(path: string): Promise<void> {
	const appeared = Promise.withResolvers<void>();
	const watcher = watch(dirname(path), () => { if (existsSync(path)) { watcher.close(); appeared.resolve(); } });
	cleanup.push(() => watcher.close());
	if (existsSync(path)) { watcher.close(); appeared.resolve(); }
	return appeared.promise;
}
function parseFrame(value: unknown): ServerFrame { return value as ServerFrame; }
function client(path: string): K1Client {
	const value = new K1Client(path, { session: "client-test" }, parseFrame, () => {});
	cleanup.push(() => value.close()); return value;
}
const runId = parseRunId("r1")!;

test("tool hello, latest lock id, same-frame interruption, unlock suppression and agent_end cleanup", async () => {
	const s = await service(); const h = harness(); await h.event("agent_start");
	await h.execute({ doc: s.doc, op: "lock", args: { run: "r1", block: "b1" } });
	await h.execute({ doc: s.doc, op: "lock", args: { run: "r1", block: "b1" } });
	expect(s.frames[0]).toMatchObject({ op: "hello", args: { session: "session-test" } });
	expect(Object.keys(s.frames[1]!).sort()).toEqual(["args", "id", "op"]);
	await h.execute({ doc: s.doc, op: "unlock", args: { run: "r1", block: "b1" } });
	expect(s.frames.at(-1)).toMatchObject({ args: { request: s.frames[2]!.id } });
	const count = s.frames.length;
	await h.execute({ doc: s.doc, op: "unlock", args: { run: "r1", block: "b1" } });
	expect(s.frames).toHaveLength(count);
	s.handler = (frame, socket) => {
		respond(socket, frame, { block });
		if (frame.op === "lock") socket.write(JSON.stringify({ event: "interrupted", data: { run: "r1", block: "b1", request: frame.id } }) + "\n");
	};
	await h.execute({ doc: s.doc, op: "lock", args: { run: "r1", block: "b1" } });
	await h.execute({ doc: s.doc, op: "runs", args: {} });
	expect(h.aborted).toBe(1); expect(h.messages).toHaveLength(0);
	await h.event("agent_end");
	expect(s.frames.at(-1)).toMatchObject({ op: "unlock", args: { request: s.frames.findLast(frame => frame.op === "lock")!.id } });
});

test("event aside precedes block_changed ack; unrelated interruption is ignored", async () => {
	const s = await service(); const h = harness(); await h.execute({ doc: s.doc, op: "runs", args: {} });
	const ack = s.nextFrame("ack");
	s.push({ event: "block_changed", data: { id: "e1", launch: { id: "l1", kind: "prompt", run: "r1" }, agents: [], changed: ["b1"], diff: "diff", current: { kind: "Ok", text: "new", sources: [] } } } as EventPayload);
	await ack;
	expect(h.messages[0]!.message.customType).toBe("playbook-event");
	expect(h.messages[0]!.message.content.split("\n")[0]).toBe("这是 Playbook 文档服务的通知，不是用户消息");
	expect(h.messages[0]!.options).toEqual({ deliverAs: "aside", triggerTurn: true });
	expect(s.frames.at(-1)).toMatchObject({ op: "ack", args: { event: "e1" } });
	s.push({ event: "interrupted", data: { block: "b1", request: "old" } } as EventPayload);
	await h.execute({ doc: s.doc, op: "runs", args: {} }); expect(h.aborted).toBe(0);
});

test("add writes full text, quote and human origin; cancelling any message/run/kind/block menu suppresses post", async () => {
	const s = await service(); const h = harness(); h.choices.push("assistant-1: FULL FIRST FULL SECOND");
	await h.command("playbook-add", s.doc);
	expect(s.frames.at(-1)).toMatchObject({ op: "post", args: { run: "r1", kind: "update", text: "FULL FIRST\nFULL SECOND", quote: "assistant-1", origin: "human" } });
	expect(h.notices.at(-1)!.message).toContain("7");
	for (let stage = 0; stage < 4; stage++) {
		h.choices.push(...Array<undefined>(stage).fill(undefined), null);
		const before = s.frames.filter(frame => frame.op === "post").length;
		await h.command("playbook-add", s.doc);
		expect(s.frames.filter(frame => frame.op === "post")).toHaveLength(before);
	}
	expect(() => h.tool.parameters.parse({ doc: s.doc, op: "post", args: { run: "r1", kind: "result", text: "x", origin: "human" } })).toThrow();
});

test("show calls a real tern child with the hello pane unchanged; add offers latest twenty textual user/assistant messages", async () => {
	const s = await service(); const tern = await fakeTern(); const h = harness(); process.env.TERN_PANE = "coordinator-pane";
	await h.command("playbook-show", s.doc);
	expect(h.notices).toEqual([]); expect(await tern.args()).toEqual(["focus", "document-pane", "--json"]);
	expect(s.frames[0]).toMatchObject({ args: { pane: "coordinator-pane" } });
	h.branch = Array.from({ length: 25 }, (_, i): Entry => ({ type: "message", id: "message-" + i, message: { role: i % 2 ? "user" : "assistant", content: [{ type: "text", text: "text-" + i }] } }));
	h.branch = [...h.ctx.sessionManager.getBranch() as unknown as Entry[], { type: "custom", id: "custom" }, { type: "message", id: "empty", message: { role: "user", content: "" } }, { type: "message", id: "tool", message: { role: "toolResult", content: "ignore" } }];
	h.choices.push(null); await h.command("playbook-add");
	expect(h.menus[0]!.options).toHaveLength(20); expect(h.menus[0]!.options[0]).toBe("message-24: text-24");
	expect(h.menus[0]!.options.at(-1)).toBe("message-5: text-5"); expect(s.frames.some(frame => frame.op === "post")).toBe(false);
});

test("open starts the document service beside the coordinator pane and returns hello once it listens", async () => {
	const doc = (await temporaryDirectory()) + "/book.yaml"; await Bun.write(doc, "title: Book\nblocks: []\n");
	const tern = await fakeTern(0, '{"block": 42}'); process.env.TERN_PANE = "coordinator-pane"; const h = harness();
	const split = fileAppears(tern.capture);
	const opening = h.execute({ doc, op: "open", args: {} });
	await split;
	const s = await service("document-pane", doc);
	const result = await opening;
	expect(result.isError).toBe(false);
	expect(JSON.parse(result.content[0]!.text!)).toMatchObject({ blocks: ["b1"], pane: "document-pane" });
	const real = await realpath(doc);
	expect(await tern.args()).toEqual(["split", "coordinator-pane", "right", "--cwd", dirname(real), "--json", "--", "bun", resolve(import.meta.dir, "../src/service/main.ts"), real]);
	expect(s.frames.map(frame => frame.op)).toEqual(["hello"]);
});

test("open reuses a running service without tern; with no service and no TERN_PANE it is StartFailed", async () => {
	const s = await service(); const tern = await fakeTern(0, '{"block": 42}'); const h = harness();
	const running = await h.execute({ doc: s.doc, op: "open", args: {} });
	expect(running.isError).toBe(false); expect(await Bun.file(tern.capture).exists()).toBe(false);
	const doc = (await temporaryDirectory()) + "/idle.yaml"; await Bun.write(doc, "title: Idle\nblocks: []\n");
	const idle = await h.execute({ doc, op: "open", args: {} });
	expect(idle.isError).toBe(true); expect(JSON.parse(idle.content[0]!.text!).error.code).toBe("StartFailed");
	expect(await Bun.file(tern.capture).exists()).toBe(false);
});

test("a child session registers no tool or command and never connects (R4)", async () => {
	const s = await service();
	const h = harness("sub"); await h.event("session_start");
	expect(h.registered).toEqual({ tool: false, commands: [] });
	expect(s.frames).toHaveLength(0);
});

for (const command of ["playbook-add", "playbook-show"]) {
	test(`${command}: absent doc and connections reports exact path prompt`, async () => {
		const h = harness(); await h.command(command);
		expect(h.notices).toEqual([{ message: "请指定 Playbook 文件路径", type: "error" }]); expect(h.menus).toEqual([]);
	});
	test(`${command}: unique live connection is used; multiple connections prompt and allow cancellation`, async () => {
		const a = await service("pane-a"); const b = await service("pane-b"); const tern = await fakeTern(); process.env.TERN_PANE = "coordinator-pane"; const h = harness();
		await h.execute({ doc: a.doc, op: "runs", args: {} });
		await h.command(command); expect(h.menus.some(menu => menu.title === "Choose Playbook")).toBe(false);
		await h.execute({ doc: b.doc, op: "runs", args: {} }); h.choices.push(await realpath(b.doc)); await h.command(command);
		expect(h.menus.find(menu => menu.title === "Choose Playbook")!.options).toEqual([await realpath(a.doc), await realpath(b.doc)]);
		if (command === "playbook-show") expect(await tern.args()).toEqual(["focus", "pane-a", "--json", "focus", "pane-b", "--json"]);
		else expect(b.frames.at(-1)!.op).toBe("post");
		const counts = [a.frames.length, b.frames.length]; h.choices.push(null); await h.command(command);
		expect([a.frames.length, b.frames.length]).toEqual(counts);
	});
}

test("show missing remote pane never invokes tern and gives exact daemon-pane notification", async () => {
	const s = await service(""); const tern = await fakeTern(); const h = harness(); process.env.TERN_PANE = "coordinator-pane";
	await h.command("playbook-show", s.doc);
	expect(h.notices).toEqual([{ message: "文档服务不在 session daemon 托管的 pane 中", type: "error" }]); expect(await Bun.file(tern.capture).exists()).toBe(false);
});

test("show without local pane never invokes tern; child failures retain exit code and stderr", async () => {
	const s = await service(); const tern = await fakeTern(9); const h = harness(); await h.command("playbook-show", s.doc);
	expect(await Bun.file(tern.capture).exists()).toBe(false); expect(h.notices.at(-1)!.message).toContain("coordinator Tern pane");
	process.env.TERN_PANE = "coordinator-pane"; await h.command("playbook-show", s.doc);
	expect(h.notices.at(-1)!.message).toContain("tern focus exited 9: focus failed"); expect(await tern.args()).toEqual(["focus", "document-pane", "--json"]);
});

for (const op of ["runs", "post"] as const) {
	for (const failure of ["protocol", "Disconnected", "NoService"] as const) {
		test(`add ${op} ${failure} notifies and stops without retry`, async () => {
			const s = await service(); const h = harness(); const normal = (frame: Frame, socket: Socket) => respond(socket, frame, frame.op === "hello" ? { blocks: ["b1"], runs: [summary] } : frame.op === "runs" ? { runs: [summary] } : frame.op === "read" ? { title: "Book", blocks: [block] } : { seq: 7 });
			s.handler = (frame, socket) => {
				if (frame.op !== op || failure === "NoService") { normal(frame, socket); return; }
				if (failure === "Disconnected") socket.destroy();
				else socket.write(JSON.stringify({ id: frame.id, ok: false, error: { code: "BadValue", message: "rejected " + op } }) + "\n");
			};
			if (failure === "NoService") h.selectHook = async title => {
				if (title === (op === "runs" ? "Choose session message" : "Choose block")) { await s.disconnect(); await s.stop(); }
			};
			await h.command("playbook-add", s.doc);
			expect(h.notices.at(-1)!.type).toBe("error"); expect(h.notices.at(-1)!.message).toContain(failure === "protocol" ? "BadValue: rejected " + op : failure);
			expect(s.frames.filter(frame => frame.op === op)).toHaveLength(failure === "NoService" ? 0 : 1);
			if (op === "runs") expect(s.frames.some(frame => frame.op === "read" || frame.op === "post")).toBe(false);
		});
	}
}

test("add reconnects before runs and post when transport disappears during menu selection", async () => {
	const s = await service(); const h = harness();
	h.selectHook = async title => {
		if (title === "Choose session message" || title === "Choose block") await s.disconnect();
	};
	await h.command("playbook-add", s.doc);
	expect(s.frames.map(frame => frame.op)).toEqual(["hello", "hello", "runs", "read", "hello", "post"]);
	expect(h.notices.at(-1)).toEqual({ message: "Playbook timeline entry 7 written", type: "info" });
});

test("client missing socket returns NoService; failed hello sends no target request", async () => {
	const missing = client("/tmp/no-pb-service-" + randomUUID()); const reply = await missing.request({ op: "runs", args: {} });
	expect(reply.ok).toBe(false); if (!reply.ok) expect(reply.error.code).toBe("NoService");
	const s = await service(); s.handler = (_frame, socket) => socket.destroy();
	const c = client(s.path); const beforeHello = await c.request({ op: "post", args: { run: runId, kind: "update", text: "x" } });
	expect(beforeHello.ok).toBe(false); if (!beforeHello.ok) expect(beforeHello.error.code).toBe("NoService"); expect(s.frames.map(frame => frame.op)).toEqual(["hello"]);
});

test("in-flight disconnect is Disconnected; automatic reconnect sends only hello; close stops retries", async () => {
	const s = await service(); s.handler = (frame, socket) => { if (frame.op === "hello") respond(socket, frame, { blocks: [], runs: [] }); else socket.destroy(); };
	const c = client(s.path); const reply = await c.request({ op: "post", args: { run: runId, kind: "update", text: "x" } });
	expect(reply.ok).toBe(false); if (!reply.ok) expect(reply.error.code).toBe("Disconnected");
	// Exercise the real platform reconnect deadline and prove close cancels that deadline.
	// Advancing fake timers does not reproduce Unix-socket I/O across transport lifetimes.
	await Bun.sleep(2150); expect(s.frames.map(frame => frame.op)).toEqual(["hello", "post", "hello"]);
	c.close(); await Bun.sleep(2150); expect(s.frames.map(frame => frame.op)).toEqual(["hello", "post", "hello"]);
});
