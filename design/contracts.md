# 契约

本文件拥有 [README.md §交互图](README.md#交互图) 中 K1–K5 五份契约的完整规格。术语定义见 [README.md §定义](README.md#定义)。编译规则见 [references.md](references.md)，Launch 与事件规则见 [launch-events.md](launch-events.md)。

## K1 文档服务 ⇄ 协调者扩展

| 项 | 内容 |
|---|---|
| 参与方 | 提供方：文档服务。使用方：协调者扩展。两者都由根节点设计 |
| 交换 | Unix domain socket 上的换行分隔 JSON。socket 路径为 `${TMPDIR}/tern-playbooks/<Playbook 文件绝对路径的 SHA-256>.sock`。请求 `{id, op, args}`，响应 `{id, ok, result}` 或 `{id, ok: false, error}`；事件 `{event, data}` 由提供方主动发送 |
| 前置条件 | 第一条请求必须是 `hello {session, pane?}`。同一时刻只能有一个连接；第二个 `hello` 得到 `Busy`。`set`、`edit`、`delete` 要求本连接持有该块的块锁。作用于块的操作带可选参数 `run`：有 `run` 时作用于该 Run 的块，没有时作用于模板（[runs.md §1](runs.md#1-模板与-run)） |
| 保证 | 见下方操作表。文档服务按到达顺序逐个处理协调者的请求与人的界面操作，因此一个块的块锁任一时刻只有一个持有者。`lock` 返回该块最新的已提交内容，不含人的编辑草稿（R1）。修改操作各作为一次来源为 `coordinator` 的编辑应用。块锁以任何方式解除时，文档服务重绘该块。`compile` 与 `inspect` 把编译失败放在结果的 `CompileResult.Err` 中，不作为错误返回；`launch` 与 `rebase` 在编译失败时返回错误 `CompileError` |
| 错误 | 闭合列举：`Busy`、`NotHello`、`Locked`（`lock` 时人持有该块的块锁）、`NotLocked`（`set`、`edit`、`delete` 时本连接不持有该块的块锁，包括已被打断）、`UnknownBlock`（作用于块的操作给出的块 id 在模板或该 Run 中不存在）、`UnknownRun`（`run` 参数给出的 Run 不存在）、`RunFinished`（修改操作、`lock` 或 `launch` 作用于已结束的 Run，见 [runs.md §2](runs.md#2-生命周期)）、`BadValue`（`set` 的 `field` 不是 `title` 或 `done`，`value` 的类型不符；`post` 的 `kind` 不在闭合列举中，`retrospective` 写在进行中的 Run，`next` 不是正整数或用于 `update` 以外的记录，或 `origin` 不是 `human`；`start_run` 的 `update_every` 或 `snooze` 的 `after` 不是正整数；`snooze` 时该 Run 的 `update_due` 为空，见 [runs.md §6](runs.md#6-状态更新提醒与复盘)）、`NotFound`（`find` 文本在块正文中不存在）、`Ambiguous`（`find` 文本出现多次）、`BadLaunch`（`launch` 没有 `run`、`blocks` 为空，或编排块与其他块同在其中，见 [launch-events.md §1](launch-events.md#1-launch)）、`CompileError`（附 [references.md §4](references.md#4-编译) 的错误）、`UnknownTarget`（`refetch` 的目标不是 [references.md §2](references.md#2-目标种类与解析器) 中的外部目标）、`BadReport`（`report` 的 `result` 不完整或越界，见 [checks.md §5](checks.md#5-结果显示)）、`UnknownLaunch`（`bind`、`rebase`、`close`、`launch_info` 或 `post` 给出的 Launch 不存在）、`NotOwner`（`bind`、`rebase`、`close` 的 Launch 属于其他会话）、`UnknownEvent`（`ack` 的事件 id 不是当前连接上待确认的事件）。编译失败、取回失败与过期的 `report` 不是 K1 错误：前两者放在 `CompileResult.Err` 或 `refetch` 的结果中，后者按 [checks.md §5](checks.md#5-结果显示) 被丢弃 |
| 失败语义 | socket 断开：连接结束，本连接持有的全部块锁解除，该会话的 Launch 不再活跃。未完成的请求没有结果；修改操作要么完整应用，要么不应用。协调者扩展每 2 s 重连一次，直到协调者会话结束；重连后按 [launch-events.md §2](launch-events.md#2-活跃期) 恢复，块锁不恢复 |
| 生命周期 | 连接：开始于 `hello` 成功（文档服务确认），结束于 socket 关闭（任一方）。协调者持有的块锁：开始于 `lock` 返回（文档服务确认）；结束于该块的 `unlock`、`delete`、打断、该块被磁盘修改删除、所属 Run 结束或连接结束，以先发生者为准（文档服务确认） |
| 质量 | Q1、Q3、Q4 |
| 不承诺 | 不承诺事件顺序与文档编辑顺序一致 |

操作：

| op | args | result |
|---|---|---|
| `hello` | `{session, pane?}` | `{blocks: [块 id], runs: [Run 摘要], pane?}`：模板的块 id 与 [runs.md §5](runs.md#5-读取) 的 Run 摘要。请求中的 `pane` 是协调者所在的 Tern pane id，结果中的 `pane` 是文档服务所在的 Tern pane id，各取自该进程环境中的 `TERN_PANE`，没有时省略（K5） |
| `lock` | `{block}` | `{block}`：该块的 `{id, title, body, done}`。人持有该块的块锁时返回 `Locked`。本连接已持有时返回当前内容，并把该块锁记为由这次请求取得 |
| `unlock` | `{block, request}` | 无。只有该块的块锁由本连接持有、并且记为由 `request` 这条 `lock` 请求取得时才解除；否则不做任何事 |
| `read` | `{run?, block?}` | 无 `block`：`{title, blocks}`，全部块的已提交内容；有 `run` 时另含 `run` 映射。有 `block`：该块。不需要块锁 |
| `set` | `{block, field, value}` | 无。`field` 为 `title` 时 `value` 是字符串，为 `done` 时是布尔值 |
| `edit` | `{block, find, replace}` | 无。`find` 必须在块正文中恰好出现一次，否则返回 `NotFound` 或 `Ambiguous`，不修改块正文 |
| `insert` | `{after?, title, body}` | `{block}`：新块 id。无 `after` 时插入到文档末尾。新块的 `done` 为假，块锁为无 |
| `delete` | `{block}` | 无。删除该块，块锁随之解除 |
| `refetch` | `{targets}` | `{fetched: [{target, ok}]}`。按 [references.md §5](references.md#5-文档取回表与预览) 重新取回这些外部目标，替换文档取回表中的结果 |
| `compile` | `{blocks}` | `CompileResult`，不创建 Launch |
| `inspect` | `{blocks}` | 检查状态（[checks.md §1](checks.md#1-检查状态)），不创建 Launch |
| `report` | `{blocks, version, result}` | 无。`version` 为 `inspect` 返回的检查状态版本；显示规则见 [checks.md §5](checks.md#5-结果显示) |
| `launch` | `{run, blocks}` | `{launch, text}`：Launch id 与快照文本 |
| `bind` | `{launch, agent}` | 无 |
| `rebase` | `{launch}` | `{baseline}`：新基线文本 |
| `close` | `{launch}` | 无。结束该 Launch（[launch-events.md §1](launch-events.md#1-launch)） |
| `launch_info` | `{launch}` | 该 Launch 的完整记录（[runs.md §5](runs.md#5-读取)） |
| `start_run` | `{name, update_every?}` | `{run}`：新 Run 的 id（[runs.md §2](runs.md#2-生命周期)）。`update_every` 为正整数秒（[runs.md §6](runs.md#6-状态更新提醒与复盘)） |
| `finish_run` | `{run}` | 无 |
| `runs` | 无 | `{runs: [Run 摘要]}` |
| `timeline` | `{run, after?}` | `{entries}`：序号大于 `after` 的时间线条目（[runs.md §3](runs.md#3-时间线)） |
| `post` | `{run, kind, text, block?, launch?, next?, quote?, origin?}` | `{seq}`：写入的时间线条目序号。已结束的 Run 也接受；`retrospective` 只在已结束的 Run 中接受；`next` 为正整数秒，只用于 `update`；`origin` 只能为 `human`，表示由人在协调者会话中经 `/playbook-add` 写入，没有时条目的 `origin` 为 `coordinator`（[runs.md §4](runs.md#4-记录)、[§6](runs.md#6-状态更新提醒与复盘)、[§7](runs.md#7-把会话中的消息加入时间线)） |
| `snooze` | `{run, after}` | `{due}`：新的 `update_due`。`after` 为正整数秒（[runs.md §6](runs.md#6-状态更新提醒与复盘)） |
| `ack` | `{event}` | 无。确认收到块变化事件（[launch-events.md §6](launch-events.md#6-投递)） |

事件：`block_changed`（[launch-events.md §4](launch-events.md#4-块变化事件)）、`launch_requested`（[launch-events.md §5](launch-events.md#5-启动请求)）、`check_requested`（[checks.md §4](checks.md#4-触发)）、`run_started`、`run_finished` 与 `done_changed`（[runs.md §2](runs.md#2-生命周期)）、`update_due`（[runs.md §6](runs.md#6-状态更新提醒与复盘)）、`interrupted`（人打断了协调者持有的一个块锁，该块锁已解除；`data` 为 `{run?, block, request}`，`request` 是取得该块锁的 `lock` 请求的 `id`；见 K4）。

## K2 协调者扩展 ⇄ 协调者会话

| 项 | 内容 |
|---|---|
| 参与方 | 提供方：协调者扩展（根节点设计）。使用方：协调者会话中的模型与 `eval` 代码，以及在协调者会话中输入命令的人（omp） |
| 交换 | 工具 `playbook`，参数 `{doc, op, args}`，`doc` 为 Playbook 文件路径，`op` 与 `args` 同 K1，以下除外：`hello` 与 `ack` 由协调者扩展自己发送；`unlock` 的 `args` 为 `{run?, block}`，扩展填入当前 agent 操作中为该块最近一次记录的 `lock` 请求 id，没有记录时不发送；`post` 的 `args` 不含 `origin`，扩展发送时不带它。结果为 K1 的 `result` 或错误。环境变量 `PLAYBOOK_DOC`：协调者会话进程环境中的 Playbook 文件路径，由 K5 的启动命令设置，可以没有。命令 `/playbook-add [doc]`：扩展用 `registerCommand` 注册；参数为 Playbook 文件路径；省略时依次取扩展当前唯一连接的文档、有多个连接时让人选择、没有连接时取 `PLAYBOOK_DOC`；三者都没有时以 `ctx.ui.notify` 提示"请指定 Playbook 文件路径"并结束。扩展从 `ctx.sessionManager.getBranch()` 中取最近 20 条带文本的用户与助手消息，经 `ctx.ui.select` 让人选一条（选项以消息 id 开头），再经 `ctx.ui.select` 选 Run（来自 `runs`）、`kind`、块（可选"不关于块"），然后发送 `post {run, kind, text, block?, quote, origin: "human"}`，`text` 为该消息全部文本块的拼接，`quote` 为消息 id，最后以 `ctx.ui.notify` 提示条目序号或错误。事件消息：`customType: "playbook-event"`，正文按 [launch-events.md §6](launch-events.md#6-投递)。扩展对会话调用 `abort()`（D2.8），并订阅会话的 `agent_end` 事件 |
| 前置条件 | `doc` 指向的文档有一个正在运行的文档服务 |
| 保证 | 工具 `playbook`、命令与连接只存在于协调者的主会话中：扩展在 `session_start` 中、`ctx.agent.kind` 为 `main` 时才注册工具与命令并按 `PLAYBOOK_DOC` 连接；subagent 的会话同样加载扩展（D2.10），扩展在其中什么都不做，因此 subagent 看不到 `playbook` 工具，也不连接文档服务（R4）。工具可在 `eval` 中以 `tool.playbook(...)` 调用。协调者扩展在第一次使用某个 `doc` 时建立连接；会话加载扩展时环境中有 `PLAYBOOK_DOC`，扩展立即对它建立连接，这是对该文档的第一次使用。任何请求（包括命令中的 `runs` 与 `post`）发出时该文档没有连接，扩展先按第一次使用的规则建立连接，再发出请求。事件按 [launch-events.md §6](launch-events.md#6-投递) 注入。协调者扩展记录当前 agent 操作中成功的 `lock` 请求的 id、Run id 与块 id；收到 `interrupted` 时，它的 `request` 在记录中，扩展才调用 `abort()` 中止该操作（D2.8），否则不做任何事。收到 `agent_end` 时，扩展对记录中的每一项发送 `unlock {run, block, request}`，然后清空记录。因为 `unlock` 只解除由该请求取得的块锁，一个已结束操作的清理不会解除后来的操作取得的块锁 |
| 错误 | K1 的全部错误，加上 `NoService`（socket 不存在或拒绝连接），以及 `Disconnected`（请求已发出，连接在响应之前断开；修改操作是否已应用未知） |
| 失败语义 | 协调者会话结束（`session_shutdown`）：协调者扩展关闭全部连接，块锁随连接解除。连接在响应之前断开时，工具调用返回 `Disconnected`；不自动重试修改操作。请求发出前建立连接失败时返回 `NoService`，请求不发出。`/playbook-add` 中人在任一选择中取消（`ctx.ui.select` 返回 `undefined`）时，命令不发送 `post`；`runs` 或 `post` 返回错误、`NoService` 或 `Disconnected` 时，命令以 `ctx.ui.notify` 显示该错误并结束，不重试（[E2.9](appendix-evidence.md#e29-扩展命令读取会话消息)） |
| 生命周期 | 开始：会话加载扩展。结束：`session_shutdown` |
| 质量 | Q1、Q4 |
| 不承诺 | 不承诺把事件合并成一条消息；不承诺协调者会对事件采取动作 |

## K3 文档服务 → GitHub

| 项 | 内容 |
|---|---|
| 参与方 | 提供方：GitHub，经 `gh` CLI（外部）。使用方：文档服务的解析器（根节点设计） |
| 交换 | `gh api repos/<owner>/<repo>/issues/<n>` 输出一个对象，含 `title`、`body`；PR 编号同样适用，对象另含 `pull_request` 字段。`gh api --paginate --slurp repos/<owner>/<repo>/issues/<n>/comments` 输出页数组的数组，解析器把各页依次展平成一个评论列表；每个元素含 `user.login`、`created_at`、`body`，只含会话评论，不含 PR 的行内审查评论。解析器把 `user.login` 映射为 `author`，把为 `null` 的 `body` 当作空文本（[references.md §2](references.md#2-目标种类与解析器)） |
| 前置条件 | `gh` 已认证（D3.4） |
| 保证 | 只读。每个外部目标只在首次被引用或显式重新取回时取回（[references.md §5](references.md#5-文档取回表与预览)） |
| 错误 | `FetchFailed`：`gh` 非零退出或超时，附退出码与错误输出 |
| 失败语义 | 超时 30 s 后终止 `gh` 子进程。失败作为 `FetchFailed` 记入文档取回表（[references.md §5](references.md#5-文档取回表与预览)），不重试；它在预览中显示，返回给协调者的形式由 K1 规定 |
| 生命周期 | 每次取回一个子进程：开始于请求，结束于子进程退出 |
| 质量 | 无 |
| 不承诺 | 不承诺取回结果是 GitHub 的最新状态；不跟踪之后的变化（R7） |

## K4 文档服务 ⇄ Tern

| 项 | 内容 |
|---|---|
| 参与方 | 提供方：Tern（外部）。使用方：文档服务（根节点设计） |
| 交换 | TSP：`hello` 声明 `edit` 与 `undo` 特性；模板视图与 Run 视图之间以 `tabs` 切换；每个块一个 `card` 节点；字段的渲染视图为 `md` 与 `image` 节点，引用的展开为 `collapsible` 的 `section` 节点；编辑中的字段为 `input`（标题）或 `editor`（块正文）节点，属性 `text`、`cursor`、`anchor`；铅笔、完成、打断、新建、删除、启动、检查、预览、重新取回、开始 Run、结束 Run、写记录、推迟、启动协调者、转到协调者、关闭 Launch 与时间线中的 `launch_created` 条目为带 `actions.click` 的按钮；`done` 与选择为复选框；`b` 动词发送的 SVG blob；`edit`、`undo`、`focus`、`action`、`change`、`toggle`、`theme`、`ack`、`error` 事件与按键；`hello` 回复的 `dark` |
| 前置条件 | 文档服务运行在 Tern pane 中 |
| 保证 | 视图：文档服务提供一个模板视图与每个 Run 一个 Run 视图。两种视图的头部显示协调者的状态：有连接时显示它的会话 id，连接的 `hello` 带有 `pane` 时另显示"转到协调者"按钮；没有连接时显示"没有协调者连接"与启动协调者所需的命令，文档服务自己的 `TERN_PANE` 存在时另显示"启动协调者"按钮。两个按钮的行为归 K5。模板视图显示模板的块卡片、开始 Run 的表单（名称输入框、可选的状态更新间隔与"开始 Run"按钮）与全部 Run 的列表（[runs.md §5](runs.md#5-读取)）；点列表中的一项打开该 Run 视图。Run 视图显示 Run 的头部（[runs.md §5](runs.md#5-读取)，含"推迟"按钮与时长选择）、"结束 Run"按钮、该 Run 的块卡片、写记录的输入框与 `kind` 和块的选择（`kind` 为 `update` 时另有可选的下次更新时间），以及可按 `type` 筛选的时间线；时间线中带 `quote` 的记录显示它取自的会话与消息（[runs.md §7](runs.md#7-把会话中的消息加入时间线)）；点时间线中的 `launch_created` 条目打开该 Launch 的完整记录（[runs.md §5](runs.md#5-读取)）；已结束的 Run 视图中，修改块的控件与"推迟"不可用，写记录的控件仍可用，没有 `retrospective` 记录时写记录的 `kind` 默认为 `retrospective`（[runs.md §6](runs.md#6-状态更新提醒与复盘)）。块卡片：每个块一张卡片，显示块 id、选择复选框、块锁状态、`done` 复选框、标题与块正文的渲染视图、块正文中每个引用的展开（[references.md §5](references.md#5-文档取回表与预览)），以及操作按钮；在 Run 视图中，卡片还显示依赖该块的未关闭 Launch 的 id、它是否活跃（不活跃时附它的协调者会话 id）、它绑定的 agent id 与每个 Launch 的"关闭"按钮（[launch-events.md §1](launch-events.md#1-launch)、[§2](launch-events.md#2-活跃期)），以及关于该块的最近一条记录（[runs.md §4](runs.md#4-记录)）。因为协调者会话不再连接时，它的 Launch 只能由人关闭。编辑中字段的祖先节点不设置 `click` 动作，因为编辑字段内的点击会触发祖先的动作（D1.5）。铅笔：块锁为无并且人没有其他编辑草稿时，人点击一个字段的铅笔，文档服务把该块的块锁设为人持有，以该字段的已提交内容建立编辑草稿，把该字段换成 `input` 或 `editor` 并聚焦它；人已有编辑草稿时，其他铅笔不可用。块锁为协调者持有时，该块的铅笔、`done` 复选框与删除按钮不可用，卡片显示"协调者正在编辑"与打断按钮。编辑：编辑中的字段接受两种输入，因为 D1.4 说明原生编辑开启时两者都会到达；每个 `edit` 事件，以及每个插入或删除文本的按键与粘贴，改变编辑草稿；不改变文本的按键不改变编辑草稿；`undo` 事件撤销编辑草稿中最近一次改变。提交：Esc 或该字段的完成按钮提交编辑草稿；编辑草稿与已提交内容不同时，它作为一次来源为 `human` 的编辑应用；然后块锁解除，字段换回渲染视图。点击其他位置不提交（D1.5、约束）。打断：块锁为协调者持有时，人点击打断按钮，文档服务解除该块锁，重绘该块，并向协调者扩展发送 `interrupted`（K1）。勾选、新建与删除：块锁为无时，人勾选 `done`、新建块或删除块，各作为一次来源为 `human` 的编辑应用；新建块分配新块 id，标题与块正文为空。选择：选择复选框只改变界面状态，不改变文档；启动、检查与预览按钮作用于按文档顺序排列的已选中块，没有已选中块时作用于按钮所在卡片的块。启动按钮只在 Run 视图中出现；已选中块中同时有编排块与其他块时，启动按钮不可用，并显示"编排块只能单独启动"。渲染视图（S6）：块正文经 `splitTableCharts`（`always` 模式）切成 Markdown 段与图段；Markdown 段为 `md` 节点，图段为 `describeTableChart` 给出的 `image` 节点，其 blob 在引用它的帧之前以 `b` 发送。文档服务按 `hello` 回复的 `dark` 选择 omp 的亮色或暗色主题，收到 `theme` 事件时切换主题并重新生成图。引用的展开：每个引用一个 `section` 节点，`collapsible` 为真、`collapsed` 为假，`key` 为该引用在块正文中的序号与引用文本；文档服务重绘时始终发送相同的 `collapsed`，所以人折叠或展开的状态由 Tern 保持（E1.5），文档服务忽略 `toggle` 事件。外部引用的 `section` 标题旁有"重新取回"按钮。块检查的输入（[checks.md §2](checks.md#2-确定性检查)）：一个块的渲染节点 id 都以 `<块 id>.` 开头；文档服务记录每个帧序号 `s` 包含哪些块的节点；`ack` 的 `s` 覆盖不大于它的全部帧；带 `s` 与 `op` 的 `error` 事件对应到该帧该位置的操作所属的块；不带 `s` 的 `error` 事件（例如被拒绝的 blob）不能对应到块，文档服务在文档级显示它。编译预览、检查结果、启动操作与检查操作在卡片中以按钮与 `section` 节点提供 |
| 错误 | 输入针对过期的编辑草稿：`edit` 事件的 `len` 与编辑草稿的长度不同（TSP 文档所说的 keys in flight）；或者 `edit` 事件或改变文本的按键在该字段提交之后、人再次点击铅笔或聚焦一个字段之前到达，此时没有编辑草稿。文档服务丢弃它，并在该字段旁显示"一次输入因文本已变化未应用"，提示保留到人再次点击该字段的铅笔。不改变文本的按键（光标移动）不显示提示。`len` 规则来自 TSP 文档（[E1](appendix-evidence.md#e1-tern) D1.4） |
| 失败语义 | pane 关闭或 daemon 重启：文档服务进程结束，连接与全部块锁随之结束，未提交的编辑草稿丢失。已写回的文件是最后状态，最多丢失 1 s 内已提交的编辑（S2） |
| 生命周期 | 开始：pane 启动文档服务。结束：进程退出。人持有的块锁与编辑草稿：开始于人点击铅笔；结束于提交、该块被磁盘修改删除（S2）、所属 Run 结束（[runs.md §2](runs.md#2-生命周期)）或进程退出 |
| 质量 | Q4、Q5 |
| 不承诺 | 不承诺在不支持 TSP 的终端中可用；不承诺 Tern 未公开的行为。不承诺识别 `len` 与编辑草稿长度相同的过期 `edit` 事件，因为 `edit` 事件不携带帧序号（D1.4）。不承诺保存未提交的编辑草稿 |

## K5 文档服务、协调者扩展 → Tern CLI

| 项 | 内容 |
|---|---|
| 参与方 | 提供方：Tern 的 `tern` CLI 与 session daemon（外部）。使用方：文档服务与协调者扩展（根节点设计） |
| 交换 | 子进程。启动协调者：`tern split "$TERN_PANE" right --cwd <模板文件所在目录> --json -- env PLAYBOOK_DOC=<模板文件绝对路径> omp -e <协调者扩展入口文件绝对路径>`，输出 `{"block": <新 pane id>}`；`--` 之后的部分是启动协调者的命令，K4 头部显示的就是它；协调者扩展入口文件与文档服务属于同一安装。转到另一方：`tern focus <pane id> --json`，输出 `{"block": <pane id>}`。`TERN_PANE` 取自进程环境；对方的 pane id 取自 K1 `hello` 交换的 `pane`。协调者扩展注册命令 `/playbook-show [doc]`（`doc` 的选择规则同 K2 的 `/playbook-add`），对该文档服务的 pane 执行转到 |
| 前置条件 | 调用方的进程环境中有 `TERN_PANE`，即它运行在 session daemon 托管的 pane 中。没有时，文档服务不显示"启动协调者"，K1 `hello` 不带 `pane`（[E1.6](appendix-evidence.md#e16-pane-中的程序控制-pane)）。转到另一方还要求对方在 `hello` 中给出了 `pane` |
| 保证 | "启动协调者"在文档服务 pane 的右侧新建一个 pane，在模板文件所在目录中运行启动协调者的命令；新会话加载协调者扩展后立即按 `PLAYBOOK_DOC` 连接该文档并 `hello`（K2），头部随之改为显示协调者会话。文档服务不持有该 pane。"转到协调者"与 `/playbook-show` 让 Tern 窗口显示并聚焦对方的 pane。文档服务与协调者扩展在其他时候不改变焦点：发出启动请求、检查请求等事件后，焦点留在人操作的 pane 中 |
| 错误 | `tern` 不能运行（不在 `PATH` 中或不可执行）：附系统错误。`tern` 非零退出：附退出码与错误输出。对方没有给出 `pane`：`/playbook-show` 不调用 `tern`，报告"文档服务不在 session daemon 托管的 pane 中"。文档服务在头部显示错误；协调者扩展以 `ctx.ui.notify` 显示 |
| 失败语义 | 不重试。新 pane 已建立而协调者未能连接时，头部保持"没有协调者连接"；启动命令以非零退出时 pane 保留并显示它的输出与退出码（[E1.6](appendix-evidence.md#e16-pane-中的程序控制-pane)），人在其中看到失败原因。对方的 pane 已关闭时，`tern focus` 非零退出，按错误处理 |
| 生命周期 | 每次调用一个子进程：开始于人点击按钮或输入命令，结束于子进程退出（调用方确认）。新建的协调者 pane 由 Tern daemon 托管：开始于 `tern split` 返回，结束于其中的程序以退出码 0 退出或人关闭它（Tern daemon 确认）；文档服务进程结束不结束它 |
| 质量 | 无 |
| 不承诺 | 不承诺在没有 session daemon 的窗口中可用。不比较不同 API 给出的 pane id，因为 Tern 规定 id 只能原样传回给给出它的接口（E1.6） |
