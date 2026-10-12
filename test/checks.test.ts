import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { BlockId, BlockResult, CompileError, CompileResult, Source } from "../src/domain/model";
import type { ChecksModule } from "../src/domain/ports";
import { checks } from "../src/service/checks";

const numericTable = "| Stage | ms |\n|---|---|\n| Compile | 12 |\n| Fetch | 340 |\n| Launch | 85 |\n| Write | 9 |";
const textTable = "| Stage | State |\n|---|---|\n| Compile | ready |\n| Fetch | complete |";
const ok: CompileResult = { kind: "Ok", text: "Complete prompt", sources: [] };
const site = { block: "b1", reference: "((b2))" } as const;
const compileErrors: readonly CompileError[] = [
	{ kind: "UnknownBlock", block: "b2", at: site },
	{ kind: "UnknownTarget", at: site },
	{ kind: "BadExpression", reason: "invalid selector", at: site },
	{ kind: "Cycle", path: ["b1", "b2", "b1"], at: site },
	{ kind: "TooDeep", at: site },
	{ kind: "NoResult", block: "b2", at: site },
	{ kind: "FetchFailed", target: "missing.txt", error: "ENOENT", at: site },
];
const input: Parameters<ChecksModule["findings"]>[0] = {
	compiled: ok,
	expansions: [],
	content: { kind: "task", body: "A complete prompt without tables." },
	render: { blockError: false, documentError: false, pendingOverdue: false, chartNodes: 0, draftErrors: 0, view: { md: [], images: [] } },
};

describe("deterministic findings", () => {
	test("a complete rendered prompt passes all six checks", () => {
		expect(checks.findings(input)).toEqual({
			compile: false,
			empty_expansion: false,
			render_error: false,
			render_pending: false,
			chart: false,
			draft: false,
		});
	});

	for (const error of compileErrors) {
		test(`compile fails for ${error.kind}`, () => {
			expect(checks.findings({ ...input, compiled: { kind: "Err", error } }).compile).toBe(true);
		});
	}

	test("an empty compiled prompt is not an empty reference expansion", () => {
		expect(checks.findings({ ...input, compiled: { ...ok, text: "" } }).empty_expansion).toBe(false);
	});

	for (const text of ["", " ", "\t\r\n", "\u00a0\u2003"]) {
		test(`empty expansion fails for ${JSON.stringify(text)}`, () => {
			expect(checks.findings({ ...input, expansions: [ok, { ...ok, text }, ok] }).empty_expansion).toBe(true);
		});
	}

	test("nonempty text and failed expansions do not count as empty expansions", () => {
		const failed: CompileResult = { kind: "Err", error: { kind: "UnknownTarget", at: site } };
		expect(checks.findings({ ...input, expansions: [failed, { ...ok, text: " \n x \t " }] }).empty_expansion).toBe(false);
	});

	for (const blockError of [false, true]) {
		for (const documentError of [false, true]) {
			test(`render error combines block=${blockError}, document=${documentError}`, () => {
				expect(checks.findings({ ...input, render: { ...input.render, blockError, documentError } }).render_error).toBe(
					blockError || documentError,
				);
			});
		}
	}

	for (const pendingOverdue of [false, true]) {
		test(`render pending reflects overdue=${pendingOverdue}`, () => {
			expect(checks.findings({ ...input, render: { ...input.render, pendingOverdue } }).render_pending).toBe(pendingOverdue);
		});
	}

	for (const chartNodes of [0, 1, 2, 3]) {
		test(`two chartable tables versus ${chartNodes} images`, () => {
			const body = `${numericTable}\n\nBetween tables.\n\n${numericTable}`;
			expect(checks.findings({ ...input, content: { kind: "task", body }, render: { ...input.render, chartNodes } }).chart).toBe(chartNodes < 2);
		});
	}

	test("all failures can coexist independently", () => {
		expect(
			checks.findings({
				compiled: { kind: "Err", error: { kind: "UnknownTarget", at: site } },
				expansions: [{ ...ok, text: "\n" }],
				content: { kind: "task", body: numericTable },
				render: { blockError: true, documentError: false, pendingOverdue: true, chartNodes: 0, draftErrors: 2, view: { md: [], images: [] } },
			}),
		).toEqual({ compile: true, empty_expansion: true, render_error: true, render_pending: true, chart: true, draft: false });
	});
});

describe("design draft findings", () => {
	const cleanDesign = "Design overview.\n\n## A Architecture\nA complete design.\n\n## B Execution\nImplement the plan.";
	const designContent = { kind: "design", requirement: "A user requirement.", design: cleanDesign } as const;

	test("design content skips empty expansion and chart checks", () => {
		const findings = checks.findings({
			...input,
			content: { ...designContent, requirement: numericTable, design: `## A Metrics\n${numericTable}` },
			expansions: [{ ...ok, text: " \n\t " }],
			render: { ...input.render, chartNodes: 0 },
		});
		expect(findings.empty_expansion).toBe(false);
		expect(findings.chart).toBe(false);
		expect(findings.draft).toBe(false);
	});

	for (const [name, design] of [
		["unclosed fence", "## A Implementation\n```typescript\nconst value = 1;"],
		["duplicate panel ID", "## A First\nFirst panel.\n\n## A Second\nSecond panel."],
	] as const) {
		test(`draft fails for ${name} without render-reported errors`, () => {
			expect(checks.findings({ ...input, content: { ...designContent, design } }).draft).toBe(true);
		});
	}

	test("a clean design passes all six checks", () => {
		expect(checks.findings({ ...input, content: designContent })).toEqual({
			compile: false,
			empty_expansion: false,
			render_error: false,
			render_pending: false,
			chart: false,
			draft: false,
		});
	});

	for (const draftErrors of [0, 1, 2]) {
		test(`a clean design reflects ${draftErrors} render-reported draft errors`, () => {
			expect(checks.findings({
				...input,
				content: designContent,
				render: { ...input.render, draftErrors },
			}).draft).toBe(draftErrors > 0);
		});
	}

	test("task content does not run draft diagnostics or inherit render-reported draft errors", () => {
		expect(checks.findings({
			...input,
			content: { kind: "task", body: "## A First\nFirst panel.\n\n## A Second\n```typescript\nconst value = 1;" },
			render: { ...input.render, draftErrors: 2 },
		}).draft).toBe(false);
	});
});

describe("real table chart eligibility", () => {
	test("counts numeric tables including a completed table at the body's end", () => {
		expect(checks.chartableTables(numericTable)).toBe(1);
		expect(checks.chartableTables(`${numericTable}\n\nAfter the table.`)).toBe(1);
	});

	test("does not count ordinary prose, text tables, or tables inside fences", () => {
		for (const body of ["", "A | B without a table", textTable, `\`\`\`markdown\n${numericTable}\n\`\`\``]) {
			expect(checks.chartableTables(body)).toBe(0);
		}
	});

	test("counts repeated table occurrences without deduplicating cached chart content", () => {
		const body = `${numericTable}\n\nSecond chart:\n\n${numericTable}\n\n${textTable}`;
		expect(checks.chartableTables(body)).toBe(2);
		expect(checks.chartableTables(body)).toBe(2);
	});
});

describe("version fingerprints", () => {
	const result: BlockResult = { text: "result", at: 123, seq: 7, origin: "human", launch: "l1" };
	const secondResult: BlockResult = { text: "second result", at: 124, seq: 8, origin: "coordinator", launch: null };
	const closure = new Map<BlockId, string | null>([["b1", "prompt"], ["b2", null]]);
	const versionInput: Parameters<ChecksModule["version"]>[0] = { closure, results: [result, secondResult], compiled: ok };

	test("is SHA-256 of the normalized payload", () => {
		const normalized = [
			[["b1", "prompt"], ["b2", null]],
			[
				JSON.stringify([result.text, result.at, result.seq, result.origin, result.launch]),
				JSON.stringify([secondResult.text, secondResult.at, secondResult.seq, secondResult.origin, secondResult.launch]),
			].sort(),
			["Ok", ok.text, []],
		];
		const expected = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
		expect(checks.version(versionInput)).toBe(expected);
		expect(expected).toMatch(/^[0-9a-f]{64}$/);
	});

	test("ignores closure insertion order, result order, and object property order", () => {
		const reorderedResult: BlockResult = { launch: "l1", origin: "human", seq: 7, at: 123, text: "result" };
		const reorderedCompile: CompileResult = { sources: [], text: "Complete prompt", kind: "Ok" };
		expect(checks.version({
			closure: new Map([...closure].reverse()),
			results: [secondResult, reorderedResult],
			compiled: reorderedCompile,
		})).toBe(checks.version(versionInput));
	});

	test("distinguishes missing, empty, added, deleted, and edited closure blocks", () => {
		const baseline = checks.version(versionInput);
		for (const entries of [
			[["b1", "prompt"], ["b2", ""]],
			[["b1", "changed"], ["b2", null]],
			[["b1", "prompt"]],
			[["b1", "prompt"], ["b2", null], ["b3", "new"]],
		] satisfies [BlockId, string | null][][]) {
			expect(checks.version({ ...versionInput, closure: new Map(entries) })).not.toBe(baseline);
		}
	});

	test("includes every field of referenced results and retains duplicate results", () => {
		const baseline = checks.version({ ...versionInput, results: [result] });
		for (const changed of [
			{ ...result, text: "changed" },
			{ ...result, at: 124 },
			{ ...result, seq: 8 },
			{ ...result, origin: "coordinator" },
			{ ...result, launch: null },
		] satisfies BlockResult[]) {
			expect(checks.version({ ...versionInput, results: [changed] })).not.toBe(baseline);
		}
		expect(checks.version({ ...versionInput, results: [result, result] })).not.toBe(baseline);
	});

	test("preserves text bytes and source occurrence order while normalizing source properties", () => {
		const sources: readonly Source[] = [
			{ kind: "block", target: "b2", expression: null },
			{ kind: "result", target: "b3.result", expression: "body", seq: 3, origin: "service", launch: null },
			{ kind: "external", target: "file.txt", expression: null, fetchedAt: 456 },
		];
		const compiled: CompileResult = { kind: "Ok", text: "prompt", sources };
		const baseline = checks.version({ ...versionInput, compiled });
		expect(checks.version({ ...versionInput, compiled: { ...compiled, sources: [...sources].reverse() } })).not.toBe(baseline);
		expect(checks.version({ ...versionInput, compiled: { ...compiled, text: "prompt " } })).not.toBe(baseline);
		expect(checks.version({ ...versionInput, compiled: { ...compiled, sources: [
			{ expression: null, target: "b2", kind: "block" },
			{ launch: null, origin: "service", seq: 3, expression: "body", target: "b3.result", kind: "result" },
			{ fetchedAt: 456, expression: null, target: "file.txt", kind: "external" },
		] } })).toBe(baseline);
		const changedSources: readonly Source[] = [
			{ kind: "block", target: "b4", expression: null },
			{ kind: "block", target: "b2", expression: "body" },
			{ kind: "result", target: "b3.result", expression: "body", seq: 4, origin: "service", launch: null },
			{ kind: "result", target: "b3.result", expression: "body", seq: 3, origin: "human", launch: null },
			{ kind: "result", target: "b3.result", expression: "body", seq: 3, origin: "service", launch: "l1" },
			{ kind: "external", target: "file.txt", expression: null, fetchedAt: 457 },
		];
		for (const source of changedSources) {
			expect(checks.version({ ...versionInput, compiled: { ...compiled, sources: [source] } })).not.toBe(
				checks.version({ ...versionInput, compiled: { ...compiled, sources: sources.filter(original => original.kind === source.kind) } }),
			);
		}
	});

	test("includes every error variant, sites, details, and ordered cycle paths", () => {
		const versions = compileErrors.map(error => checks.version({ ...versionInput, compiled: { kind: "Err", error } }));
		expect(new Set(versions).size).toBe(compileErrors.length);
		for (const error of compileErrors) {
			const baseline = checks.version({ ...versionInput, compiled: { kind: "Err", error } });
			expect(baseline).not.toBe(checks.version(versionInput));
			expect(checks.version({ ...versionInput, compiled: { kind: "Err", error: { ...error, at: { ...site, block: "b2" } } } })).not.toBe(baseline);
			expect(checks.version({ ...versionInput, compiled: { kind: "Err", error: { ...error, at: { ...site, reference: "((b3))" } } } })).not.toBe(baseline);
			expect(checks.version({ ...versionInput, compiled: { error: { ...error, at: { reference: site.reference, block: site.block } }, kind: "Err" } })).toBe(baseline);
		}
		const detailPairs: readonly (readonly [CompileError, CompileError])[] = [
			[{ kind: "UnknownBlock", block: "b2", at: site }, { kind: "UnknownBlock", block: "b3", at: site }],
			[{ kind: "NoResult", block: "b2", at: site }, { kind: "NoResult", block: "b3", at: site }],
			[{ kind: "BadExpression", reason: "invalid selector", at: site }, { kind: "BadExpression", reason: "out of range", at: site }],
			[{ kind: "FetchFailed", target: "missing.txt", error: "ENOENT", at: site }, { kind: "FetchFailed", target: "other.txt", error: "ENOENT", at: site }],
			[{ kind: "FetchFailed", target: "missing.txt", error: "ENOENT", at: site }, { kind: "FetchFailed", target: "missing.txt", error: "EACCES", at: site }],
		];
		for (const [original, changed] of detailPairs) {
			expect(checks.version({ ...versionInput, compiled: { kind: "Err", error: changed } })).not.toBe(
				checks.version({ ...versionInput, compiled: { kind: "Err", error: original } }),
			);
		}
		const cycle: CompileError = { kind: "Cycle", at: site, path: ["b1", "b2", "b3", "b1"] };
		expect(checks.version({ ...versionInput, compiled: { kind: "Err", error: cycle } })).not.toBe(
			checks.version({ ...versionInput, compiled: { kind: "Err", error: { ...cycle, path: ["b1", "b3", "b2", "b1"] } } }),
		);
	});
});

describe("closed judge report validation", () => {
	for (const missing of [0, Number.MIN_VALUE, 0.499999999, 0.5, 0.500000001, 1 - Number.EPSILON, 1]) {
		test(`accepts complete probability ${missing}`, () => {
			expect(checks.validateReport({ kind: "answers", answers: { missing } })).toBe(true);
		});
	}

	for (const missing of [-Number.MIN_VALUE, -1, 1 + Number.EPSILON, 2, NaN, Infinity, -Infinity]) {
		test(`rejects out-of-domain probability ${missing}`, () => {
			expect(checks.validateReport({ kind: "answers", answers: { missing } })).toBe(false);
		});
	}

	test("rejects missing, additional, and unknown question ids", () => {
		const answerSets: readonly Readonly<Record<string, number>>[] = [{}, { missing: 0, chart: 0 }, { chart: 0 }, { Missing: 0 }];
		for (const answers of answerSets) {
			expect(checks.validateReport({ kind: "answers", answers })).toBe(false);
		}
	});

	test("accepts an unavailable judge as an explicit result", () => {
		expect(checks.validateReport({ kind: "judge_unavailable" })).toBe(true);
	});

	test("the missing-material verdict switches at its inclusive threshold", () => {
		const question = checks.questions.find(question => question.id === "missing");
		if (!question) throw new Error("Missing-material question absent");
		expect(0.5 - Number.EPSILON >= question.threshold).toBe(false);
		expect(0.5 >= question.threshold).toBe(true);
		expect(0.5 + Number.EPSILON >= question.threshold).toBe(true);
	});
});
