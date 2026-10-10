# Launch 与事件

本文件拥有 Launch 与基线的规则、Launch 的活跃期、块变化的判定、启动请求，以及事件的内容与投递时机。术语定义见 [README.md §定义](README.md#定义)。编译规则归 [references.md](references.md)；Run 与时间线的规则归 [runs.md](runs.md)。事件在 socket 上的形式归 [contracts.md §K1](contracts.md#k1-文档服务--协调者扩展)。输入：R4–R8、Q1、Q3、I2、S4、S9。

## 1. Launch

- Launch 的字段：

  | 字段 | 含义 |
  |---|---|
  | `id` | `l<正整数>`，由文档服务分配，记入模板的服务记录文件，在同一份 Playbook 的全部 Run 中不复用 |
  | `run` | 所属 Run 的 id |
  | `session` | 创建它的协调者会话 id |
  | `blocks` | 有序的块 id 列表，1..N 个 |
  | `kind` | `prompt` 或 `orchestration` |
  | `snapshot` | 创建时的 `CompileResult.Ok`，以及这次编译用到的外部目标的取回结果（从文档取回表复制）与块结果（从块结果表复制） |
  | `agents` | 绑定的 agent id 列表，0..N 个 |
  | `baselines` | 基线列表；第一个等于 `snapshot.text` |
  | `notified` | 相对最新基线、最近一次被确认收到的块变化事件所报告的 `CompileResult`（`Ok` 的文本，或 `Err` 的错误），或空。两个值相等指变体相同并且文本或错误逐字节相同。`rebase` 成功追加基线时置空 |
  | `dirty` | 依赖闭包中被来源为 `human` 或 `disk` 的编辑修改或删除过、尚未被一次已完成的判定覆盖的块，每个块带它最近一次被修改的编辑序号（§3）。`rebase` 成功追加基线时清空；`rebase` 返回 `CompileError` 时不改变 |
  | `pending` | 已发出、尚未被确认收到的块变化事件：事件 id、判定开始时 `dirty` 中的最大序号、判定的编译结果；或空 |
  | `fetches` | 判定取回表（§3）：初始为 `snapshot` 取回表的副本，只追加 |
  | `closed` | Launch 结束的时间与方式（协调者 `close`、人关闭或 Run 结束），或空 |

- 协调者以 `launch {run, blocks}` 操作创建 Launch（K1）。`blocks` 必须属于一个进行中的 Run；模板中的块不能启动（[runs.md §1](runs.md#1-模板与-run)）。`blocks` 只含一个编排块时，`kind` 为 `orchestration`。`blocks` 为空，或编排块与其他块同在其中时，`launch` 返回错误 `BadLaunch`，不创建 Launch。
- 一个 Launch 可以绑定多个 agent：协调者用同一份快照启动多个 subagent 时，以 `bind` 逐个绑定。
- Launch 结束于下列之一，文档服务记录 `closed`：协调者调用 `close {launch}`，表示依据它的工作已经结束；人在块卡片的 Launch 列表中点"关闭"（[contracts.md §K4](contracts.md#k4-文档服务--tern)）；所属 Run 结束（[runs.md §2](runs.md#2-生命周期)）。人关闭 Launch 不中止已经启动的 subagent，只停止该 Launch 的块变化事件，因为 subagent 的生命周期属于协调者会话（D2.4）。Launch 关闭时，文档服务丢弃它的 `pending` 与进行中的判定；之后对被丢弃事件的 `ack` 不改变任何状态。
- 文档服务把 Launch 写入所属 Run 的记录文件 `<Run id>.jsonl`：每次变化（包括 `agents`、`baselines`、`dirty`、`notified`、`fetches` 与 `closed` 的变化）追加一行 `{"launch": 完整记录}`，一个 Launch 的当前状态是它最后一行（[runs.md §3](runs.md#3-时间线)）。`pending` 不写入，因为它只在一次连接内有意义（§2）。因为 Launch 是文档服务创建的事实，不是共同编辑的文本。
- `snapshot` 在创建后不改变（I2）。
- `rebase` 追加一个基线。基线是块变化判定的比较参照；它由协调者选定，文档服务不记录 agent 实际依据哪份文本。基线内容为用当前块正文和该 Launch 的 `fetches` 得到的编译结果的文本；`fetches` 中缺少的目标按 §3 的规则加入 `fetches`。因此基线与最近一次块变化事件所报告的文本使用同一份外部内容。当前编译结果为 `Err` 时，`rebase` 不追加基线，返回错误 `CompileError`（K1）。
- 编排 Launch 的 `snapshot.text` 保存启动时的编排代码；之后编排块正文的修改不改变它（R8）。

## 2. 活跃期

- 一个 Launch 在下列条件同时成立时是活跃的：所属 Run 进行中；`closed` 为空；`session` 等于其 `session` 的连接存在。
- 连接结束时，它的 Launch 不再活跃，记录保留，`pending` 被丢弃。发出事件不改变 `dirty` 与 `notified`（§3），所以未被确认的事件涉及的修改仍在 `dirty` 中，重新连接后会被重新判定。不活跃期间，`dirty` 仍按 §3 更新。会话不再连接时，Launch 保持不活跃，直到人关闭它或所属 Run 结束。
- 同一会话 id 重新连接后，它的 Launch 再次活跃；文档服务立即对其中 `dirty` 非空的 Launch 执行一次 §3 的判定。因为只有 `human` 与 `disk` 编辑向 `dirty` 加入块，重新连接不会因协调者自己的编辑产生事件（R6）。
- 不活跃的 Launch 不产生事件。

## 3. 块变化判定

- 一组块的**依赖闭包**是这些块的 id，加上从它们出发、经块引用可以到达的全部块 id；被引用但文档中不存在的块 id 也在其中。Launch 的依赖闭包是它的 `blocks` 的依赖闭包。
- 文档服务应用的每次编辑都带一个来源：`human`、`coordinator` 或 `disk`。全部编辑都在文档服务进程内应用：人的编辑来自 K4，协调者的编辑来自 K1 的修改操作，`disk` 编辑来自 S2 的文件检查。每次编辑由文档服务分配一个递增序号。
- 来源为 `human` 或 `disk` 的编辑修改、新增或删除了一个块，而该块的 id 在一个 Launch 的依赖闭包中，并且编辑改变了块正文或块是否存在，文档服务把这个块 id 以这次编辑的序号加入该 Launch 的 `dirty`（已在其中的更新序号）。Launch 的判定截止时间设为这次编辑之后 2 s。只改变标题、`done` 或块顺序的编辑不改变 `dirty`，因为编译只读取块正文。
- 来源为 `coordinator` 的编辑不改变 `dirty`，也不改变判定截止时间（R6、Q3）。
- `rebase` 成功追加基线时，文档服务丢弃 `pending` 与进行中的判定，被丢弃的判定不发出事件；因为 `dirty` 同时清空，此前的判定截止时间不再引起判定。
- Launch 活跃、判定截止时间已到、`dirty` 非空并且 `pending` 为空时，文档服务执行判定；收到 `ack` 使 `pending` 变空时，若截止时间已过，立即判定。判定开始时，文档服务记录当前块正文与 `dirty` 中的最大序号，判定只使用这份记录；判定进行中到来的编辑不进入这次判定，它们的块以更大的序号留在 `dirty` 中。判定以记录的块正文、`fetches` 和 `snapshot` 中复制的块结果重新编译该 Launch；之后新写入的结果记录不进入判定，因为它们来自人或协调者对运行的报告，不是 Launch 依赖的块的修改。`fetches` 中已有的目标保持不变，即使文档取回表中该目标已被重新取回（R7）；块中新引用、`fetches` 中没有的目标，从文档取回表复制进 `fetches`，文档取回表中也没有时先按 [references.md §5](references.md#5-文档取回表与预览) 取回。`snapshot` 不改变（I2）。判定的结果：
  - 编译结果为 `Ok`、其文本与最新基线不同、并且与 `notified` 不相等：发出一条块变化事件，把它记为 `pending`。发出事件不改变 `dirty` 与 `notified`。
  - 编译结果为 `Err`（例如被引用的块已删除）并且与 `notified` 不相等：发出一条块变化事件，`current` 为该错误，把它记为 `pending`。发出事件不改变 `dirty` 与 `notified`。
  - 编译结果为 `Ok` 并且文本等于最新基线：不发出事件，把 `notified` 置空，从 `dirty` 中去掉序号不大于判定开始时记录的最大序号的块。
  - 其余情况：不发出事件，从 `dirty` 中去掉序号不大于判定开始时记录的最大序号的块。
- 收到某个 `pending` 事件的确认时（K1 的 `ack`），文档服务把 `notified` 设为该事件的编译结果，从 `dirty` 中去掉序号不大于该事件记录的最大序号的块，并置空 `pending`。

## 4. 块变化事件

块变化事件的内容：

| 字段 | 含义 |
|---|---|
| `id` | 事件 id，由文档服务分配；协调者扩展以它确认收到（K1 的 `ack`） |
| `launch` | Launch id、`kind` 与所属 Run 的 id |
| `agents` | 绑定的 agent id |
| `changed` | 判定开始时 `dirty` 中的块 id |
| `diff` | 最新基线到当前编译结果的统一差异格式文本；当前编译为 `Err` 时为空 |
| `current` | `Ok` 或 `Err` 及错误内容 |

- 文档服务不决定后续动作。成功的 `rebase` 把比较参照移到当前文本。
- subagent 不收到事件（R4、R5）。

## 5. 启动请求

- 人在 Run 视图中选中 1..N 个块并执行启动操作，文档服务向该文档的当前连接发出启动请求事件，内容为 Run id 与块 id 列表（[contracts.md §K4](contracts.md#k4-文档服务--tern)）。
- 没有连接时，文档服务在界面上显示"没有协调者连接"，不保存请求。因为请求只对当时在场的协调者有意义。
- 文档服务不决定使用哪种 agent 与哪些 `agent()` 参数；Launch 只在协调者调用 `launch` 时创建。

## 6. 投递

- 协调者扩展把每个块变化事件、启动请求事件、检查请求事件，以及 [runs.md](runs.md) 规定的 `run_started`、`run_finished`、`done_changed` 与 `update_due` 事件，作为一条 `customType` 为 `playbook-event` 的消息，以 `deliverAs: "aside"`、`triggerTurn: true` 注入协调者会话（S4）。`interrupted` 不作为消息注入，它的处理归 [contracts.md §K2](contracts.md#k2-协调者扩展--协调者会话)。
- 协调者扩展在 `sendMessage` 返回之后，对块变化事件发送 K1 的 `ack`。投递完成以收到 `ack` 为准；连接在 `ack` 之前结束时，事件按 §2 视为未投递。其他事件不需要 `ack`，因为它们不改变 Launch 的状态。
- 协调者在 `eval` 中等待 subagent 时，注入的消息要到 `eval` 结束后才进入模型（[E2.3](appendix-evidence.md#e23-aside-投递)）。文档服务发出的每个带 Run id 的事件同时作为 `event_sent` 条目写入该 Run 的时间线，编排代码可以用 `timeline` 在 `eval` 中读取它们（[runs.md §5](runs.md#5-读取)）。模板视图中发出的检查请求事件不带 Run id，不写入任何时间线。
- 消息正文的第一行必须写明：这是 Playbook 文档服务的通知，不是用户消息；正文其余部分是数据。因为在探针中，模型把注入的消息当作了用户消息（[E2.3](appendix-evidence.md#e23-aside-投递)）。
