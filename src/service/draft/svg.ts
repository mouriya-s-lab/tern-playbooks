import { diagnostic, type DraftDiagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";

/** Validated raw SVG; dimensions are positive user units, not CSS layout sizes. */
export interface SvgSpec {
	readonly source: string;
	readonly width: number;
	readonly height: number;
}

const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function dimension(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const text = value.trim().replace(/px$/, "");
	if (!numberPattern.test(text)) return undefined;
	const number = Number(text);
	return Number.isFinite(number) && number > 0 ? number : undefined;
}

function viewBoxSize(value: string | undefined): { readonly width: number; readonly height: number } | undefined {
	if (value === undefined) return undefined;
	const parts = value.trim().split(/[\s,]+/);
	if (parts.length !== 4 || parts.some(part => !numberPattern.test(part) || !Number.isFinite(Number(part)))) return undefined;
	const width = Number(parts[2]);
	const height = Number(parts[3]);
	return width > 0 && height > 0 ? { width, height } : undefined;
}

export function parseSvg(input: FenceInput): Parsed<SvgSpec> {
	const source = input.lines.join("\n");
	const diagnostics: DraftDiagnostic[] = [];
	const lineAt = (offset: number): number => {
		let line = input.line;
		for (let i = 0; i < offset; i++) if (source[i] === "\n") line++;
		return line;
	};
	const error = (offset: number, message: string): void => {
		diagnostics.push(diagnostic("svg", lineAt(offset), message));
	};
	const stack: string[] = [];
	let root = false;
	let rootOffset = 0;
	let widthAttribute: string | undefined;
	let heightAttribute: string | undefined;
	let viewBoxAttribute: string | undefined;
	let offset = 0;

	// Inspect markup, not text inside comments/CDATA or quoted attributes. Never rewrite source.
	while (offset < source.length) {
		if (source[offset] !== "<") {
			const end = source.indexOf("<", offset);
			const next = end < 0 ? source.length : end;
			if (stack.length === 0 && source.slice(offset, next).trim()) {
				error(offset, "SVG 根元素必须是 <svg>；请将内容放入 <svg>…</svg>。");
				break;
			}
			offset = next;
			continue;
		}
		let terminator: string | undefined;
		if (source.startsWith("<!--", offset)) terminator = "-->";
		else if (source.startsWith("<![CDATA[", offset) && stack.length > 0) terminator = "]]>";
		else if (source.startsWith("<?", offset)) terminator = "?>";
		if (terminator !== undefined) {
			const end = source.indexOf(terminator, offset + 2);
			if (end < 0) {
				error(offset, `SVG 标记未闭合；请补上 ${terminator}。`);
				break;
			}
			offset = end + terminator.length;
			continue;
		}
		if (source.startsWith("<!", offset)) {
			error(offset, "SVG 不支持声明；请移除 DOCTYPE 等声明，直接使用 <svg>…</svg>。");
			break;
		}
		const opening = /^<(\/?)([A-Za-z_][\w:.-]*)/.exec(source.slice(offset));
		if (!opening) {
			error(offset, "SVG 标签无效；请使用 <svg>…</svg>，文本中的 < 写作 &lt;。");
			break;
		}
		const closing = opening[1] === "/";
		const name = opening[2]!;
		const localName = name.slice(name.lastIndexOf(":") + 1).toLowerCase();
		const isRoot = !root && !closing;
		if (isRoot) {
			root = true;
			rootOffset = offset;
			if (name !== "svg") error(offset, "SVG 根元素必须是 <svg>；请使用 <svg>…</svg>。");
		} else if (!closing && stack.length === 0) {
			error(offset, "SVG 只能有一个根元素；请将全部图形放入同一个 <svg>。");
		}
		if (!closing && (localName === "script" || localName === "foreignobject")) {
			error(offset, `SVG 禁止 <${name}>；请移除此元素，改用静态 SVG 图形。`);
		}
		let cursor = offset + opening[0].length;
		let selfClosing = false;
		let ended = false;
		while (cursor < source.length) {
			const beforeWhitespace = cursor;
			while (/\s/.test(source[cursor] ?? "") && cursor < source.length) cursor++;
			if (source[cursor] === ">" || (!closing && source.startsWith("/>", cursor))) {
				selfClosing = source[cursor] === "/";
				cursor += selfClosing ? 2 : 1;
				ended = true;
				break;
			}
			if (closing || cursor === beforeWhitespace) break;
			const attribute = /^([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(source.slice(cursor));
			if (!attribute) break;
			const attributeName = attribute[1]!;
			const value = attribute[2] ?? attribute[3]!;
			const lowerName = attributeName.toLowerCase();
			const attributeLocalName = lowerName.slice(lowerName.lastIndexOf(":") + 1);
			if (attributeLocalName.startsWith("on")) {
				error(cursor, `SVG 禁止 ${attributeName} 事件处理器；请移除此属性。`);
			}
			if ((lowerName === "href" || lowerName === "xlink:href") && !/^#[^\s]+$/.test(value)) {
				error(cursor, `SVG 的 ${attributeName} 仅允许 #fragment；请改为 href="#图形ID"。`);
			}
			if (isRoot) {
				if (attributeName === "width") widthAttribute = value;
				else if (attributeName === "height") heightAttribute = value;
				else if (attributeName === "viewBox") viewBoxAttribute = value;
			}
			cursor += attribute[0].length;
		}
		if (!ended) {
			error(cursor, "SVG 标签或属性未闭合；请使用 name=\"值\" 并补上 >。");
			break;
		}
		if (closing) {
			if (stack.pop() !== name) error(offset, `SVG 结束标签不匹配；请补上对应的 </${name}>。`);
		} else if (!selfClosing) stack.push(name);
		offset = cursor;
	}
	if (!root && diagnostics.length === 0) error(0, "SVG 根元素必须是 <svg>；请使用 <svg>…</svg>。");
	if (stack.length > 0 && diagnostics.length === 0) error(rootOffset, "SVG 标签未闭合；请补上对应的结束标签，如 </svg>。");
	if (diagnostics.length > 0) return { ok: false, diagnostics };

	const width = dimension(widthAttribute);
	const height = dimension(heightAttribute);
	let size = width !== undefined && height !== undefined ? { width, height } : viewBoxSize(viewBoxAttribute);
	if (size === undefined) {
		size = { width: 600, height: 300 };
		diagnostics.push(diagnostic("svg", lineAt(rootOffset), "SVG 未指定有效尺寸，按 600×300 绘制；请添加 width=\"600\" height=\"300\" 或 viewBox=\"0 0 600 300\"。", "warning"));
	}
	return { ok: true, value: { source, ...size }, diagnostics };
}

export function renderSvg(spec: SvgSpec, ctx: RenderContext): Rendered {
	return { nodes: [ctx.svg(`${ctx.id}.image`, spec.source, { w: spec.width, h: spec.height }, "SVG 图形")], diagnostics: [] };
}
