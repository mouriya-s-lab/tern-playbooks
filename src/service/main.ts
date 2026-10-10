#!/usr/bin/env bun
// Document service entry: `tern-playbook <playbook.yaml>` run inside a Tern pane.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { socketPath } from "../domain/protocol";
import { checks } from "./checks";
import { Core } from "./core";
import { fetcher } from "./fetch";
import { focusPane, ownPane, splitCoordinator } from "./panes";
import { references } from "./references";
import { serveK1 } from "./socket";
import { createStore } from "./store";
import { createTspSession } from "./tsp";
import { startUi } from "./ui";

const file = process.argv[2];
if (!file) {
	process.stderr.write("用法：tern-playbook <playbook.yaml>\n");
	process.exit(2);
}
const templatePath = realpathSync(resolve(file));
const core = new Core({
	store: createStore(templatePath),
	references,
	fetcher,
	checks,
	panes: { ownPane, splitCoordinator, focusPane },
	extensionEntry: resolve(import.meta.dir, "../extension/index.ts"),
});
const loadError = core.load();
if (loadError !== null) {
	process.stderr.write(`Playbook 文件不能解析：${loadError}\n`);
	process.exit(1);
}
const server = serveK1(socketPath(tmpdir(), templatePath), core);
startUi(core, createTspSession());

const shutdown = (): void => {
	core.stop();
	server.close();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
