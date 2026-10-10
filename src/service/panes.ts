type PaneResult = { ok: true; pane: string } | { ok: false; error: string };

/** The daemon supplies this id to programs running in its panes. */
export function ownPane(): string | null {
	return process.env.TERN_PANE ?? null;
}

async function invokeTern(args: readonly string[]): Promise<PaneResult> {
	try {
		const child = Bun.spawn(["tern", ...args], {
			env: process.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0) {
			return { ok: false, error: `tern exited with code ${exitCode}: ${stderr}` };
		}

		const result: unknown = JSON.parse(stdout);
		if (typeof result === "object" && result !== null && "block" in result) {
			const block = result.block;
			if (typeof block === "string" && block.length > 0) {
				return { ok: true, pane: block };
			}
			if (typeof block === "number" && Number.isSafeInteger(block)) {
				return { ok: true, pane: String(block) };
			}
		}
		return { ok: false, error: "tern returned an invalid block id" };
	} catch (error: unknown) {
		return {
			ok: false,
			error: `tern: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** The daemon, not the caller, owns the new pane and its program. */
export function splitCoordinator(
	pane: string,
	cwd: string,
	command: readonly string[],
): Promise<PaneResult> {
	return invokeTern(["split", pane, "right", "--cwd", cwd, "--json", "--", ...command]);
}

export async function focusPane(pane: string): Promise<{ ok: true } | { ok: false; error: string }> {
	const result = await invokeTern(["focus", pane, "--json"]);
	return result.ok ? { ok: true } : result;
}
