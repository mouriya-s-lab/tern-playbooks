import { diagnostic, type DraftDiagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";
import { inlineSpans } from "./text";
import type { TspNode } from "../tsp-types";

export interface KvSpec {
	readonly cols: number;
	readonly items: readonly {
		readonly kind: "item" | "wide";
		readonly key: string;
		readonly value: string;
	}[];
}

export function parseKv(input: FenceInput): Parsed<KvSpec> {
	const diagnostics: DraftDiagnostic[] = [];
	let cols = 2;
	// Match am's attribute tokens, including quoted values and last-value wins.
	let columnValue: string | undefined;
	for (const match of input.args.matchAll(/([\w-]+)(?:=("[^"]*"|'[^']*'|\S+))?/g)) {
		if (match[1] !== "cols") continue;
		const raw = match[2];
		columnValue = raw === undefined ? "1" : /^["']/.test(raw) ? raw.slice(1, -1) : raw;
	}
	if (columnValue !== undefined) {
		const count = Number(columnValue);
		if (!Number.isFinite(count) || !Number.isInteger(count)) {
			diagnostics.push(diagnostic("kv", Math.max(1, input.line - 1), "列数须为整数；请写 cols=2。"));
		} else cols = Math.max(1, Math.min(count || 2, 6));
	}

	const items: KvSpec["items"][number][] = [];
	for (let index = 0; index < input.lines.length; index++) {
		const text = input.lines[index]!.trim();
		if (!text || text.startsWith("//")) continue;
		const kind = text.startsWith("*") ? "wide" : "item";
		const body = kind === "wide" ? text.slice(1).trim() : text;
		const match = /^([^:：]+)[:：]\s*(.*)$/.exec(body);
		if (!match) {
			diagnostics.push(diagnostic("kv", input.line + index, "缺少键名或冒号；请写 key: value。"));
			continue;
		}
		items.push({ kind, key: match[1]!.trim(), value: match[2]!.trim() });
	}
	if (items.length === 0) {
		if (diagnostics.length === 0) diagnostics.push(diagnostic("kv", input.line, "至少需要一项；请写 key: value。"));
		return { ok: false, diagnostics };
	}
	return { ok: true, value: { cols, items }, diagnostics };
}

export function renderKv(spec: KvSpec, ctx: RenderContext): Rendered {
	const nodes: TspNode[] = [];
	let cells: TspNode[] = [];
	const flush = (): void => {
		if (cells.length === 0) return;
		nodes.push({ id: `${ctx.id}.row.${nodes.length}`, k: "row", p: { gap: "md", align: "start" }, c: cells });
		cells = [];
	};
	for (let index = 0; index < spec.items.length; index++) {
		const item = spec.items[index]!;
		if (item.kind === "wide") {
			flush();
			nodes.push({ id: `${ctx.id}.wide.${index}`, k: "text", p: {
				spans: [{ t: `${item.key}: `, s: "strong" }, ...inlineSpans(item.value, "strong")],
			} });
		} else {
			cells.push({ id: `${ctx.id}.item.${index}`, k: "kv", p: {
				layout: "grid", grow: 1, basis: 0,
				items: [{ k: item.key, v: inlineSpans(item.value) }],
			} });
			if (cells.length === spec.cols) flush();
		}
	}
	flush();
	return { nodes, diagnostics: [] };
}
