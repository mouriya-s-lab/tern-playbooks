import { describe, expect, test } from "bun:test";
import { renderDraft, type DraftHost } from "../src/service/draft/components";
import type { TspNode } from "../src/service/tsp-types";

const host: DraftHost = {
	id: "b1.design.view",
	context: { svg: id => ({ id, k: "image" }), image: id => ({ id, k: "image" }), readFile: () => ({ ok: false, error: "absent" }) },
	view: () => "changes",
	viewSwitch: id => ({ id, k: "row" }),
};

function ids(nodes: readonly TspNode[]): string[] {
	return nodes.flatMap(node => [node.id, ...ids(node.c ?? [])]);
}

describe("renderDraft", () => {
	test("a repeated panel ID is a diagnostic, and every node id stays unique so Tern keeps the frame", () => {
		const drawn = renderDraft("## A First\ntext\n\n## A Second\nmore\n", host);
		expect(drawn.diagnostics).toContainEqual(expect.objectContaining({ line: 4, severity: "error", component: "draft" }));
		const all = ids(drawn.nodes);
		expect(new Set(all).size).toBe(all.length);
	});

	test("a sheet lays panels in rows of cols, a span taking that many columns", () => {
		const drawn = renderDraft("---\ncols: 2\n---\n## A One\nx\n## B Two {span=2}\ny\n## C Three\nz\n", host);
		const grid = drawn.nodes.find(node => node.id === "b1.design.view.panels")!;
		expect(grid.c!.map(row => row.c!.filter(cell => cell.k === "card").length)).toEqual([1, 1, 1]);
	});
});
