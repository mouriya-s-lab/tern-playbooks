// Text helpers shared by draft component renderers.

/** A styled run for TSP `text`/`kv`/`table`/`tree` labels; `s` holds semantic tokens (strong, em, code, accent, success, warning, error, muted, ins, del). */
export interface Span {
	readonly t: string;
	readonly s?: string;
}

/** Inline Markdown (`**strong**`, `*em*`, `` `code` ``, `~~del~~`) as spans, each also carrying `base` tokens. */
export function inlineSpans(text: string, base = ""): Span[] {
	const spans: Span[] = [];
	const style = (extra: string): string | undefined => [base, extra].filter(Boolean).join(" ") || undefined;
	const push = (t: string, extra = ""): void => {
		if (!t) return;
		const s = style(extra);
		spans.push(s ? { t, s } : { t });
	};
	const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|~~([^~]+)~~|\*([^*\s][^*]*)\*/g;
	let offset = 0;
	for (const match of text.matchAll(pattern)) {
		push(text.slice(offset, match.index));
		if (match[1] !== undefined) push(match[1], "code");
		else if (match[2] !== undefined) push(match[2], "strong");
		else if (match[3] !== undefined) push(match[3], "del");
		else push(match[4]!, "em");
		offset = match.index + match[0].length;
	}
	push(text.slice(offset));
	return spans;
}

/** Plain text of inline Markdown (markers removed), for SVG labels and alt text. */
export function plainText(text: string): string {
	return inlineSpans(text).map(span => span.t).join("");
}

/** Escape text for SVG/XML content and attribute values. */
export function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function wide(code: number): boolean {
	return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd);
}

/** Estimated width of `text` in SVG user units at `fontSize` (sans-serif): wide CJK glyphs take a full em, others about 0.6 em. */
export function textWidth(text: string, fontSize: number): number {
	let units = 0;
	for (const char of text) units += wide(char.codePointAt(0)!) ? 1 : 0.6;
	return units * fontSize;
}

/** Break `text` into lines no wider than `maxWidth` at `fontSize`: at spaces for spaced scripts, per glyph for CJK. */
export function wrapText(text: string, maxWidth: number, fontSize: number): string[] {
	const lines: string[] = [];
	let line = "";
	const tokens = text.match(/[^\s\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]+\s*|\s+|./gu) ?? [];
	for (const token of tokens) {
		if (line && textWidth(line + token.trimEnd(), fontSize) > maxWidth) {
			lines.push(line.trimEnd());
			line = token.trimStart();
		} else line += token;
	}
	if (line.trim()) lines.push(line.trimEnd());
	return lines.length ? lines : [""];
}
