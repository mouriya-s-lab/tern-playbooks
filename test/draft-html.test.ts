import { describe, expect, test } from "bun:test";
import { parseHtml, renderHtml, type HtmlSpec } from "../src/service/draft/html";
import type { DraftDiagnostic, RenderContext } from "../src/service/draft/contract";
import type { TspNode } from "../src/service/tsp-types";

function parse(source: string, line = 10): { spec: HtmlSpec; diagnostics: readonly DraftDiagnostic[] } {
	const result = parseHtml({ args: "", lines: source.split("\n"), line });
	if (!result.ok) throw new Error("HTML must be drawable");
	return { spec: result.value, diagnostics: result.diagnostics };
}

function harness(): { ctx: RenderContext; svgs: { source: string; w: number; h: number; alt: string }[] } {
	const svgs: { source: string; w: number; h: number; alt: string }[] = [];
	return {
		svgs,
		ctx: {
			id: "draft.html", view: "changes",
			svg(id, source, size, alt) { svgs.push({ source, ...size, alt }); return { id, k: "image", p: { alt } }; },
			image() { throw new Error("HTML must not read external images"); },
			readFile() { throw new Error("HTML must not read files"); },
		},
	};
}

function flatten(nodes: readonly TspNode[]): TspNode[] {
	return nodes.flatMap(node => [node, ...flatten(node.c ?? [])]);
}

function visible(nodes: readonly TspNode[]): string {
	return nodes.map(node => {
		const text = typeof node.p?.text === "string" ? node.p.text : "";
		const spans = node.p?.spans;
		const runs = Array.isArray(spans) ? spans.map((span: unknown) => typeof span === "object" && span !== null && "t" in span && typeof span.t === "string" ? span.t : "").join("") : "";
		return text + runs + visible(node.c ?? []);
	}).join("");
}

const supportedTags = "div span b i code pre strong em del p h1 h2 h3 h4 ul ol li blockquote hr label button kbd mark section article header footer nav dl dt dd table thead tbody tr th td".split(" ");

describe("HTML escape hatch", () => {
	test("normalizes a closed tree and preserves mixed text order", () => {
		const { spec, diagnostics } = parse('<DIV>前 <strong>A &amp; B</strong> 后</DIV>');
		expect(spec.nodes).toEqual([{ kind: "element", tag: "div", children: [{ kind: "text", text: "前 " }, { kind: "element", tag: "strong", children: [{ kind: "text", text: "A & B" }] }, { kind: "text", text: " 后" }] }]);
		expect(diagnostics).toEqual([]);
		const { ctx } = harness();
		expect(visible(renderHtml(spec, ctx).nodes)).toBe("前 A & B 后");
	});

	test.each(supportedTags)("renders supported tag %s unchanged", tag => {
		const { spec, diagnostics } = parse(tag === "hr" ? "<hr>" : `<${tag}>正文</${tag}>`);
		const { ctx } = harness();
		expect(renderHtml(spec, ctx).nodes[0]?.p?.tag).toBe(tag);
		expect(diagnostics).toEqual([]);
	});

	test.each([["u", "span"], ["ins", "span"], ["s", "del"], ["small", "span"], ["sup", "span"], ["sub", "span"], ["h5", "h4"], ["h6", "h4"]])("maps %s to %s without diagnostic", (inputTag, outputTag) => {
		const { spec, diagnostics } = parse(`<${inputTag}>文字</${inputTag}>`);
		const { ctx } = harness();
		expect(renderHtml(spec, ctx).nodes[0]?.p?.tag).toBe(outputTag);
		expect(diagnostics).toEqual([]);
	});

	test("retains anchor children and appends decoded href as inert muted text", () => {
		const { spec, diagnostics } = parse('<a href="https://example.test/?a=1&amp;b=2"><b>文档</b></a>');
		const { ctx } = harness();
		const rendered = renderHtml(spec, ctx);
		expect(visible(rendered.nodes)).toBe("文档 (https://example.test/?a=1&b=2)");
		expect(rendered.nodes[0]?.p?.tag).toBe("span");
		expect(rendered.nodes[0]?.c?.at(-1)?.p?.spans).toEqual([{ t: " (https://example.test/?a=1&b=2)", s: "muted" }]);
		expect(diagnostics).toEqual([]);
	});

	test("anchors without href preserve content without an empty suffix", () => {
		const { ctx } = harness();
		expect(visible(renderHtml(parse("<a>标签</a>").spec, ctx).nodes)).toBe("标签");
	});

	test("br creates a text newline, including void and self-closing forms", () => {
		const { spec } = parse("<p>一<br>二<BR/>三<br />四</p>");
		const { ctx } = harness();
		const rendered = renderHtml(spec, ctx);
		expect(visible(rendered.nodes)).toBe("一\n二\n三\n四");
		expect(flatten(rendered.nodes).filter(node => node.k === "text").map(node => node.p?.spans)).toEqual([[{ t: "\n" }], [{ t: "\n" }], [{ t: "\n" }]]);
	});

	test("decodes core, common, Latin and numeric entities without decoding twice", () => {
		const { spec } = parse("&amp;&lt;&gt;&quot;&apos;&nbsp; &copy; &mdash; &eacute; &alpha; &#20013;&#x1F600; &amp;lt; &unknown; &constructor;");
		const { ctx } = harness();
		expect(visible(renderHtml(spec, ctx).nodes)).toBe('&<>"\'\u00a0 © — é α 中😀 &lt; &unknown; &constructor;');
	});

	test("handles invalid numeric scalars and core references without semicolons", () => {
		const { ctx } = harness();
		expect(visible(renderHtml(parse("&#0; &#xD800; &#1114112; &#128; &amp &copy &ampersand &alpha").spec, ctx).nodes)).toBe("� � � € & © &ampersand &alpha");
	});

	test.each(["script", "style", "iframe", "object", "embed"])("drops %s with an absolute-line warning", tag => {
		const input = tag === "embed" ? `前\n<${tag} src="bad">\n后` : `前\n<${tag}><b>秘密</b></${tag}>\n后`;
		const { spec, diagnostics } = parse(input, 40);
		const { ctx } = harness();
		expect(visible(renderHtml(spec, ctx).nodes)).toBe("前\n\n后");
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ component: "html", severity: "warning", line: 41 });
		expect(diagnostics[0]?.message).toContain(`<${tag}>`);
	});

	test("raw script contents cannot close or inject surrounding nodes", () => {
		const { spec } = parse('<div>前<script>const fake = "</div><svg/><p>bad";</script>后</div>');
		const { ctx, svgs } = harness();
		expect(visible(renderHtml(spec, ctx).nodes)).toBe("前后");
		expect(svgs).toEqual([]);
		expect(spec.nodes).toHaveLength(1);
	});

	test("drops an unclosed raw-text subtree through EOF", () => {
		const { ctx } = harness();
		const { spec, diagnostics } = parse("前<style>bad<p>bad", 17);
		expect(visible(renderHtml(spec, ctx).nodes)).toBe("前");
		expect(diagnostics[0]?.line).toBe(17);
	});

	test("unknown elements wrap retained children in div and warn on their opening line", () => {
		const { spec, diagnostics } = parse("<main\n title='>'>前<b>后</b></main>\n<widget>尾</widget>", 30);
		const { ctx } = harness();
		const rendered = renderHtml(spec, ctx);
		expect(rendered.nodes[0]?.p?.tag).toBe("div");
		expect(visible(rendered.nodes)).toBe("前后\n尾");
		expect(diagnostics.map(value => [value.line, value.severity])).toEqual([[30, "warning"], [32, "warning"]]);
		expect(diagnostics.every(value => value.message.includes("<div>"))).toBe(true);
	});

	test("ignores HTML class/style and other ineffective attrs without diagnostic", () => {
		const { spec, diagnostics } = parse('<p class="alert" style="color:red" onclick="alert(1)" title=hello>正文</p>');
		const { ctx } = harness();
		expect(renderHtml(spec, ctx).nodes[0]?.p).toEqual({ tag: "p" });
		expect(diagnostics).toEqual([]);
	});

	test("tolerates comments, declarations, unmatched and missing close tags", () => {
		const { spec, diagnostics } = parse('<!DOCTYPE html><!-- comment --></stray><div>一<strong>二</div>三<em>四');
		const { ctx } = harness();
		expect(visible(renderHtml(spec, ctx).nodes)).toBe("一二三四");
		expect(diagnostics).toEqual([]);
	});

	test("preserves literal less-than text and incomplete markup", () => {
		const { ctx } = harness();
		expect(visible(renderHtml(parse('2 < 3 <b>好</b> <span title="未结束').spec, ctx).nodes)).toBe('2 < 3 好 <span title="未结束');
	});

	test("implicitly closes list, paragraph, definition and table cells", () => {
		const { ctx } = harness();
		const list = renderHtml(parse("<ul><li>一<li>二<ul><li>内</ul><li>三</ul>").spec, ctx).nodes[0];
		expect(list?.c?.map(node => visible([node]))).toEqual(["一", "二内", "三"]);
		const paragraphs = renderHtml(parse("<p>一<p>二<div>三</div>").spec, ctx).nodes;
		expect(paragraphs.map(node => node.p?.tag)).toEqual(["p", "p", "div"]);
		const definitions = renderHtml(parse("<dl><dt>键<dd>值<dt>其他<dd>内容</dl>").spec, ctx).nodes[0];
		expect(definitions?.c?.map(node => node.p?.tag)).toEqual(["dt", "dd", "dt", "dd"]);
		const table = renderHtml(parse("<table><tr><th>甲<th>乙<tr><td>1<td>2</table>").spec, ctx).nodes[0];
		expect(table?.c?.map(row => row.c?.map(cell => visible([cell])))).toEqual([["甲", "乙"], ["1", "2"]]);
	});

	test("empty HTML is drawable and fence args do not invent a grammar", () => {
		expect(parseHtml({ args: "arbitrary", lines: [], line: 1 })).toEqual({ ok: true, value: { nodes: [] }, diagnostics: [] });
	});
});

describe("inline SVG", () => {
	test("serializes a subtree to ctx.svg, preserving SVG casing, styles and local refs", () => {
		const { spec, diagnostics } = parse('<p>前<svg viewBox="0 0 240 80"><title>图 &amp; 表</title><defs><clipPath id="clip"><rect width="240" height="80"/></clipPath></defs><g class="shape" style="fill:green" clip-path="url(#clip)"><use href="#clip"/><text x="10" y="20">甲 &lt; 乙</text></g></svg>后</p>');
		const { ctx, svgs } = harness();
		const rendered = renderHtml(spec, ctx);
		expect(visible(rendered.nodes)).toBe("前后");
		expect(flatten(rendered.nodes).filter(node => node.k === "image")).toHaveLength(1);
		expect(svgs).toHaveLength(1);
		expect(svgs[0]).toMatchObject({ w: 240, h: 80, alt: "图 & 表" });
		expect(svgs[0]?.source).toContain('<clipPath id="clip">');
		expect(svgs[0]?.source).toContain('class="shape" style="fill:green" clip-path="url(#clip)"');
		expect(svgs[0]?.source).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(svgs[0]?.source).toContain("甲 &lt; 乙");
		expect(diagnostics).toEqual([]);
	});

	test("removes forbidden SVG subtrees, event handlers and external references with line warnings", () => {
		const { spec, diagnostics } = parse('<svg width="100" height="50">\n<script>bad</script>\n<foreignObject><p>bad</p></foreignObject>\n<rect onclick="bad" fill="url(https://bad)"/>\n<use xlink:href="https://bad"/>\n<image src="data:bad"/>\n<rect style="fill:url( \'#local\' )"/>\n</svg>', 20);
		const { ctx, svgs } = harness();
		renderHtml(spec, ctx);
		expect(diagnostics.map(value => value.line)).toEqual([21, 22, 23, 23, 24, 25]);
		expect(diagnostics.every(value => value.severity === "warning")).toBe(true);
		expect(svgs[0]?.source).not.toMatch(/bad|script|foreignObject|onclick/);
		expect(svgs[0]?.source).toContain("#local");
	});

	test.each([
		['<svg/>', 300, 150],
		['<svg width="400px" height="100"/>', 400, 100],
		['<svg width="200" viewBox="10 10 400 100"/>', 200, 50],
		['<svg height="50" viewBox="0 0 400 100"/>', 200, 50],
		['<svg width="2000" height="1000"/>', 1000, 500],
		['<svg width="100%" viewBox="0 0 320 80"/>', 320, 80],
		['<svg width="0" height="-1" viewBox="bad"/>', 300, 150],
	] as const)("chooses safe size for %s", (source, w, h) => {
		const { ctx, svgs } = harness();
		renderHtml(parse(source).spec, ctx);
		expect(svgs[0]).toMatchObject({ w, h });
	});

	test("CDATA stays literal text while XML serialization escapes it safely", () => {
		const { ctx, svgs } = harness();
		renderHtml(parse('<svg aria-label="示例"><text><![CDATA[A < B & C]]></text></svg>').spec, ctx);
		expect(svgs[0]?.source).toContain("A &lt; B &amp; C");
		expect(svgs[0]?.alt).toBe("示例");
	});

	test("mixed fixture never emits unsupported tags or duplicate ids", () => {
		const { spec } = parse('<div>A<a href="/doc">链接</a><widget><u>B</u><br><s>C</s></widget><svg width="100" height="50"><text x="10" y="20">图</text></svg><script>bad</script><svg/><h6>标题</h6></div>');
		const { ctx, svgs } = harness();
		const first = renderHtml(spec, ctx);
		const nodes = flatten(first.nodes);
		const ids = nodes.map(node => node.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.every(id => id.startsWith(`${ctx.id}.`))).toBe(true);
		expect(nodes.filter(node => node.k === "el").every(node => supportedTags.includes(String(node.p?.tag)))).toBe(true);
		expect(visible(first.nodes)).toBe("A链接 (/doc)B\nC标题");
		expect(svgs).toHaveLength(2);
		expect(first.diagnostics).toEqual([]);
		expect(flatten(renderHtml(spec, ctx).nodes).map(node => node.id)).toEqual(ids);
	});
});
