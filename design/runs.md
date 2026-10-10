# Run 与时间线

本文件拥有 Run 的规则：模板与 Run 的关系、Run 的生命周期、时间线的内容、记录、人与协调者读取 Run 的入口，以及状态更新提醒与复盘。术语定义见 [README.md §定义](README.md#定义)。Launch 的规则归 [launch-events.md](launch-events.md)；Run 视图的绘制归 [contracts.md §K4](contracts.md#k4-文档服务--tern)；Run 相关操作在 socket 上的形式归 [contracts.md §K1](contracts.md#k1-文档服务--协调者扩展)。输入：U1–U4、R13、R14、R15、S9、S10、S11。

## 1. 模板与 Run

- Playbook 文件是模板。Run 是从模板创建的一次实例。因为 U2 要求同一份 Playbook 能反复使用，每次使用不得覆盖上一次的内容；Mattermost Playbooks 以同样的方式在创建 run 时复制 playbook 的 checklist（[E4](appendix-evidence.md#e4-mattermost-playbooks)）。
- 创建 Run 时，文档服务复制模板当时的全部块：`id`、`title`、`body` 原样复制，`done` 置为假。此后 Run 的块与模板互不影响：修改模板不改变已有 Run，修改 Run 不改变模板。
- Run 的块与模板的块使用同样的字段、块锁、编辑草稿与提交规则（[contracts.md §K4](contracts.md#k4-文档服务--tern)）。Run 中新建块时，块 id 按 [README.md §定义](README.md#定义) 分配，其中"文档"指该 Run，"服务记录"指模板的服务记录文件，因此同一份 Playbook 的模板与全部 Run 不会分配出相同的新 id。
- 块引用在所属的文档内解析：Run 中的 `((b2))` 指该 Run 的 b2，模板中的 `((b2))` 指模板的 b2。
- 模板中的块可以预览与检查，不能启动；启动的条件归 [launch-events.md §1](launch-events.md#1-launch)。
- Run 文件：`<Playbook 文件名去掉 .yaml>.runs/<Run id>.yaml`，格式与模板相同（[README.md §S2](README.md#结构决定)），另加一个映射 `run: {id, name, status, started_at, finished_at, update_every, update_due}`；后两项的规则见 §6。它的写回与外部修改规则同 S2。

## 2. 生命周期

- Run id 形如 `r<正整数>`，由文档服务分配，记入模板的服务记录文件，不复用。
- 状态取值：进行中、已结束。
- 开始：人在模板视图点"开始 Run"并填写名称与可选的状态更新间隔，或协调者调用 `start_run {name, update_every?}`。文档服务复制块（§1），写入 Run 文件，在时间线中追加 `run_started`。由人开始时，文档服务向协调者发送 `run_started` 事件，内容为 Run id 与名称。
- 结束：人在 Run 视图点"结束 Run"，或协调者调用 `finish_run {run}`。文档服务把状态设为已结束、记录结束时间，在时间线中追加 `run_finished`。由人结束时，文档服务向协调者发送 `run_finished` 事件。
- Run 结束时，文档服务对它全部未关闭的 Launch 记录 `closed`，解除它的全部块锁，丢弃人在其中的编辑草稿并显示"Run 已结束，未提交的修改已丢弃"，并把 `update_due` 置空（§6）。之后它的块不得再被修改：人的铅笔、勾选与删除不可用，协调者的修改操作与 `launch` 返回 `RunFinished`。因为 U2 的下一次使用从模板开始新的 Run，已结束的 Run 的块是不变的记录。
- 已结束的 Run 仍可写记录（§4），因为结束时仍在运行的 subagent 可能晚些给出结果，这些结果应留在这个 Run 的时间线中。
- 已结束的 Run 不能重新开始。需要继续时，从模板开始新的 Run。
- 人在进行中的 Run 里改变一个块的 `done` 时，文档服务向协调者发送 `done_changed` 事件，内容为 Run id、块 id 与新值。因为人工完成的一步可能是协调者等待的关卡；协调者自己的 `set` 不产生该事件（R6）。

## 3. 时间线

- 每个 Run 有一条时间线：一个只追加的条目序列，保存在 `<Playbook 文件名去掉 .yaml>.runs/<Run id>.jsonl`。时间线保存文档服务创建或接收的事实，人不编辑它，条目不删除。因为 U3 要求人回来后不翻阅协调者会话也能知道发生了什么。
- 该文件每行是 `{"entry": 条目}` 或 `{"launch": Launch 完整记录}` 之一。Launch 每次改变（创建、绑定、`dirty`、`notified`、取回结果、基线、关闭）时，文档服务追加一行 `launch`，内容为改变后的完整记录；一个 Launch 的当前状态是它最后一行 `launch`。`timeline` 只返回 `entry` 行；Launch 记录的规则归 [launch-events.md §1](launch-events.md#1-launch)。
- 条目字段：`seq`（Run 内递增）、`at`（时间）、`type`、`origin`（`human`、`coordinator`、`disk` 或 `service`）、`data`。条目属于所在文件的 Run，`data` 不重复 Run id；`event_sent` 的 `data` 是事件的完整内容，保留事件自带的 Run id。
- `type` 是闭合列举：

  | `type` | `data` | 何时追加 |
  |---|---|---|
  | `run_started` | `{name}` | Run 开始 |
  | `run_finished` | `{}` | Run 结束 |
  | `block_edited` | `{block, field, text, edit}` | 一次编辑改变了块的 `title` 或 `body`；`text` 为编辑后的字段全文，`edit` 为编辑序号（[launch-events.md §3](launch-events.md#3-块变化判定)） |
  | `block_added` | `{block, title, body}` | 新增块 |
  | `block_deleted` | `{block, title, body}` | 删除块；`title` 与 `body` 为删除前的内容 |
  | `blocks_reordered` | `{order}` | 磁盘修改改变了块的顺序；`order` 为改变后的块 id 列表 |
  | `done_changed` | `{block, done}` | 块的 `done` 改变 |
  | `launch_created` | `{launch, kind, blocks}` | 创建 Launch |
  | `agent_bound` | `{launch, agent}` | `bind` |
  | `launch_closed` | `{launch}` | 协调者 `close`（`origin` 为 `coordinator`），人点"关闭"（`human`），或 Run 结束时文档服务关闭它（`service`） |
  | `event_sent` | `{event, data}` | 文档服务向协调者发送一个事件；`data` 为事件的完整内容（[launch-events.md §6](launch-events.md#6-投递)） |
  | `interrupted` | `{block, request}` | 人打断协调者持有的块锁 |
  | `check_reported` | `{blocks, version, result}` | 文档服务接受一次 `report`；`version` 为该报告对应的检查版本（[checks.md §5](checks.md#5-结果显示)） |
  | `post` | `{kind, text, block?, launch?, quote?, session?}` | 一条记录（§4）；经 K1 写入时 `session` 为当时连接的协调者会话 id |
  | `update_due` | `{due}` | 状态更新到期（§6） |
  | `update_snoozed` | `{due}` | 推迟状态更新；`due` 为新的到期时间（§6） |

## 4. 记录

- 记录是人或协调者写入时间线的一段文本，用来报告进度、结果、失败或复盘。人在 Run 视图中写，可以选择记录关于哪个块；协调者调用 `post`（[contracts.md §K1](contracts.md#k1-文档服务--协调者扩展)）。记录的 `kind` 取 `update`、`result`、`failure`、`retrospective` 之一；`block` 指明记录关于哪个块；`launch` 指明记录来自哪个 Launch 下的工作，并显示在记录旁；`quote` 指明记录的文本取自协调者会话中的哪条消息（§7）。
- `update` 记录是状态更新，它改变 `update_due`（§6）。`retrospective` 记录是复盘，只能写在已结束的 Run 中，因为复盘对照的是整个 Run 的时间线；进行中的 Run 收到它时返回 `BadValue`。
- 记录是写入者陈述的内容，不是 agent 状态的副本：文档服务只记录"谁在何时写了什么"，不判断它是否属实（I4）。
- 带 `block` 的最近一条记录显示在该块的卡片上。
- 块结果引用 `((b<n>.result))` 读取同一 Run 中关于该块的 `result` 记录，解析规则归 [references.md §2](references.md#2-目标种类与解析器)。因为 U1 中评审需要明确地读取实现的结果，并在预览中看见它读取的是哪一条：预览的来源清单列出这条记录的序号、写入者与 `launch`（[references.md §4](references.md#4-编译)）。

## 5. 读取

- 人：模板视图列出全部 Run，显示名称、状态、开始与结束时间、`done` 为真的块数与块总数、`update_due` 以及它是否已过，已结束的 Run 另显示是否有 `retrospective` 记录。Run 视图显示该 Run 的块、头部与时间线；时间线可以按 `type` 筛选（[contracts.md §K4](contracts.md#k4-文档服务--tern)）。因为 Mattermost 的待办汇总列出超期的状态更新、未完成的任务与进行中的 run（[E4](appendix-evidence.md#e4-mattermost-playbooks)），这份列表就是本设计中的待办汇总，不另设汇总消息。
- 协调者：`runs` 返回全部 Run 的上述摘要；`timeline {run, after?}` 返回序号大于 `after` 的全部条目；`launch_info {launch}` 返回一个 Launch 的完整记录，包括快照、取回结果、块结果、基线与绑定的 agent。因为协调者在 `eval` 中等待 subagent 时，`aside` 消息要到 `eval` 结束后才进入模型（[E2.3](appendix-evidence.md#e23-aside-投递)），编排代码可以在 `eval` 中读取时间线，得知运行中发生的块修改与人的操作。
- 人：在 Run 视图的时间线中点一条 `launch_created` 条目，打开该 Launch 的完整记录，内容与 `launch_info` 相同。
- Run 视图的头部显示：名称、状态、`done` 为真的块数与块总数、最近一条 `update` 记录的时间、`update_due` 与"推迟"按钮（`update_due` 为空时不显示；已过时标为"状态更新已到期"），以及当前连接的协调者会话 id 或"没有协调者连接"。

## 6. 状态更新提醒与复盘

Mattermost Playbooks 的 bot 按定时器催状态更新，人可以推迟；run 结束后 bot 请人写复盘（[E4](appendix-evidence.md#e4-mattermost-playbooks)）。本设计中 bot 是 agent，因此到期由文档服务判定并通知协调者，写更新与写复盘由人或协调者完成。

- `update_every` 是 Run 的默认状态更新间隔，单位为秒，或空。它在开始 Run 时给出，之后不改变。空表示没有默认间隔：开始 Run 时不安排提醒，不带 `next` 的 `update` 记录不改变 `update_due`；带 `next` 的 `update` 记录仍安排下一次提醒。
- `update_due` 是下一次状态更新的到期时间，或空。开始 Run 时，`update_every` 非空则 `update_due` 设为开始时间加 `update_every`，否则为空。
- 在进行中的 Run 写入 `update` 记录时，`update_due` 设为写入时间加 `next`；`next` 是该记录给出的秒数，没有给出时取 `update_every`；两者都为空时 `update_due` 不变。这与 Mattermost 中每次状态更新设定下一次提醒的做法相同（[E4](appendix-evidence.md#e4-mattermost-playbooks)）。在已结束的 Run 写入的 `update` 记录不改变 `update_due`，因为已结束的 Run 不再有提醒。
- 推迟：人在进行中的 Run 视图头部点"推迟"并选择时长，或协调者调用 `snooze {run, after}`。`update_due` 设为当前时间加该时长，时间线追加 `update_snoozed`。`update_due` 为空时（包括 Run 已结束）推迟不可用，`snooze` 返回 `BadValue`。
- 到期：进行中的 Run 的 `update_due` 到达时，文档服务在时间线中追加 `update_due`，并向当前连接发出 `update_due` 事件，内容为 Run id、`update_due` 与最近一条 `update` 记录的时间。每个 `update_due` 值只到期一次：之后 `update_due` 保持原值，Run 视图头部显示"状态更新已到期"，直到下一条 `update` 记录或推迟。文档服务启动时，进行中的 Run 的 `update_due` 已过、而时间线中没有 `data.due` 等于它的 `update_due` 条目时，立即按到期处理，因为文档服务不运行期间没有判定到期。没有连接时不保存事件，因为模板视图列表与 Run 视图头部已显示到期；协调者连接后从 `runs` 读到它。
- Run 结束时 `update_due` 置空（§2），不再产生到期。
- `run` 映射的每次改变（开始、结束、`update_due` 改变）立即写回 Run 文件，写回完成后才追加对应的时间线条目。因此时间线中记下的开始、结束、推迟与到期，在 Run 文件中都已生效；进程在两次写入之间结束时，只丢失这一条时间线条目。Run 文件的 `run` 映射是 Run 状态的唯一来源，时间线只是事实记录（S10）。
- 复盘：已结束、没有 `retrospective` 记录的 Run 在模板视图列表中标为"未复盘"，Run 视图中显示写复盘的输入框。人在该输入框中写复盘；协调者以 `post {kind: "retrospective"}` 写复盘，它从 `run_finished` 事件或 `runs` 的摘要得知哪个 Run 未复盘。文档服务不定时催复盘，因为未复盘的标记一直显示在列表中，协调者也能随时读到。
- 欢迎消息不单独设计：人开始 Run 时协调者已收到 `run_started` 事件（§2），在会话中说什么由协调者决定。

## 7. 把会话中的消息加入时间线

Mattermost 中人可以在频道的任意消息上选"Add to run timeline"，把它加入 run 的时间线（[E4](appendix-evidence.md#e4-mattermost-playbooks)）。本设计中频道是协调者会话，消息由 agent 写出，因此这个入口在协调者会话中。

- 人的入口：在协调者会话中输入命令 `/playbook-add`。协调者扩展列出会话当前分支上最近的、带文本的用户消息与助手消息，每项显示消息 id 与文本开头；人选一条，再选目标 Run（进行中的 Run，以及已结束的 Run）、`kind` 与可选的块；扩展以 `post` 写入，`text` 为该消息的全部文本，`quote` 为该消息的 id，`origin` 为 `human`；写入后扩展在会话中提示写入的条目序号，失败时提示错误。命令的形式归 [contracts.md §K2](contracts.md#k2-协调者扩展--协调者会话)。因为人看到值得留下的消息时正在看协调者 pane，不需要切到 Playbook pane 再把文本复制过去。
- 经该命令写入的条目 `origin` 为 `human`，因为选择与写入是人的操作；协调者经 `playbook` 工具写入的条目 `origin` 为 `coordinator`。
- agent 的入口：协调者调用 `post`，可以带 `quote` 指明文本取自哪条消息。
- `quote` 是写入者的陈述，与记录的其余内容一样，文档服务不核对它（§4）。时间线中的 `post` 条目同时记录写入时连接的协调者会话 id，因此 `quote` 加会话 id 指向一条确定的会话消息。
- 记录在 Run 视图的时间线中显示"取自会话 <会话 id> 的消息 <消息 id>"。协调者会话的权威来源是 omp，时间线只保存写入时的文本，不随会话变化（I4）。
