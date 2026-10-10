import { describeTableChart, lookupTableChart, setTableCharts, splitTableCharts } from "@oh-my-pi/pi-tui/chat/table-chart";
import { getNativeBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { initThemeSync, setTheme } from "@oh-my-pi/pi-tui/theme/theme";
import type { BlockId, CompileResult, DocRef, EntryData, RecordKind, TimelineEntry } from "../domain/model";
import { parseRunId } from "../domain/model";
import type { BlockView, CoreApi, DocView, RenderStatus } from "../domain/ports";
import type { FrameOp, TspEvent, TspInput, TspNode, TspSession } from "./tsp-types";

const SURFACE = "playbook";
const ESC = "\x1b";
const TYPES: readonly EntryData["type"][] = ["run_started", "run_finished", "block_edited", "block_added", "block_deleted", "blocks_reordered", "done_changed", "launch_created", "agent_bound", "launch_closed", "event_sent", "interrupted", "check_reported", "post", "update_due", "update_snoozed"];
type Caret = { cursor: number; anchor: number | null };
type UndoStep = Caret & { text: string };
type Field = { readonly multiline: boolean; text(): string; write(text: string): string | null };
type Summary = Pick<RenderStatus, "chartNodes" | "view">;
const text = (id: string, value: string, tone?: string): TspNode => ({ id, k: "text", p: { text: value, ...(tone ? { tone } : {}) } });
const col = (id: string, c: readonly TspNode[]): TspNode => ({ id, k: "col", p: { gap: "sm" }, c });
const row = (id: string, c: readonly TspNode[]): TspNode => ({ id, k: "row", p: { gap: "sm", wrap: true }, c });
const time = (at: number | null): string => at === null ? "无" : new Date(at).toISOString();
const compileText = (result: CompileResult): string => result.kind === "Ok" ? result.text : JSON.stringify(result.error, null, 2);
const orchestration = (body: string): boolean => /^\s*```(?:js|py)\s*\n[\s\S]*\n```\s*$/.test(body);

/** K4 front end. Core owns every document, lock and draft; local state is only interaction state. */
export function startUi(core: CoreApi, tsp: TspSession): void {
	initThemeSync();
	setTableCharts("always");
	let ref: DocRef = { kind: "template" };
	let opened = false;
	let mounted = false;
	let focus: string | null = null;
	let documentError: string | null = null;
	let runName = "";
	let runEvery = "";
	let postText = "";
	let postNext = "";
	let postKind: RecordKind = "update";
	let postBlock: BlockId | null = null;
	let postKindChosen = false;
	let filter: EntryData["type"] | "all" = "all";
	let snoozeAfter = 900;
	const selected = new Set<BlockId>();
	const carets = new Map<string, Caret>();
	const undo = new Map<string, UndoStep[]>();
	const notices = new Map<string, string>();
	const previews = new Map<string, CompileResult>();
	const summaries = new Map<BlockId, Summary>();
	const actions = new Map<string, () => void>();
	const changes = new Map<string, (event: Extract<TspEvent, { ev: "change" }>) => void>();
	const fields = new Map<string, Field>();
	const info = new Map<string, string>();

	function showError(error: string | null): void { if (error) { documentError = error; redraw(); } }
	function button(id: string, label: string, action: () => void, disabled = false): TspNode {
		if (!disabled) actions.set(id, action);
		return { id, k: "el", p: { tag: "button", text: label, class: disabled ? "pb-button pb-disabled" : "pb-button", attrs: { "aria-disabled": disabled }, ...(disabled ? {} : { actions: { click: "invoke" } }) } };
	}
	function check(id: string, label: string, checked: boolean, disabled: boolean, change: (checked: boolean) => void, name?: string, value?: string): TspNode {
		if (!disabled) changes.set(id, event => { if (typeof event.checked === "boolean") change(event.checked); });
		return { id: `${id}.label`, k: "el", p: { tag: "label" }, c: [{ id, k: "el", p: { tag: "input", type: name ? "radio" : "checkbox", name: name ?? id, value: value ?? id, checked, disabled } }, text(`${id}.text`, label)] };
	}
	function choices<T extends string>(id: string, values: readonly T[], current: T, change: (value: T) => void, disabled = false): TspNode {
		return row(id, values.map(value => check(`${id}.${value}`, value, current === value, disabled, checked => { if (checked) { change(value); redraw(); } }, id, value)));
	}
	function field(id: string, value: Field, placeholder: string): TspNode {
		fields.set(id, value);
		const caret = carets.get(id) ?? { cursor: value.text().length, anchor: null };
		carets.set(id, caret);
		return { id, k: value.multiline ? "editor" : "input", p: { text: value.text(), cursor: caret.cursor, anchor: caret.anchor, placeholder, aria: placeholder, ...(value.multiline ? { maxLines: 18 } : {}) } };
	}
	function formField(id: string, get: () => string, put: (value: string) => void, placeholder: string, multiline = false): TspNode {
		return field(id, { multiline, text: get, write: value => { put(value); return null; } }, placeholder);
	}
	function section(id: string, head: string | TspNode, c: readonly TspNode[], key = id): TspNode {
		return { id, k: "section", p: { head: typeof head === "string" ? head : head.id, key, collapsible: true, collapsed: false }, c: typeof head === "string" ? c : [head, ...c] };
	}
	function rendered(id: string, body: string): TspNode[] {
		return splitTableCharts(body, false).flatMap((segment, index): TspNode[] => {
			const nodeId = `${id}.${index}`;
			if (segment.kind === "markdown") return [{ id: nodeId, k: "md", p: { text: segment.text } }];
			const chart = lookupTableChart(segment.table);
			if (!chart || chart instanceof Promise) throw new Error("always-mode chart lookup did not return a chart");
			const node = describeTableChart(chart, nodeId);
			const blobId = node.p && "blob" in node.p ? node.p.blob : undefined;
			if (typeof blobId !== "string") throw new Error("Chart has no native blob");
			const blob = getNativeBlob(blobId);
			if (!blob) throw new Error("Chart native blob is missing");
			tsp.blob(blob.id, blob.mime, blob.bytes);
			return [{ id: nodeId, k: "image", p: { ...node.p } }];
		});
	}
	function selectedBlocks(view: DocView, fallback: BlockId): BlockId[] {
		const ids = view.blocks.filter(item => selected.has(item.block.id)).map(item => item.block.id);
		return ids.length ? ids : [fallback];
	}
	function record(id: string, entry: TimelineEntry): TspNode {
		const data = entry.data;
		return col(id, [text(`${id}.meta`, `#${entry.seq} ${time(entry.at)} ${data.type} · ${entry.origin}`),
			...(data.type === "post" ? [{ id: `${id}.content`, k: "md", p: { text: `${data.kind}${data.launch ? ` · ${data.launch}` : ""}\n\n${data.text}` } }, ...(data.quote ? [text(`${id}.quote`, `取自会话 ${data.session ?? "未提供"} 的消息 ${data.quote}`)] : [])] : [text(`${id}.content`, JSON.stringify(data, null, 2))])]);
	}
	function blockCard(view: DocView, item: BlockView, hasDraft: boolean): TspNode {
		const block = item.block;
		const prefix = block.id;
		const finished = view.run?.status === "finished";
		const unlocked = item.lock.kind === "none";
		const canEdit = unlocked && !hasDraft && !finished;
		const targets = selectedBlocks(view, block.id);
		const mixed = targets.length > 1 && view.blocks.some(other => targets.includes(other.block.id) && orchestration(other.block.body));
		const c: TspNode[] = [row(`${prefix}.state`, [check(`${prefix}.selected`, "选择", selected.has(block.id), false, checked => { if (checked) selected.add(block.id); else selected.delete(block.id); redraw(); }), check(`${prefix}.done`, "done", block.done, !unlocked || finished, done => { showError(core.setDone(ref, block.id, done)); }), text(`${prefix}.lock`, item.lock.kind === "coordinator" ? "协调者正在编辑" : item.lock.kind === "human" ? "人正在编辑" : "块锁：无"), ...(item.lock.kind === "coordinator" ? [button(`${prefix}.interrupt`, "打断", () => showError(core.interrupt(ref, block.id)), finished)] : [])])];
		for (const name of ["title", "body"] as const) {
			const editing = item.lock.kind === "human" && item.lock.field === name;
			c.push(row(`${prefix}.${name}.controls`, [text(`${prefix}.${name}.label`, name === "title" ? "标题" : "正文"), editing ? button(`${prefix}.${name}.commit`, "完成", () => commit(block.id)) : button(`${prefix}.${name}.pencil`, "铅笔", () => {
				const error = core.pencil(ref, block.id, name);
				if (error) return showError(error);
				focus = `${prefix}.${name}`;
				carets.delete(focus); undo.delete(focus); notices.delete(focus);
				redraw();
			}, !canEdit)]));
			if (editing) c.push(field(`${prefix}.${name}`, { multiline: name === "body", text: () => {
				const current = core.view(ref).blocks.find(candidate => candidate.block.id === block.id)?.lock;
				return current?.kind === "human" && current.field === name ? current.draft : block[name];
			}, write: draft => core.setDraft(ref, block.id, draft) }, `${block.id} ${name}`));
			else c.push(...(name === "body" ? rendered(`${prefix}.body.view`, block.body) : [{ id: `${prefix}.title.view`, k: "md", p: { text: block.title } }]));
			const notice = notices.get(`${prefix}.${name}`);
			if (notice) c.push(text(`${prefix}.${name}.notice`, notice, "warning"));
		}
		item.references.forEach((reference, index) => {
			const id = `${prefix}.reference.${index}`;
			const suffix = reference.status === "fetching" ? " · 取回中" : reference.fetchFailed ? " · 取回失败" : reference.external ? ` · ${time(reference.fetchedAt)}` : "";
			const head = row(`${id}.head`, [text(`${id}.label`, reference.reference.text + suffix), ...(reference.external ? [button(`${id}.refetch`, "重新取回", () => { void core.refetch(ref, reference.reference.targetText).then(showError); })] : [])]);
			c.push(section(id, head, reference.expansion ? [{ id: `${id}.expansion`, k: "md", p: { text: compileText(reference.expansion) } }] : [text(`${id}.pending`, "取回中")], `${index}:${reference.reference.text}`));
		});
		c.push(row(`${prefix}.actions`, [button(`${prefix}.insert`, "新建", () => showError(core.insertBlock(ref, block.id)), !unlocked || finished), button(`${prefix}.delete`, "删除", () => showError(core.deleteBlock(ref, block.id)), !unlocked || finished), ...(view.run ? [button(`${prefix}.launch`, "启动", () => { if (view.run) showError(core.requestLaunch(view.run.id, targets)); }, finished || mixed)] : []), button(`${prefix}.check`, "检查", () => showError(core.requestCheck(ref, targets))), button(`${prefix}.preview`, "预览", () => { void core.preview(ref, targets).then(result => { previews.set(prefix, result); redraw(); }); })]));
		if (view.run && mixed) c.push(text(`${prefix}.mixed`, "编排块只能单独启动", "warning"));
		if (view.run) c.push(section(`${prefix}.launches`, "Launch", item.launches.map(launch => row(`${prefix}.launch.${launch.id}`, [text(`${prefix}.launch.${launch.id}.detail`, `${launch.id} · ${launch.active ? "活跃" : `不活跃 · 会话 ${launch.session}`} · agents: ${launch.agents.join(", ") || "无"}`), button(`${prefix}.launch.${launch.id}.close`, "关闭", () => showError(core.closeLaunch(launch.id)))]))));
		if (item.latestRecord) c.push(section(`${prefix}.latest`, "最近记录", [record(`${prefix}.latest.entry`, item.latestRecord)]));
		const findingNodes = item.findings ? Object.entries(item.findings).map(([name, failed]) => text(`${prefix}.finding.${name}`, `${name}: ${failed ? "不通过" : "通过"}`, failed ? "error" : "success")) : [text(`${prefix}.finding.pending`, "未判定")];
		const report = item.report?.result;
		c.push(section(`${prefix}.checks`, "检查结果", [...findingNodes, ...(report?.kind === "answers" ? Object.entries(report.answers).map(([name, probability]) => text(`${prefix}.report.${name}`, `${name}: ${probability >= 0.5 ? "不通过" : "通过"} · P(yes)=${probability}`, probability >= 0.5 ? "error" : "success")) : [text(`${prefix}.report`, "jev: 未判定")])]));
		const preview = previews.get(prefix);
		if (preview) c.push(section(`${prefix}.compiled`, "编译预览", [text(`${prefix}.compiled.length`, preview.kind === "Ok" ? `${preview.text.length} 字符` : "编译失败"), { id: `${prefix}.compiled.text`, k: "code", p: { text: compileText(preview), lang: "text" } }, text(`${prefix}.compiled.sources`, preview.kind === "Ok" ? JSON.stringify(preview.sources, null, 2) : "")]));
		c.push(...item.notices.map((notice, index) => text(`${prefix}.notice.${index}`, notice, "warning")));
		const md: string[] = [], images: string[] = [];
		let chartNodes = 0;
		function collect(node: TspNode): void { if (node.k === "md" && typeof node.p?.text === "string") md.push(node.p.text); if (node.k === "image") { chartNodes++; if (typeof node.p?.alt === "string") images.push(node.p.alt); } node.c?.forEach(collect); }
		c.forEach(collect);
		if (item.lock.kind === "human" && item.lock.field === "body") chartNodes = summaries.get(block.id)?.chartNodes ?? 0;
		summaries.set(block.id, { chartNodes, view: { md, images } });
		return { id: `${prefix}.card`, k: "card", p: { head: block.id }, c };
	}
	function commit(block: BlockId): void {
		const error = core.commit(ref, block);
		if (error) return showError(error);
		focus = null;
		redraw();
	}
	function switchView(next: DocRef): void {
		ref = next; selected.clear(); previews.clear(); info.clear(); summaries.clear(); focus = null;
		postText = ""; postNext = ""; postBlock = null; postKindChosen = false; filter = "all";
		redraw();
	}
	function root(view: DocView): TspNode {
		actions.clear(); changes.clear(); fields.clear();
		const runs = core.runs();
		const coordinator = core.coordinator();
		const c: TspNode[] = [{ id: "tabs", k: "tabs", p: { min: { h: "2lines" }, shrink: 0, items: [{ id: "template", label: "模板" }, ...runs.map(run => ({ id: run.id, label: run.name }))], active: ref.kind === "template" ? "template" : ref.run } }, { id: "heading", k: "md", p: { text: `# ${view.run?.name ?? view.title}` } }, row("coordinator", [text("coordinator.status", coordinator.connected ? `协调者会话 ${coordinator.session}` : "没有协调者连接"), ...(coordinator.connected && coordinator.pane ? [button("coordinator.focus", "转到协调者", () => { void core.focusCoordinator().then(showError); })] : []), ...(!coordinator.connected && core.canStartCoordinator() ? [button("coordinator.start", "启动协调者", () => { void core.startCoordinator().then(showError); })] : [])]), ...(!coordinator.connected ? [{ id: "coordinator.command", k: "code", p: { text: core.coordinatorCommand(), lang: "sh" } }] : []), ...[...core.errors(), ...view.errors, ...(documentError ? [documentError] : [])].map((error, index) => text(`error.${index}`, error, "error"))];
		if (!view.run) {
			c.push(section("start-run", "开始 Run", [formField("run.name", () => runName, value => { runName = value; }, "Run 名称"), formField("run.every", () => runEvery, value => { runEvery = value; }, "可选更新间隔（秒）"), button("run.start", "开始 Run", () => { const every = seconds(runEvery); if (every === undefined) return showError("更新间隔必须是正整数秒"); showError(core.startRun(runName, every)); })]));
			c.push(section("runs", "Run 列表", runs.map(run => col(`run.${run.id}`, [button(`run.${run.id}.open`, run.name, () => switchView({ kind: "run", run: run.id })), text(`run.${run.id}.summary`, `${run.status === "running" ? "进行中" : "已结束"} · 开始 ${time(run.started_at)} · 结束 ${time(run.finished_at)} · done ${run.done}/${run.total} · update_due ${time(run.update_due)}${run.update_overdue ? " · 状态更新已到期" : ""}${run.status === "finished" && !run.retrospective ? " · 未复盘" : ""}`)]))));
		} else {
			const run = view.run;
			c.push(text("run.status", `${run.status === "running" ? "进行中" : "已结束"} · done ${view.blocks.filter(item => item.block.done).length}/${view.blocks.length} · 开始 ${time(run.startedAt)} · 结束 ${time(run.finishedAt)} · 最近 update ${time(view.lastUpdateAt)}`));
			if (run.updateDue !== null) c.push(row("run.due", [text("run.due.time", `update_due ${time(run.updateDue)}${run.updateDue <= Date.now() ? " · 状态更新已到期" : ""}`), choices("run.snooze.duration", ["300", "900", "3600", "86400"], String(snoozeAfter), value => { snoozeAfter = Number(value); }, run.status === "finished"), button("run.snooze", "推迟", () => showError(core.snooze(run.id, snoozeAfter)), run.status === "finished")]));
			c.push(button("run.finish", "结束 Run", () => showError(core.finishRun(run.id)), run.status === "finished"));
		}
		const hasDraft = [core.view({ kind: "template" }), ...runs.map(run => core.view({ kind: "run", run: run.id }))].some(doc => doc.blocks.some(item => item.lock.kind === "human"));
		c.push(...view.blocks.map(item => blockCard(view, item, hasDraft)));
		if (!view.blocks.length) c.push(button("block.insert", "新建", () => showError(core.insertBlock(ref, null)), view.run?.status === "finished"));
		if (view.run) {
			const run = view.run;
			if (!postKindChosen) postKind = run.status === "finished" && !view.retrospective ? "retrospective" : "update";
			const kinds: readonly RecordKind[] = run.status === "finished" ? ["update", "result", "failure", "retrospective"] : ["update", "result", "failure"];
			c.push(section("post", run.status === "finished" && !view.retrospective ? "写复盘" : "写记录", [choices("post.kind", kinds, postKind, kind => { postKind = kind; postKindChosen = true; }), choices("post.block", ["none", ...view.blocks.map(item => item.block.id)], postBlock ?? "none", value => { postBlock = view.blocks.find(item => item.block.id === value)?.block.id ?? null; }), formField("post.text", () => postText, value => { postText = value; }, "记录正文", true), ...(postKind === "update" ? [formField("post.next", () => postNext, value => { postNext = value; }, "可选下次更新时间（秒）")] : []), button("post.submit", "写记录", () => { const next = postKind === "update" ? seconds(postNext) : null; if (next === undefined) return showError("下次更新时间必须是正整数秒"); const error = core.post(run.id, postKind, postText, postBlock, next); if (error) return showError(error); postText = ""; undo.delete("post.text"); carets.delete("post.text"); redraw(); })]));
			c.push(section("timeline", "时间线", [choices("timeline.filter", ["all", ...TYPES], filter, value => { filter = value; }), ...view.timeline.filter(entry => filter === "all" || entry.data.type === filter).map(entry => {
				const data = entry.data;
				return col(`timeline.${entry.seq}`, [record(`timeline.${entry.seq}.record`, entry), ...(data.type === "launch_created" ? [button(`timeline.${entry.seq}.launch`, `打开 ${data.launch} 完整记录`, () => { const launch = core.launchInfo(data.launch); if (launch) { info.set(data.launch, JSON.stringify(launch, null, 2)); redraw(); } })] : [])]);
			}), ...Array.from(info, ([id, value]) => section(`launch-info.${id}`, `${id} 完整记录`, [{ id: `launch-info.${id}.text`, k: "code", p: { text: value, lang: "json" } }]))]));
		}
		return col("main", c);
	}
	function reportStatus(blocks: readonly string[]): void {
		const view = core.view(ref);
		for (const item of view.blocks) if (blocks.includes(item.block.id)) {
			const summary = summaries.get(item.block.id);
			if (summary) core.setRenderStatus(ref, item.block.id, { ...tsp.status(item.block.id), ...summary });
		}
	}
	function redraw(): void {
		if (!opened) return;
		const view = core.view(ref);
		const node = root(view);
		if (focus && !fields.has(focus)) focus = null;
		const ops: FrameOp[] = [...(mounted ? [["del", "main"] as const] : []), ["add", "main", SURFACE, null, node], ["focus", focus]];
		const blocks = view.blocks.map(item => item.block.id);
		const s = tsp.frame(ops, blocks);
		mounted = true;
		tsp.fullRedraw(s);
		reportStatus(blocks);
	}
	function updateField(id: string): void {
		const value = fields.get(id);
		if (!value) return;
		const caret = carets.get(id)!;
		const block = core.view(ref).blocks.find(item => id === `${item.block.id}.title` || id === `${item.block.id}.body`)?.block.id;
		tsp.frame([["set", id, { text: value.text(), cursor: caret.cursor, anchor: caret.anchor }]], block ? [block] : []);
		if (block) reportStatus([block]);
	}
	function applyText(id: string, next: string, cursor: number, anchor: number | null = null, remember = true): void {
		const value = fields.get(id);
		if (!value) return;
		const before = value.text();
		if (next !== before) {
			const error = value.write(next);
			if (error) return showError(error);
			if (remember) { const history = undo.get(id) ?? []; history.push({ text: before, ...(carets.get(id) ?? { cursor: before.length, anchor: null }) }); undo.set(id, history); }
		}
		carets.set(id, { cursor: Math.max(0, Math.min(next.length, cursor)), anchor });
		updateField(id);
	}
	function edit(event: Extract<TspEvent, { ev: "edit" }>): void {
		const value = fields.get(event.id);
		if (!value) return;
		const current = value.text();
		if (event.len !== current.length) { notices.set(event.id, "一次输入因文本已变化未应用"); redraw(); return; }
		applyText(event.id, current.slice(0, event.from) + event.text + current.slice(event.to), event.cursor);
	}
	let keyBuffer = "";
	// A pty read can contain several keys (including text followed immediately by Esc).
	// Only incomplete CSI/paste sequences survive into the next read.
	function keys(bytes: string): void {
		keyBuffer += bytes;
		while (keyBuffer.length) {
			if (keyBuffer.startsWith(`${ESC}[200~`)) {
				const end = keyBuffer.indexOf(`${ESC}[201~`, 6);
				if (end < 0) return;
				key(keyBuffer.slice(0, end + 6)); keyBuffer = keyBuffer.slice(end + 6); continue;
			}
			if (keyBuffer.startsWith(`${ESC}[`)) {
				const sequence = /^\x1b\[[0-9:;?]*[A-Za-z~]/.exec(keyBuffer)?.[0];
				if (!sequence) return;
				key(sequence); keyBuffer = keyBuffer.slice(sequence.length); continue;
			}
			if (keyBuffer[0] === ESC || keyBuffer.charCodeAt(0) < 32 || keyBuffer.charCodeAt(0) === 127) {
				key(keyBuffer[0]!); keyBuffer = keyBuffer.slice(1); continue;
			}
			const plain = /^[^\x00-\x1f\x7f]+/.exec(keyBuffer)![0];
			key(plain); keyBuffer = keyBuffer.slice(plain.length);
		}
	}
	function key(bytes: string): void {
		const kitty = /^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?)?u$/.exec(bytes);
		if (kitty) {
			if (kitty[3] === "3") return; // Key release is not a second edit.
			const code = Number(kitty[1]), modifiers = Number(kitty[2] ?? 1) - 1;
			if (modifiers > 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return;
			bytes = code === 13 ? "\r" : String.fromCodePoint(code);
		}
		if (bytes === ESC || bytes === "\x1b[27u") {
			const editing = core.view(ref).blocks.find(item => item.lock.kind === "human");
			if (editing) commit(editing.block.id);
			return;
		}
		if (!focus) return;
		const value = fields.get(focus);
		if (!value) return;
		const current = value.text();
		const caret = carets.get(focus) ?? { cursor: current.length, anchor: null };
		let cursor = caret.cursor;
		let from = caret.anchor === null ? cursor : Math.min(cursor, caret.anchor);
		let to = caret.anchor === null ? cursor : Math.max(cursor, caret.anchor);
		let insertion: string | null = null;
		if (bytes === "\x7f" || bytes === "\b") { if (from === to) from = previous(current, from); insertion = ""; }
		else if (bytes === `${ESC}[3~`) { if (from === to) to = following(current, to); insertion = ""; }
		else if (bytes === `${ESC}[D`) cursor = caret.anchor === null ? previous(current, cursor) : from;
		else if (bytes === `${ESC}[C`) cursor = caret.anchor === null ? following(current, cursor) : to;
		else if (bytes === `${ESC}[H` || bytes === "\x01") cursor = current.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
		else if (bytes === `${ESC}[F` || bytes === "\x05") { const end = current.indexOf("\n", cursor); cursor = end < 0 ? current.length : end; }
		else if (bytes === "\x1a") { undoField(focus); return; }
		else if (bytes.startsWith(`${ESC}[200~`) && bytes.endsWith(`${ESC}[201~`)) insertion = bytes.slice(6, -6).replace(/\r\n?/g, "\n");
		else if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(bytes)) insertion = bytes.replace(/\r\n?/g, "\n");
		else return;
		if (insertion !== null) {
			if (!value.multiline && insertion.includes("\n")) return;
			applyText(focus, current.slice(0, from) + insertion + current.slice(to), from + insertion.length);
		} else applyText(focus, current, cursor);
	}
	function undoField(id: string): void { const step = undo.get(id)?.pop(); if (step) applyText(id, step.text, step.cursor, step.anchor, false); }
	function event(input: TspEvent): void {
		switch (input.ev) {
			case "action": if (input.act === "invoke") actions.get(input.id)?.(); break;
			case "change": changes.get(input.id)?.(input); break;
			case "edit": edit(input); break;
			case "undo": undoField(input.id); break;
			case "focus": if (fields.has(input.id)) { focus = input.id; tsp.frame([["focus", focus]], []); } break;
			case "theme": void setTheme(input.dark ? "dark" : "light").then(result => { if (!result.success) documentError = result.error ?? "主题切换失败"; redraw(); }); break;
			case "error": if (input.s === undefined) { documentError = input.msg ?? "Tern 渲染错误"; redraw(); } break;
			case "ack": case "toggle": break;
			case "other": {
				const body = input.body;
				if (typeof body !== "object" || body === null || !("ev" in body) || body.ev !== "select" || !("id" in body) || body.id !== "tabs" || !("item" in body) || typeof body.item !== "string") break;
				if (body.item === "template") switchView({ kind: "template" });
				else { const run = parseRunId(body.item); if (run && core.runs().some(candidate => candidate.id === run)) switchView({ kind: "run", run }); }
				break;
			}
		}
	}
	function input(value: TspInput): void {
		switch (value.kind) {
			case "hello": void setTheme(value.dark ? "dark" : "light").then(result => {
				if (!result.success) documentError = result.error ?? "主题初始化失败";
				if (!opened) { tsp.open(SURFACE, "Tern Playbooks", ".pb-button { padding: 3px 8px; border-radius: 5px; background: var(--l1); color: var(--accent); } .pb-disabled { opacity: .4; }"); opened = true; }
				redraw();
			}); break;
			case "event": event(value.event); break;
			case "keys": keys(value.bytes); break;
		}
	}
	core.onChange(() => queueMicrotask(redraw));
	tsp.onStatusChange(reportStatus);
	tsp.start("tern-playbooks", input);
}

function seconds(value: string): number | null | undefined {
	if (value.trim() === "") return null;
	if (!/^[1-9][0-9]*$/.test(value.trim())) return undefined;
	const number = Number(value);
	return Number.isSafeInteger(number) ? number : undefined;
}
function previous(text: string, offset: number): number { if (offset <= 0) return 0; const last = text.charCodeAt(offset - 1); return offset > 1 && last >= 0xdc00 && last <= 0xdfff ? offset - 2 : offset - 1; }
function following(text: string, offset: number): number { if (offset >= text.length) return text.length; const first = text.charCodeAt(offset); return first >= 0xd800 && first <= 0xdbff ? offset + 2 : offset + 1; }
