# Run 与时间线

本文件拥有 Run 的规则：模板与 Run 的关系、Run 的生命周期、时间线的内容、记录，以及人与协调者读取 Run 的入口。术语定义见 [README.md §定义](README.md#定义)。Launch 的规则归 [launch-events.md](launch-events.md)；Run 视图的绘制归 [contracts.md §K4](contracts.md#k4-文档服务--tern)；Run 相关操作在 socket 上的形式归 [contracts.md §K1](contracts.md#k1-文档服务--协调者扩展)。输入：U1–U4、R13、R14、S9、S10。

## 1. 模板与 Run

- Playbook 文件是模板。Run 是从模板创建的一次实例。因为 U2 要求同一份 Playbook 能反复使用，每次使用不得覆盖上一次的内容；Mattermost Playbooks 以同样的方式在创建 run 时复制 playbook 的 checklist（[E4](appendix-evidence.md#e4-mattermost-playbooks)）。
- 创建 Run 时，文档服务复制模板当时的全部块：`id`、`title`、`body` 原样复制，`done` 置为假。此后 Run 的块与模板互不影响：修改模板不改变已有 Run，修改 Run 不改变模板。
- Run 的块与模板的块使用同样的字段、块锁、编辑草稿与提交规则（[contracts.md §K4](contracts.md#k4-文档服务--tern)）。Run 中新建块时，块 id 按 [README.md §定义](README.md#定义) 分配，其中"文档"指该 Run，"服务记录"指模板的服务记录文件，因此同一份 Playbook 的模板与全部 Run 不会分配出相同的新 id。
- 块引用在所属的文档内解析：Run 中的 `((b2))` 指该 Run 的 b2，模板中的 `((b2))` 指模板的 b2。
- 模板中的块可以预览与检查，不能启动；启动的条件归 [launch-events.md §1](launch-events.md#1-launch)。
- Run 文件：`<Playbook 文件名去掉 .yaml>.runs/<Run id>.yaml`，格式与模板相同（[README.md §S2](README.md#结构决定)），另加一个映射 `run: {id, name, status, started_at, finished_at}`。它的写回与外部修改规则同 S2。

## 2. 生命周期

- Run id 形如 `r<正整数>`，由文档服务分配，记入模板的服务记录文件，不复用。
- 状态取值：进行中、已结束。
- 开始：人在模板视图点"开始 Run"并填写名称，或协调者调用 `start_run {name}`。文档服务复制块（§1），写入 Run 文件，在时间线中追加 `run_started`。由人开始时，文档服务向协调者发送 `run_started` 事件，内容为 Run id 与名称。
- 结束：人在 Run 视图点"结束 Run"，或协调者调用 `finish_run {run}`。文档服务把状态设为已结束、记录结束时间，在时间线中追加 `run_finished`。由人结束时，文档服务向协调者发送 `run_finished` 事件。
- Run 结束时，文档服务对它全部未关闭的 Launch 记录 `closed`，解除它的全部块锁，丢弃人在其中的编辑草稿并显示"Run 已结束，未提交的修改已丢弃"。之后它的块不得再被修改：人的铅笔、勾选与删除不可用，协调者的修改操作与 `launch` 返回 `RunFinished`。因为 U2 的下一次使用从模板开始新的 Run，已结束的 Run 的块是不变的记录。
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
  | `post` | `{kind, text, block?, launch?}` | 一条记录（§4） |

## 4. 记录

- 记录是人或协调者写入时间线的一段文本，用来报告进度、结果或失败。人在 Run 视图中写，可以选择记录关于哪个块；协调者调用 `post`（[contracts.md §K1](contracts.md#k1-文档服务--协调者扩展)）。记录的 `kind` 取 `update`、`result`、`failure` 之一；`block` 指明记录关于哪个块；`launch` 指明记录来自哪个 Launch 下的工作，并显示在记录旁。
- 记录是写入者陈述的内容，不是 agent 状态的副本：文档服务只记录"谁在何时写了什么"，不判断它是否属实（I4）。
- 带 `block` 的最近一条记录显示在该块的卡片上。
- 块结果引用 `((b<n>.result))` 读取同一 Run 中关于该块的 `result` 记录，解析规则归 [references.md §2](references.md#2-目标种类与解析器)。因为 U1 中评审需要明确地读取实现的结果，并在预览中看见它读取的是哪一条：预览的来源清单列出这条记录的序号、写入者与 `launch`（[references.md §4](references.md#4-编译)）。

## 5. 读取

- 人：模板视图列出全部 Run，显示名称、状态、开始与结束时间、`done` 为真的块数与块总数。Run 视图显示该 Run 的块、头部与时间线；时间线可以按 `type` 筛选（[contracts.md §K4](contracts.md#k4-文档服务--tern)）。
- 协调者：`runs` 返回全部 Run 的上述摘要；`timeline {run, after?}` 返回序号大于 `after` 的全部条目；`launch_info {launch}` 返回一个 Launch 的完整记录，包括快照、取回结果、块结果、基线与绑定的 agent。因为协调者在 `eval` 中等待 subagent 时，`aside` 消息要到 `eval` 结束后才进入模型（[E2.3](appendix-evidence.md#e23-aside-投递)），编排代码可以在 `eval` 中读取时间线，得知运行中发生的块修改与人的操作。
- 人：在 Run 视图的时间线中点一条 `launch_created` 条目，打开该 Launch 的完整记录，内容与 `launch_info` 相同。
- Run 视图的头部显示：名称、状态、`done` 为真的块数与块总数、最近一条 `update` 记录的时间，以及当前连接的协调者会话 id 或"没有协调者连接"。
