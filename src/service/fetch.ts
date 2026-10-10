import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExternalTarget, FetchOutcome, IssueComment, IssueValue } from "../domain/model";
import type { Fetcher } from "../domain/ports";

const TIMEOUT_MS = 30_000;

type GhResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };

async function gh(args: readonly string[]): Promise<GhResult> {
	const process = Bun.spawn(["gh", "api", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		process.kill("SIGKILL");
	}, TIMEOUT_MS);
	try {
		// Drain both pipes while the child is running, including on failure.
		const [text, stderr, code] = await Promise.all([
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
			process.exited,
		]);
		if (timedOut || code !== 0) {
			return {
				ok: false,
				error: `gh api ${args.join(" ")}: ${timedOut ? "timed out after 30 s; " : ""}exit code ${code}${process.signalCode ? `; signal ${process.signalCode}` : ""}; stderr: ${stderr}`,
			};
		}
		return { ok: true, text };
	} catch (error: unknown) {
		// Do not leave a child running if consuming its output fails.
		process.kill("SIGKILL");
		await process.exited;
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

function stringField(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`Invalid GitHub JSON: ${field} must be a string`);
	return value;
}

function parseIssue(issueText: string, commentsText: string): IssueValue {
	const issue: unknown = JSON.parse(issueText);
	if (typeof issue !== "object" || issue === null || !("title" in issue) || !("body" in issue)) {
		throw new Error("Invalid GitHub JSON: issue must have title and body");
	}
	const title = stringField(issue.title, "title");
	// GitHub represents an absent issue body as null, not an empty string.
	const body = issue.body === null ? "" : stringField(issue.body, "body");
	const pages: unknown = JSON.parse(commentsText);
	if (!Array.isArray(pages)) throw new Error("Invalid GitHub JSON: comments pages must be an array");
	const comments: IssueComment[] = [];
	for (const page of pages) {
		if (!Array.isArray(page)) throw new Error("Invalid GitHub JSON: comments page must be an array");
		for (const value of page) {
			const comment: unknown = value;
			if (typeof comment !== "object" || comment === null || !("user" in comment)
				|| !("created_at" in comment) || !("body" in comment)
				|| typeof comment.user !== "object" || comment.user === null || !("login" in comment.user)) {
				throw new Error("Invalid GitHub JSON: comment must have user.login, created_at, and body");
			}
			comments.push({
				author: stringField(comment.user.login, "comment.user.login"),
				createdAt: stringField(comment.created_at, "comment.created_at"),
				body: comment.body === null ? "" : stringField(comment.body, "comment.body"),
			});
		}
	}
	return { title, body, comments };
}

export const fetcher: Fetcher = {
	async fetch(target: ExternalTarget, baseDir: string): Promise<FetchOutcome> {
		try {
			switch (target.kind) {
				case "file": {
					const text = await readFile(resolve(baseDir, target.path), "utf8");
					return { ok: true, at: Date.now(), value: { kind: "file", text } };
				}
				case "issue":
				case "pull": {
					const endpoint = `repos/${target.owner}/${target.repo}/issues/${target.number}`;
					const issue = await gh([endpoint]);
					if (!issue.ok) return { ok: false, at: Date.now(), error: issue.error };
					// --slurp gives one JSON value containing the ordered pagination arrays.
					const comments = await gh(["--paginate", "--slurp", `${endpoint}/comments`]);
					if (!comments.ok) return { ok: false, at: Date.now(), error: comments.error };
					return { ok: true, at: Date.now(), value: { kind: "issue", issue: parseIssue(issue.text, comments.text) } };
				}
			}
		} catch (error: unknown) {
			return { ok: false, at: Date.now(), error: error instanceof Error ? error.message : String(error) };
		}
	},
};
