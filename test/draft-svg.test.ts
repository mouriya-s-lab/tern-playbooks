import { describe, expect, test } from "bun:test";
import type { ChangeView, Parsed, RenderContext } from "../src/service/draft/contract";
import { parseSvg, renderSvg, type SvgSpec } from "../src/service/draft/svg";

function parse(source: string, line = 10): Parsed<SvgSpec> {
	return parseSvg({ args: "", lines: source.split("\n"), line });
}

function value(source: string): SvgSpec {
	const result = parse(source);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.value;
}

function rejected(source: string, line: number, message: string): void {
	const result = parse(source);
	expect(result.ok).toBe(false);
	expect(result.diagnostics).toContainEqual({ component: "svg", severity: "error", line, message: expect.stringContaining(message) });
}

describe("raw SVG sizing and preservation", () => {
	test("keeps exact source, whitespace, CJK, and theme variables", () => {
		const source = '\n<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80">\n  <rect width="240" height="80" fill="var(--surface)"/>\n  <text x="10" y="40" fill="var(--fg)">中文标签</text>\n</svg>\n';
		const result = parse(source);
		expect(result).toEqual({ ok: true, value: { source, width: 240, height: 80 }, diagnostics: [] });
	});

	test("uses both root dimensions before viewBox and ignores nested dimensions", () => {
		expect(value('<svg width="320px" height="160.5" viewBox="0 0 90 45"><rect width="9" height="8"/></svg>')).toMatchObject({ width: 320, height: 160.5 });
	});

	test("reads signed, decimal, exponential viewBox user units with whitespace or commas", () => {
		expect(value("<svg viewBox='-10, +.5, 6e2, 3E2' />")).toMatchObject({ width: 600, height: 300 });
		expect(value('<svg\nviewBox="0\n0\t240 80"/>')).toMatchObject({ width: 240, height: 80 });
	});

	for (const attributes of ['width="50"', 'height="30"', 'width="0" height="10"', 'width="-10" height="10"', 'width="100%" height="50%"', 'width="10px-junk" height="20"', 'width="Infinity" height="20"', 'width="1e999" height="20"']) {
		test(`falls back to viewBox for incomplete or unusable dimensions: ${attributes}`, () => {
			const result = parse(`<svg ${attributes} viewBox="0 0 240 80"/>`);
			expect(result).toMatchObject({ ok: true, value: { width: 240, height: 80 }, diagnostics: [] });
		});
	}

	for (const attributes of ["", 'viewBox="0 0 0 20"', 'viewBox="0 0 20 -10"', 'viewBox="0 0 NaN 20"', 'viewBox="0 0 1e999 20"', 'viewBox="0 0 20 10junk"', 'viewBox="0 0 20"']) {
		test(`warns and uses 600×300 when no valid dimensions exist: ${attributes}`, () => {
			const result = parse(`\n<svg ${attributes}/>`);
			expect(result).toMatchObject({ ok: true, value: { width: 600, height: 300 } });
			expect(result.diagnostics).toEqual([{ component: "svg", severity: "warning", line: 11, message: expect.stringContaining("600×300") }]);
		});
	}
});

describe("SVG root and safety validation", () => {
	for (const source of ["", "   ", "text", "<div><svg/></div>", '<svgish width="10" height="20"/>', "<SVG/>", "<svg/><svg/>"]) {
		test(`rejects absent or non-SVG/multiple roots: ${JSON.stringify(source)}`, () => {
			expect(parse(source).ok).toBe(false);
		});
	}

	for (const name of ["script", "SCRIPT", "foreignObject", "foreignobject", "s:script", "s:foreignObject"]) {
		test(`rejects unsafe element ${name} on its actual line`, () => {
			rejected(`<svg width="240" height="80">\n  <${name}/>\n</svg>`, 11, `禁止 <${name}>`);
		});
	}

	for (const name of ["onclick", "onload", "ONCLICK", "onmouseover", "s:onload"]) {
		test(`rejects event handler ${name} across lines and quoted >`, () => {
			rejected(`<svg width="240" height="80">\n<rect title="a > b"\n  ${name} = 'alert(1 > 0)'/>\n</svg>`, 12, name);
		});
	}

	for (const name of ["href", "xlink:href", "HREF", "XLINK:HREF"]) {
		for (const target of ["https://example.org/p.svg#shape", "//example.org/p.svg", "file.svg#shape", "data:image/svg+xml,foo", "javascript:alert(1)", "", "#", " #shape", "#two shapes", "&#35;shape"]) {
			test(`rejects external or nonfragment ${name}=${JSON.stringify(target)}`, () => {
				rejected(`<svg width="240" height="80">\n<use\n ${name}="${target}"/>\n</svg>`, 12, "#fragment");
			});
		}
	}

	test("permits internal href and xlink:href references without rewriting them", () => {
		const source = '<svg width="240" height="80" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><path id="图形" d="M0 0h10"/></defs><use href="#图形"/><use xlink:href="#图形"/></svg>';
		expect(parse(source)).toEqual({ ok: true, value: { source, width: 240, height: 80 }, diagnostics: [] });
	});

	test("ignores forbidden-looking text only inside comments, CDATA and quoted text", () => {
		const source = '<?xml version="1.0"?>\n<!-- <script onload="bad()" href="external"/> -->\n<svg width="240" height="80">\n<!-- <foreignObject/> -->\n<text><![CDATA[<script onclick="bad" href="outside">]]></text>\n<rect data-note="onclick=bad > script"/>\n</svg>';
		expect(parse(source)).toEqual({ ok: true, value: { source, width: 240, height: 80 }, diagnostics: [] });
	});

	test("reports every unsafe construct rather than drawing a partially accepted source", () => {
		const result = parse('<svg width="240" height="80">\n<script/>\n<foreignObject/>\n<rect onclick="bad"/>\n<use href="outside"/>\n</svg>');
		expect(result.ok).toBe(false);
		expect(result.diagnostics.map(item => item.line)).toEqual([11, 12, 13, 14]);
	});

	for (const source of ['<svg width="240" height="80"><rect onload="bad></rect></svg>', '<svg><rect href=outside/></svg>', '<svg><rect/></g>', '<svg><rect/>', '<svg><!-- never closes', '<svg><![CDATA[never closes', '<?xml never closes', '<!DOCTYPE svg [<!ENTITY unsafe "external">]><svg/>']) {
		test(`does not bypass validation on malformed markup: ${JSON.stringify(source)}`, () => {
			expect(parse(source).ok).toBe(false);
		});
	}
});

describe("SVG rendering", () => {
	for (const view of ["changes", "before", "after"] satisfies readonly ChangeView[]) {
		test(`passes raw source and dimensions to ctx.svg in ${view} view`, () => {
			const spec = value('<svg width="240" height="80"><text fill="var(--accent)">中文</text></svg>');
			const calls: { readonly id: string; readonly source: string; readonly size: { readonly w: number; readonly h: number }; readonly alt: string }[] = [];
			const ctx: RenderContext = {
				id: "draft.panel.3", view,
				svg(id, source, size, alt) {
					calls.push({ id, source, size, alt });
					return { id, k: "image", p: { alt, w: size.w, h: size.h } };
				},
				image() { throw new Error("raw SVG must use ctx.svg"); },
				readFile() { throw new Error("raw SVG must not read files"); },
			};
			const rendered = renderSvg(spec, ctx);
			expect(calls).toEqual([{ id: `${ctx.id}.image`, source: spec.source, size: { w: 240, h: 80 }, alt: "SVG 图形" }]);
			expect(rendered.diagnostics).toEqual([]);
			expect(rendered.nodes).toHaveLength(1);
			expect(rendered.nodes[0]?.id.startsWith(`${ctx.id}.`)).toBe(true);
			expect(new Set(rendered.nodes.map(node => node.id)).size).toBe(rendered.nodes.length);
		});
	}
});
