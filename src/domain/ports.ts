// Contracts between the document service modules. The core (src/service/core.ts) owns state;
// every other module is either a pure function set it calls, an IO adapter it calls, or a
// front end (TSP UI, K1 socket) that calls the core.
import type {
	Block,
	BlockField,
	BlockId,
	BlockLock,
	BlockResult,
	CompileInput,
	CompileResult,
	DocRef,
	ExternalTarget,
	FetchOutcome,
	FetchTable,
	FindingName,
	Findings,
	JudgeReport,
	Launch,
	LaunchId,
	PlaybookDoc,
	RecordKind,
	Reference,
	RunId,
	RunMeta,
	Target,
	TargetKey,
	TimelineEntry,
} from "./model";
import type { EventPayload, Outcome, Request, RunSummary } from "./protocol";

// ---------------------------------------------------------------- references (pure) — src/service/references.ts

export interface ReferencesModule {
	/** All references in a body, in order, skipping fenced and inline code (references.md §1). */
	parseReferences(body: string): Reference[];
	/** Classify a target text (references.md §2); null = UnknownTarget. */
	parseTarget(text: string): Target | null;
	/** Canonical key of a target; used for fetch tables. */
	targetKey(target: Target): TargetKey;
	/** Dependency closure (launch-events.md §3): the roots plus ids reachable through block references (not result references), including missing ids. */
	closure(roots: readonly BlockId[], bodies: ReadonlyMap<BlockId, string>): Set<BlockId>;
	/** External targets referenced anywhere in the closure of `roots`, deduplicated by key. */
	externalTargets(roots: readonly BlockId[], bodies: ReadonlyMap<BlockId, string>): ExternalTarget[];
	/** Block ids whose `.result` is referenced in the closure of `roots`. */
	resultTargets(roots: readonly BlockId[], bodies: ReadonlyMap<BlockId, string>): BlockId[];
	/** Pure compile (references.md §4). */
	compile(order: readonly BlockId[], input: CompileInput): CompileResult;
	/** Expansion of one reference written in `block` (references.md §5, rendered view). */
	expandOne(block: BlockId, reference: Reference, input: CompileInput): CompileResult;
	/** Unified diff from `before` to `after` (launch-events.md §4). */
	unifiedDiff(before: string, after: string): string;
}

// ---------------------------------------------------------------- fetching (IO) — src/service/fetch.ts

export interface Fetcher {
	/** Fetch one external target (contracts.md K3; `file:` relative to `baseDir`). Never throws. */
	fetch(target: ExternalTarget, baseDir: string): Promise<FetchOutcome>;
}

// ---------------------------------------------------------------- persistence (IO) — src/service/store.ts

/** Service record line (README §定义 服务记录文件). */
export type ServiceRecord = { readonly kind: "block"; readonly id: BlockId } | { readonly kind: "run"; readonly id: RunId } | { readonly kind: "launch"; readonly id: LaunchId };

export type ParsedFile = { readonly ok: true; readonly doc: PlaybookDoc; readonly run: RunMeta | null } | { readonly ok: false; readonly error: string };

export interface Store {
	readonly templatePath: string;
	/** Directory the template lives in (base for `file:` targets and `tern split --cwd`). */
	readonly baseDir: string;
	/** Read and parse the template; null run. */
	readTemplate(): ParsedFile;
	/** Read and parse every Run file under `<name>.runs/`. */
	readRuns(): Map<RunId, ParsedFile>;
	/** Serialize (README §S2, runs.md §1). Block bodies as YAML block scalars. */
	serialize(doc: PlaybookDoc, run: RunMeta | null): string;
	/** Parse text in the same format; used for disk edits. */
	parse(text: string, expectRun: boolean): ParsedFile;
	/** Atomic write through a temp file in the same directory; returns the written text. */
	write(ref: DocRef, text: string): void;
	/** Current file text and mtime, or null when the file is missing. */
	stat(ref: DocRef): { readonly text: string; readonly mtimeMs: number } | null;
	/** Service record file (append-only). */
	readServiceRecords(): ServiceRecord[];
	appendServiceRecord(record: ServiceRecord): void;
	/** Run record file `<run>.jsonl`: entries and launch lines (runs.md §3). */
	readRunLog(run: RunId): { readonly entries: TimelineEntry[]; readonly launches: Map<LaunchId, Launch> };
	appendEntry(run: RunId, entry: TimelineEntry): void;
	appendLaunch(run: RunId, launch: Launch): void;
}

// ---------------------------------------------------------------- checks (pure) — src/service/checks.ts

/** What the UI reports about frames for one block (contracts.md K4 块检查的输入). */
export interface RenderStatus {
	/** An `error` event mapped to this block in the current view. */
	readonly blockError: boolean;
	/** An unmapped `error` event since the last fully acked redraw. */
	readonly documentError: boolean;
	/** The newest frame containing this block was sent ≥ 2 s ago and is not acked. */
	readonly pendingOverdue: boolean;
	/** Count of `image` chart nodes the view holds for this block. */
	readonly chartNodes: number;
	/** Text of `md` nodes and alt of `image` nodes the view holds for this block (checks.md §1 `view`). */
	readonly view: { readonly md: readonly string[]; readonly images: readonly string[] };
}

export interface ChecksModule {
	/** Deterministic checks for one block (checks.md §2). `expansions` = each reference's expansion text or error. */
	findings(input: {
		readonly compiled: CompileResult;
		readonly expansions: readonly CompileResult[];
		readonly body: string;
		readonly render: RenderStatus;
	}): Findings;
	/** Chartable tables in a body, per `splitTableCharts` (`always`). */
	chartableTables(body: string): number;
	/** SHA-256 version (checks.md §1). */
	version(input: { readonly closure: ReadonlyMap<BlockId, string | null>; readonly results: readonly BlockResult[]; readonly compiled: CompileResult }): string;
	/** Validate a report against the question table (checks.md §3, §5). */
	validateReport(result: JudgeReport): boolean;
	/** The closed question table (checks.md §3). */
	readonly questions: readonly { readonly id: string; readonly type: "bool"; readonly instructions: string; readonly threshold: number }[];
}

export type { FindingName };

// ---------------------------------------------------------------- core API — implemented by src/service/core.ts

/** A Launch as shown on a card (contracts.md K4). */
export interface LaunchView {
	readonly id: LaunchId;
	readonly active: boolean;
	readonly session: string;
	readonly agents: readonly string[];
}

export interface ReferenceView {
	readonly key: string;
	readonly reference: Reference;
	readonly external: boolean;
	/** "fetching" while a first fetch is in flight. */
	readonly status: "ready" | "fetching";
	readonly fetchedAt: number | null;
	readonly fetchFailed: boolean;
	readonly expansion: CompileResult | null;
}

export interface BlockView {
	readonly block: Block;
	readonly lock: BlockLock;
	readonly references: readonly ReferenceView[];
	readonly launches: readonly LaunchView[];
	readonly latestRecord: TimelineEntry | null;
	readonly findings: Findings | null;
	readonly report: { readonly version: string; readonly result: JudgeReport } | null;
	/** Messages shown beside the block (disk changed field, deleted, dropped input, etc.). */
	readonly notices: readonly string[];
}

export interface DocView {
	readonly ref: DocRef;
	readonly title: string;
	readonly run: RunMeta | null;
	readonly blocks: readonly BlockView[];
	/** Run views only. */
	readonly timeline: readonly TimelineEntry[];
	readonly lastUpdateAt: number | null;
	readonly retrospective: boolean;
	readonly errors: readonly string[];
}

export interface CoordinatorStatus {
	readonly connected: boolean;
	readonly session: string | null;
	readonly pane: string | null;
}

/** Human operations from the TSP UI (contracts.md K4). Each returns an error message or null. */
export interface HumanCommands {
	pencil(ref: DocRef, block: BlockId, field: BlockField): string | null;
	/** Replace the draft text (after an `edit` event, key or paste was applied by the UI). */
	setDraft(ref: DocRef, block: BlockId, text: string): string | null;
	commit(ref: DocRef, block: BlockId): string | null;
	interrupt(ref: DocRef, block: BlockId): string | null;
	setDone(ref: DocRef, block: BlockId, done: boolean): string | null;
	insertBlock(ref: DocRef, after: BlockId | null): string | null;
	deleteBlock(ref: DocRef, block: BlockId): string | null;
	requestLaunch(run: RunId, blocks: readonly BlockId[]): string | null;
	requestCheck(ref: DocRef, blocks: readonly BlockId[]): string | null;
	preview(ref: DocRef, blocks: readonly BlockId[]): Promise<CompileResult>;
	refetch(ref: DocRef, target: TargetKey): Promise<string | null>;
	startRun(name: string, updateEvery: number | null): string | null;
	finishRun(run: RunId): string | null;
	post(run: RunId, kind: RecordKind, text: string, block: BlockId | null, next: number | null): string | null;
	snooze(run: RunId, after: number): string | null;
	closeLaunch(launch: LaunchId): string | null;
	launchInfo(launch: LaunchId): Launch | null;
}

export interface CoreApi extends HumanCommands {
	view(ref: DocRef): DocView;
	runs(): RunSummary[];
	coordinator(): CoordinatorStatus;
	focusCoordinator(): Promise<string | null>;
	/** Document-level messages (disk parse errors, unmapped TSP errors, K5 errors). */
	errors(): readonly string[];
	/** Subscribe to state changes; the UI redraws the affected document (null = everything). */
	onChange(listener: (ref: DocRef | null) => void): () => void;
	/** UI reports render status per block so the core can compute findings. */
	setRenderStatus(ref: DocRef, block: BlockId, status: RenderStatus): void;
}

// ---------------------------------------------------------------- K1 transport — src/service/socket.ts

export interface Connection {
	readonly id: number;
	send(frame: EventPayload): void;
	close(): void;
}

/** Implemented by the core; called by the socket server for each request in arrival order. */
export interface K1Handler {
	connected(conn: Connection): void;
	disconnected(conn: Connection): void;
	handle(conn: Connection, requestId: string, request: Request): Promise<Outcome<unknown>>;
}

/** Re-exported for modules that need the fetch table type. */
export type { FetchTable };
