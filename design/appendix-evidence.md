# 附录：证据

本附录挂在根节点上，记录 [README.md §域](README.md#域) 中 D1–D3 的证据，以及 S8 所参照的 Mattermost Playbooks 的观察。它不设立规则。

## E1 Tern

来源：Tern 插件文档（2026-10-11 读取），以及在本机上的实测：E1.1 与 E1.3 在 `tern 0.7.1 (487bca1)` 上，E1.2 与 E1.4 在 `hello` 回复报告 `ver: 0.7.2` 的 Tern 上。

| 性质 | 出处 | 摘录 |
|---|---|---|
| D1.1 | [Architecture](https://docs.stencil.so/tern/concepts/architecture.md) | "Tern's panes, and the authoritative copy of each pane's screen, live in the session daemon. Windows attach to the daemon and mirror the screens; when a window quits, its panes keep running." |
| D1.2 | [Plugin SDK 首页](https://docs.stencil.so/tern/) | "a CLI, TUI or agent that isn't a plugin speaks the Surface Protocol on its pty and gets the same native elements" |
| D1.3 | [Inputs](https://docs.stencil.so/tern/elements/input.md) | "Two kinds draw a text field whose text your program owns: `editor` for multi-line text … and `input` for one line"；"Tern draws the text, the caret, the selection and decorations; it never edits the text itself." |
| D1.4 | [Input and Events](https://docs.stencil.so/tern/protocol/input.md) 与 E1.1 | "Without one [a selection], only the selecting keys and the drawn-line moves below are Tern's"；插件 block "advertise no features"；`edit`："`len` is the length of the text Tern saw: ignore the event when your text has changed since (keys in flight)." 输入事件表中 `edit` 只有 `id`、`from`、`to`、`text`、`cursor`、`len`，没有帧序号；[Operations](https://docs.stencil.so/tern/protocol/operations.md) 中 `ack` 是"the highest frame `s` the window has drawn"，没有规定它与输入事件的顺序 |
| D1.5 | [Input and Events](https://docs.stencil.so/tern/protocol/input.md) 与 E1.2 | `focus`："A click asked for the keys: in an `editor` or `input` (not `readonly`) that isn't the focus"；输入事件表中没有失去焦点事件 |
| D1.6 | [Events](https://docs.stencil.so/tern/reference/events.md) | host 事件只有 `command_started`、`command_finished`、`cwd`、`title`、`pane_exited`、`spawn`；window 事件中没有文件事件 |
| D1.7 | [awesome-tern](https://github.com/theblazehen/awesome-tern) | "Stencil's GitHub organization; Tern's source is not public." |
| D1.8 | [Text and Code §md](https://docs.stencil.so/tern/elements/text.md)、[Transport §Blobs](https://docs.stencil.so/tern/protocol/transport.md)、[Data §image](https://docs.stencil.so/tern/elements/data.md)、[Theme](https://docs.stencil.so/tern/protocol/theme.md) 与 E1.3 | "Mermaid … the diagram at natural size"；"`b` sends binary data, an image an `image` node shows"；"An SVG blob (`image/svg+xml`, at most 256 KiB) is mounted as real SVG elements"；"reports the appearance as `dark` in the `hello` reply and sends `{"ev":"theme","dark":bool}` when it changes" |
| S1 的替代 | [Window API §Documents cx](https://docs.stencil.so/tern/reference/api-window.md)、[Events](https://docs.stencil.so/tern/reference/events.md) 与 E1.4 | "Desktop `cx.docs` works at document level, not editor-widget level."；`cx.docs` 只有打开、读、大纲、写、编辑、追加、保存、新建笔记与搜索，没有只读、锁或按钮接口；window 事件只有 `window_start`、`focus`、`pane_created`、`pane_closed`、`tab_created`、`tab_closed`、`command_started`、`command_finished`、`cwd`、`title`、`canvas_action`，"Any other name raises `tern.on: unknown window event <name>`"，没有文档变化事件 |
| S3、S4 的替代 | [Window API §Agent cx](https://docs.stencil.so/tern/reference/api-window.md) | "`start({prompt, cwd, command?, how?}) -> pane`: opens like New agent block"；"`ask(agent, text)`: pastes one prompt and presses Enter; requires ready input."；"`wait(agent, {timeout?})` … waits until idle, returning the last assistant text" |

### E1.1 TSP 编辑输入

条件：`tern serve --control <sock>`（无头窗口，默认设置）；探针程序用 Bun 直接写 TSP：`hello` 声明 `features: ["edit","undo"]`，打开 `screen` 表面，`main` 中一个 `editor`，初始文本 `hello world`，记录全部输入。用 `tern ctl` 驱动。

Native composer editing 开启（默认）。操作：`type a`、`key Shift+ArrowLeft` 两次、`type X`、`key Meta+z`、`key ArrowUp`。记录：

```text
{"dir":"in","keys":["61"],"str":"a"}
{"dir":"in","verb":"e","body":{"ev":"edit","id":"ed","from":10,"to":12,"text":"X","cursor":11,"len":12,"sf":"s1"}}
{"dir":"in","verb":"e","body":{"ev":"undo","id":"ed","sf":"s1"}}
{"dir":"in","keys":["1b","5b","41"],"str":"\u001b[A"}
```

没有选区时的 `a` 以按键到达；选区上的输入以 `edit` 到达；⌘Z 以 `undo` 到达；单行文本中的 ↑ 以按键到达。

Native composer editing 关闭（在设置页点击开关，截图确认已关闭）。操作：`key Shift+ArrowLeft`、`type Y`、`key Meta+z`。记录：

```text
{"dir":"in","keys":["1b","5b","31","3b","32","44"],"str":"\u001b[1;2D"}
{"dir":"in","keys":["59"],"str":"Y"}
```

⇧← 以按键 `ESC[1;2D` 到达；`Y` 以按键到达；⌘Z 没有任何输入到达程序。

### E1.2 表单块的点击与焦点事件

条件：无头 `tern serve`；探针 `/tmp/pb-form/FormUiProbe/form.ts` 与 `/tmp/pb-form/LockProbe/svc.ts`（Bun 直接写 TSP），每个块一张 `card`，字段默认为 `md` 渲染视图，铅笔、完成、打断为 `el` 按钮（`actions.click`），完成状态为 `el` 复选框。用 `tern ctl click`、`type`、`key` 驱动。

点击铅笔、点击复选框、点击未聚焦的 `input`（`/tmp/pb-form/FormUiProbe/events.jsonl` 与 `native-events.jsonl`）：

```text
{"ev":"action","id":"b1.edit-title","act":"edit-title","sf":"form"}
{"ev":"change","id":"b2.done","value":"b2","checked":true,"name":"b2.done","sf":"form"}
{"ev":"focus","id":"b1.title","sf":"form"}
```

`card` 设置 `actions.click` 时，在其中已聚焦的 `editor` 内点击，先后到达两个事件（`/tmp/pb-form/FormUiProbe/evidence/bubbling-run-events.jsonl:29-30`）：

```text
{"ev":"edit","id":"b2.prompt","from":79,"to":79,"text":"","cursor":79,"len":232,"sf":"form"}
{"ev":"action","id":"b2","act":"blur","sf":"form"}
```

编辑中点击窗口空白处（`tern ctl click 1100 1100`）：没有事件到达程序，`editor` 保持打开，文件不变（`/tmp/pb-form/LockProbe/evidence/blur-blank.diff` 为空，截图 `/tmp/pb-form/LockProbe/shots/serve/blur-blank-retains-edit.png`）。

渲染视图：块正文中的 `((b2))` 在 `md` 节点中原样显示；数值表格下方显示 auto graph 柱状图，mermaid 围栏绘制成图；把表格中的 12 改为 120 并按 Esc 提交后，图中对应的柱变长（截图 `/tmp/pb-form/FormUiProbe/shots/serve/step5-rendered-chart-mermaid.png` 与 `step6-chart-updated.png`）。

### E1.3 渲染视图：`md` 与 omp auto graph

条件：`tern serve` 无头窗口（亮色外观）；`@oh-my-pi/pi-tui` 18.8.9 经 `bun add` 安装在 `/tmp/pb-chart`；探针 `/tmp/pb-chart/view.ts`。auto graph 源码：`can1357/oh-my-pi@fa5ff4a` 的 `packages/tui/src/chat/table-chart.ts` 与 `packages/coding-agent/src/auto-graph/planner.ts`。

探针把一个含标题、引用、四行数值表格和 mermaid 围栏的块交给 `splitTableCharts`（`always`），得到段 `["markdown","chart"…]`。`lookupTableChart` 返回 720×132 的 SVG，alt 为 `bar chart of 耗时 ms by 阶段`；`describeTableChart` 返回 `{k:"image", p:{alt,w:720,h:132,max:{w:"90ch"},blob:"<sha256>"}}`。探针以 `b` 发送 blob，再发送 `md`、`image`、`md` 三个节点。

截图 `/tmp/pb-chart/shots/serve/view.png`：表格下方显示柱状图，mermaid 围栏绘制成流程图。使用 omp 默认主题（暗色）时，图中类目标签在亮色背景上几乎不可见。`setTheme("light")` 之后（截图 `view-light.png`），标签清晰，柱色换成亮色主题的强调色。

### E1.4 Tern 自带的 Markdown block

条件：无头 `tern serve`；`tern ctl file open <playbook.md> tab` 打开一个含标题、表格、mermaid 围栏、任务列表与 `<!-- pb:b1 -->` 的 Markdown 文件；`tern ctl carly lua` 调用 `cx.docs`。记录与截图在 `/tmp/pb-ui/TernMdBlock/`。

- 文件以 Rendered 视图打开，可直接编辑，表格、mermaid 与复选框原生绘制；`<!-- pb:b1 -->` 以灰色代码框显示（`serve/rendered-initial.png`）。
- `cx.docs:edit(path, {find, replace})` 返回 `{from:7,to:7}`，渲染视图立即更新；`cx.docs:read` 返回未保存的缓冲区文本。
- 缓冲区未修改时，外部写入自动重新加载；缓冲区已修改时显示"Changed on disk since you edited it."与 Compare、Keep mine、Use disk version（`serve/external-conflict.png`）。
- 从 Tern 二进制生成的 `DocsCx` 声明只有 `open`、`read`、`outline`、`write`、`edit`、`append`、`save`、`new_note`、`search`。

## E2 omp

条件：本机 `omp/18.8.8`（Tern 自带，路径 `~/Library/Application Support/Tern/omp/versions/18.8.8`）；源码对照 `@oh-my-pi/pi-coding-agent` 18.8.7。

### E2.1 eval 原语

`xd://eval/agents`：`agent(prompt, agent?, label?, schema?, schemaMode?, isolated?, apply?, merge?) → AgentHandle`，handle 提供 `.wait()`、`.send(message)`、`.cancel()`；`workpool()`；`wait(hs)` 作为屏障。

### E2.2 扩展工具经 eval 调用

源码：`src/eval/js/tool-bridge.ts:67-73` 经 `session.getToolForEvalBridge(name)` 查找工具；`src/session/session-tools.ts:661-664` 从会话工具注册表中查找已启用的工具。

探针：扩展注册工具 `pb_probe`（默认 `loadMode`），命令：

```sh
omp -p --no-session --auto-approve --thinking=low -e /tmp/pb-probe/ext.ts '<在 eval 中执行 tool.pb_probe({op: "compile"})，然后 sleep 8 s>' </dev/null
```

eval 输出：`{"text":"pb_probe ok op=compile","details":{"op":"compile"}}`。

### E2.3 aside 投递

源码：`src/extensibility/extensions/types.ts:1576-1595`，`sendMessage` 的 `deliverAs` 取值 `"steer" | "followUp" | "nextTurn" | "aside"`；`aside` "injects the message at the next agent step boundary without interrupting the in-flight tool batch; when the session is idle it starts a turn regardless of `triggerTurn`"。

探针 1（会话忙）：工具调用后 3 s 发送 `aside`，此时 eval 仍在 sleep。trace：

```text
{"t":1791654626984,"ev":"tool_called","op":"compile"}
{"t":1791654629985,"ev":"aside_sent"}
```

模型报告：消息 `PB_EVENT block=b3 changed since launch` 在 eval 结束之后作为一条单独的消息到达，没有出现在 eval 输出中。

探针 2（会话空闲）：`omp --mode rpc`，工具调用后 15 s 发送 `aside`；模型此前已回复 `LAUNCHED` 并结束 turn。trace：

```text
{"t":1791654713584,"ev":"tool_called","op":"launch","delay_ms":15000}
{"t":1791654714907,"ev":"agent_end"}
{"t":1791654728586,"ev":"aside_sent"}
{"t":1791654728614,"ev":"turn_start"}
{"t":1791654732541,"ev":"agent_end"}
```

rpc 输出中，`session_settled` 之后出现 `role: "custom"`、`customType: "pb-event"` 的消息，模型回复 `WOKE PB_EVENT block=b3 changed since launch`。aside 发出 28 ms 后开始新 turn。

模型的 thinking 把这条消息判断为 "in the user turn … genuinely from the user"。[launch-events.md §6](launch-events.md#6-投递) 的消息首行规则依据这一观测。

### E2.4 subagent 信息对扩展不可见

源码：`src/extensibility/extensions/types.ts:854-866`，`BeforeSubagentSpawnEvent` 只含 `agent`、`invocationKind`、`modelRole`、`patterns`、`spawnKey`。扩展事件列表（同文件 1381-1449）中没有 subagent 结束事件。

### E2.5 auto graph 可在 omp 之外使用

- 设置说明（`docs/settings.md`）：`tui.autoGraph` 取值 `always`、`smart`、`off`；"`smart` lets the judge model pick the chart kind and columns"；"Tern receives the chart as SVG"。
- `@oh-my-pi/pi-tui` 的 `package.json` 导出 `"./*": "./src/*.ts"`，所以 `@oh-my-pi/pi-tui/chat/table-chart` 可直接导入；omp 自己的 `auto-graph/planner.ts` 也以这个路径导入。
- `planner.ts` 的 `KIND_CRITERIA` 列出十一种图：`bar`、`paired`、`grouped`、`line`、`heatmap`、`multiples`、`share`、`diverging`、`scatter`、`change`、`progress`。
- 在 omp 之外调用 `describeTableChart` 之前必须初始化主题（`initThemeSync`），否则抛出 `undefined is not an object (evaluating 'theme.getBgHex')`。运行结果见 [E1.3](#e13-渲染视图md-与-omp-auto-graph)。

### E2.6 jev 判定

- 源码（`can1357/oh-my-pi@fa5ff4a`）：`docs/environment-variables.md` §TypeSafe judgments，`judge()` eval helper 使用 `judge` 模型角色，内建链首为 `typesafe/jev-latest`；`packages/coding-agent/src/eval/py/prelude.py:854-862` 的 `judge` 经桥 `__judge__` 调用宿主；`packages/coding-agent/src/extensibility` 中没有 `judg` 字样，扩展 API 无判定接口。
- 运行：在本 omp 会话的 `eval` 中对 3 个检查状态调用 `judge_batch`。`status()` 报告 `model: commandcode/typesafe/jev`，3/3 完成，花费 $0.000075，耗时 0.5 s。
- 样例：`good`（引用已展开，表格有图）、`missing`（"按照上面日志里的报错…与 issue 讨论的结论一致"，没有任何引用）、`empty_ref`（`<external>` 内为空）。
- 第一轮：`judge_batch`，状态含 `source`、`compiled`、渲染节点摘要与 Tern 回执；三个问题，其中一个把两个条件合成一句（"若有图，alt 是否与表格对应；没有表格也没有图时答 yes"）。P(yes)：

  | 样例 | missing | empty_expansion | chart_matches |
  |---|---|---|---|
  | good | 0.35 | 0.15 | 0.07 |
  | missing | 0.96 | 0.20 | 0.93 |
  | empty_ref | 0.92 | 0.92 | 0.85 |

  `good` 的 alt `bar chart of 耗时 ms by 阶段` 与表格对应，`chart_matches` 却为 0.07。
- 第二轮：对每个样例单独调用 `judge`，状态只含 `source` 与 `compiled`，每个问题一个条件（`missing` 的措辞即 [checks.md §3](checks.md#3-jev-判定) 表中原文）。P(yes)：

  | 样例 | missing | empty_expansion |
  |---|---|---|
  | good | 0.21 | 0.08 |
  | missing | 0.97 | 0.07 |
  | empty_ref | 0.91 | 0.91 |

### E2.7 扩展中止协调者的 agent 操作

- 源码（`can1357/oh-my-pi@fa5ff4a`）：`packages/coding-agent/src/extensibility/extensions/types.ts:514-516`，扩展上下文提供 `isIdle()` 与 `abort()`，注释为 "Abort the current agent operation"。
- 探针：扩展注册工具 `pb_lock`，它立即返回，并在 3 s 后的定时器回调中用该次调用的上下文调用 `abort()`。模型在 `eval` 中先调用 `tool.pb_lock({})`，再 `await Bun.sleep(20000)`。命令：

  ```sh
  omp -p --no-session --auto-approve --thinking=low -e /tmp/pb-abort/ext.ts '<eval: tool.pb_lock，然后 sleep 20 s>' </dev/null
  ```

- trace：

  ```text
  {"t":1791661043612,"ev":"tool_called"}
  {"t":1791661046613,"ev":"abort_called","idle":false}
  {"t":1791661046617,"ev":"tool_end","tool":"eval"}
  {"t":1791661046642,"ev":"agent_end"}
  ```

- `abort()` 之后 4 ms，正在 sleep 的 `eval` 结束；29 ms 后 `agent_end`。omp 输出 `Interrupted by user`。
- 界面打断探针（`/tmp/pb-form/LockProbe/`）：TSP 程序持有块锁并提供 socket；扩展把 `lock` 转发给它，并在 socket 回调中收到 `interrupted` 时调用 `abort()`。模型在 `eval` 中先 `lock` b2，再 `await Bun.sleep(30000)`；人在 Tern 中点击 b2 的打断按钮。扩展 trace 与 TSP 记录（`trace.jsonl`、`events.jsonl`）：

  ```text
  {"t":1791664474152,"verb":"e","body":{"ev":"action","id":"b2.interrupt","act":"interrupt","sf":"form"}}
  {"t":1791664474154,"ev":"interrupted","data":{"block":"b2","request":"cd4ef245-bab2-46f8-80ed-f423e2416cd9"}}
  {"t":1791664474154,"ev":"abort","block":"b2","request":"cd4ef245-bab2-46f8-80ed-f423e2416cd9"}
  {"t":1791664474155,"ev":"tool_execution_end","tool":"eval"}
  {"t":1791664474162,"verb":"e","body":{"ev":"ack","sf":"form","s":15}}
  {"t":1791664474181,"ev":"agent_end","held":[{"block":"b2","request":"cd4ef245-bab2-46f8-80ed-f423e2416cd9"}]}
  {"t":1791664474181,"ev":"unlock_sent","id":"5af68ebb-f605-4867-9013-872209743f86","block":"b2","request":"cd4ef245-bab2-46f8-80ed-f423e2416cd9"}
  ```

- 程序收到打断点击后 10 ms，解锁重绘的帧（`s` 15）被 `ack`；29 ms 后 `agent_end`，扩展随即对 b2 发送 `unlock`。omp 输出 `Interrupted by user`。同一探针中，人持有 b1 的块锁时 `lock` b1 返回 `Locked`；人按 Esc 提交后，`lock` b1 返回包含刚提交内容的块；没有发送 `unlock` 而正常结束的 agent 操作，在 `agent_end` 时由扩展解锁。

### E2.8 subagent 随协调者会话结束

对应 D2.4。源码（`can1357/oh-my-pi@fa5ff4a`，`packages/coding-agent/src/`）：

- `eval/agent-bridge.ts:204-247`：`agent()` 以 `manager.register("task", id, async ({ signal, … }) => runStructuredSubagent({ …, signal }), { id, agentId: id, ownerId })` 把 subagent 注册为会话异步任务管理器中的任务，`ownerId` 为会话的 agent id（第 209 行）。
- `session/agent-session.ts:2908-2921`：`#cancelOwnAsyncJobs` 调用 `manager.cancelAll({ ownerId: this.#agentId }, reason)`；`:5486-5517` `#disposeOwnedAsyncJobs` 调用它并 `manager.dispose({ timeoutMs: 3000 })`；`:5616-5678` `#doDispose` 同时执行 `#disposeOwnedAsyncJobs` 与 `#eval.disposeKernels`。
- `task/executor.ts:1487-1494`：任务的 `signal` 中止时，subagent 以 `shutdown` 原因中止；`:3385-3393` 中止后释放并销毁子会话。
- `modes/interactive-mode.ts:2036-2063`：SIGINT、SIGTERM、SIGHUP 与未捕获异常经同一 teardown 调用 `session.dispose()`。SIGKILL 不执行这条路径。

## E3 GitHub

- D3.2：GitHub 公开仓库中，任何登录账号都可以评论 issue 与 PR。
- D3.3：GitHub 通过 webhook 或 API 轮询提供变化；没有推送到本机进程的通道。
- D3.4：`gh` 的认证由 `gh auth login` 保存，`gh api` 直接使用。
- K3 实测（`gh 2.102.0`，账号 RiriAgent）：
  - issue：`NVIDIA/cuvs#2783`（32 条评论）。PR：`cli/cli#9208`（59 条会话评论，70 条行内审查评论）。
  - `gh api repos/<o>/<r>/issues/<n>` 对 PR 编号返回 issue 形状的对象，含 `pull_request` 字段。
  - `gh api --paginate …/issues/<n>/comments` 的原始输出是一个 JSON 数组（`?per_page=30` 时跨两页合并为一个数组）；`--slurp` 时才是页数组的数组。
  - 评论对象含 `user.login`、`created_at`、`body`，没有 `author` 字段。
  - PR 的会话评论 id 与 `pulls/<n>/comments` 的行内评论 id 交集为空；会话评论对象中没有 `path`、`diff_hunk`、`pull_request_review_id`。
  - 运行记录：`/tmp/gh-api-contract-check/run4.stdout`。

## E4 Mattermost Playbooks

来源：博客 [Getting Started with Playbooks](https://mattermost.com/blog/getting-started-with-playbooks/) 的全部截图，与其中两段视频（Wistia `l4bx0jse7h`，41 s；`80g6onote4`，14 min 56 s）。本地副本在 `/tmp/pb-ui/mm-blog/`，第二段视频的旁白转写在 `walkthrough.srt`。下表的时间点均为第二段视频中的时间，每一行都对照了该时间点的画面。

| 时间 | 人的操作 | 频道或 checklist 中的结果 |
|---|---|---|
| 6:00–6:30 | 启动 run | 新建这次 run 专属的频道；Playbooks bot 加入，并发出欢迎消息；右侧 Run details 显示摘要、Owner、Post update 与 checklist |
| 8:20–8:26 | 点任务旁的 Run | 任务的斜杠命令以用户身份在频道中发出 `@channel Remember to prep for the kickoff meeting!`，按钮变为 Rerun |
| 8:38 | 勾选该任务 | 只有 checklist 进度改变（Kickoff 0/4 → 1/4）；执行与完成是两个操作 |
| 10:41–11:27 | 在任意消息上选 Add to run timeline | 该消息按时间顺序进入 run 的时间线 |
| 11:32–12:10 | 点 Post update，填写 Markdown，设定下次更新的时间 | bot 在频道中发出 "@DemoUser posted an update" 卡片，附 "3 of 18 tasks checked · 2 participants" |
| 12:28–12:42 | 定时器到期 | bot 在频道中发出 "@DemoUser, please provide a status update."，消息带 Post update 与 Snooze 按钮；Post update 按钮变红 |
| 12:58–13:03 | 点 Finish run 并确认 | 频道中出现 "marked this run as finished"，bot 发出 "Would you like to fill out the retrospective report?"，带 Yes 与 No 按钮 |
| 8:52–9:40 | — | bot 私信汇总超期的状态更新、未完成的任务与进行中的 run；`/playbook todo` 随时给出同一汇总 |
