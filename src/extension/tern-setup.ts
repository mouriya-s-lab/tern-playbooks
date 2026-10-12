// The Tern side of an `omp plugin install` (contracts.md K6 安装). omp runs the extension
// factory once while installing and rolls the install back when it throws, so this is
// where a missing Tern refuses the install and where the Tern plugin gets linked.
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

/** The Tern plugin directory shipped inside this package. */
const TERN_PLUGIN_DIR = resolve(import.meta.dir, "../../tern-plugin");
const TERN_PLUGIN_ID = "tern-playbooks";

async function tern(args: readonly string[]): Promise<string> {
	const child = Bun.spawn(["tern", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (exit !== 0) throw new Error(`tern ${args.join(" ")} exited ${exit}: ${stderr.trim()}`);
	return stdout;
}

async function linkedDir(pluginsDir: string): Promise<string | null> {
	const file = Bun.file(join(pluginsDir, `${TERN_PLUGIN_ID}.path`));
	if (!(await file.exists())) return null;
	return (await file.text()).trim();
}

async function setup(): Promise<void> {
	if (Bun.which("tern") === null) {
		throw new Error("Tern Playbooks needs Tern: no `tern` command on PATH. Install Tern (https://docs.stencil.so/tern/) and run the install again.");
	}
	const wanted = await realpath(TERN_PLUGIN_DIR);
	const pluginsDir = (await tern(["plugin", "dir"])).trim();
	if ((await linkedDir(pluginsDir)) === wanted) return;
	await tern(["plugin", "link", wanted, "--json"]);
}

let done: Promise<void> | undefined;

/** Once per process: the factory is rebound for every subagent session. */
export function ensureTernPlugin(): Promise<void> {
	done ??= setup();
	return done;
}
