# Run 与时间线

本文件拥有 Run 的规则：模板与 Run 的关系、Run 的生命周期、时间线的内容、记录，以及人与协调者读取 Run 的入口。术语定义见 [README.md §定义](README.md#定义)。Launch 的规则归 [launch-events.md](launch-events.md)；Run 视图的绘制归 [contracts.md §K4](contracts.md#k4-文档服务--tern)；Run 相关操作在 socket 上的形式归 [contracts.md §K1](contracts.md#k1-文档服务--协调者扩展)。输入：U1–U4、R13、R14、S9、S10。

## 1. 模板与 Run

- Playbook 文件是模板。Run 是从模板创建的一次实例。因为 U2 要求同一份 Playbook 能反复使用，每次使用不得覆盖上一次的内容；Mattermost Playbooks 以同样的方式在创建 run 时复制 playbook 的 checklist（[E4](appendix-evidence.md#e4-mattermost-playbooks)）。
- 创建 Run 时，文档服务复制模板当时的全部块：`id`、`title`、`body` 原样复制，`done` 置为假。此后 Run 的块与模板互不影响：修改模板不改变已有 Run，修改 Run 不改变模板。
- Run 的块与模板的块使用同样的字段、块锁、编辑草稿与提交规则（[contracts.md §K4](contracts.md#k4-文档服务--tern)）。Run 中新建块时，块 id 的数字等于"该 Run 中的最大数字"与"模板服务记录中的最大已分配数字"两者的较大值加 1。
- 块引用在所属的文档内解析：Run 中的 `((b2))` 指该 Run 的 b2，模板中的 `((b2))` 指模板的 b2。
- 模板中的块不能启动；`launch` 只接受 Run 中的块（[launch-events.md §1](launch-events.md#1-launch)）。模板中的块可以预览与检查。
- Run 文件：`<Playbook 文件名去掉 .yaml>.runs/<Run id>.yaml`，格式与模板相同（[README.md §S2](README.md#结构决定)），另加一个映射 `run: {id, name, status, started_at, finished_at}`。它的写回与外部修改规则同 S2。

## 2. 生命周期

- Run id 形如 `r<正整数>`，由文档服务分配，记入模板的服务记录文件，不复用。
- 状态取值：进行中、已结束。
- 开始：人在模板视图点"开始 Run"并填写名称，或协调者调用 `start_run {name}`。文档服务复制块（§1），写入 Run 文件，在时间线中追加 `run_started`。由人开始时，文档服务向协调者发送 `run_started` 事件，内容为 Run id 与名称。
- 结束：人在 Run 视图点"结束 Run"，或协调者调用 `finish_run {run}`。文档服务把状态设为已结束、记录结束时间，在时间线中追加 `run_finished`。由人结束时，文档服务向协调者发送 `run_finished` 事件。
- Run 结束时，它的全部 Launch 不再活跃（[launch-events.md §2](launch-events.md#2-活跃期)），它的块锁全部解除，之后它的块不得再被修改：人的铅笔、勾选与删除不可用，协调者的修改操作返回 `RunFinished`。因为 U2 的下一次使用从模板开始新的 Run，已结束的 Run 是不变的记录。
- 已结束的 Run 不能重新开始。需要继续时，从模板开始新的 Run。
- 人在进行中的 Run 里改变一个块的 `done` 时，文档服务向协调者发送 `done_changed` 事件，内容为 Run id、块 id 与新值。因为人工完成的一步可能是协调者等待的关卡；协调者自己的 `set` 不产生该事件（R6）。

## 3. 时间线

- 每个 Run 有一条时间线：一个只追加的条目序列，保存在 `<Playbook 文件名去掉 .yaml>.runs/<Run id>.jsonl`。时间线保存文档服务创建或接收的事实，人不编辑它，条目不删除。因为 U3 要求人回来后不翻阅协调者会话也能知道发生了什么。
- 条目字段：`seq`（Run 内递增）、`at`（时间）、`type`、`origin`（`human`、`coordinator`、`disk` 或 `service`）、`data`。
- `type` 是闭合列举：

  | `type` | `data` | 何时追加 |
  |---|---|---|
  | `run_started` | `{name}` | Run 开始 |
  | `run_finished` | `{}` | Run 结束 |
  | `block_edited` | `{block, field, edit}` | 一次编辑改变了块的 `title` 或 `body`；`edit` 为编辑序号（[launch-events.md §3](launch-events.md#3-块变化判定)） |
  | `block_added` | `{block}` | 新增块 |
  | `block_deleted` | `{block}` | 删除块 |
  | `done_changed` | `{block, done}` | 块的 `done` 改变 |
  | `launch_created` | `{launch, kind, blocks}` | 创建 Launch |
  | `agent_bound` | `{launch, agent}` | `bind` |
  | `launch_closed` | `{launch}` | `close` |
  | `event_sent` | `{event, data}` | 文档服务向协调者发送一个事件；`data` 为事件的完整内容（[launch-events.md §6](launch-events.md#6-投递)） |
  | `interrupted` | `{block, request}` | 人打断协调者持有的块锁 |
  | `check_reported` | `{blocks, result}` | 文档服务接受一次 `report`（[checks.md §5](checks.md#5-结果显示)） |
  | `post` | `{kind, text, block?}` | 一条记录（§4） |

## 4. 记录

- 记录是人或协调者写入时间线的一段文本，用来报告进度、结果或失败。人在 Run 视图中写，协调者调用 `post {run, kind, text, block?}`。`kind` 取 `update`、`result`、`failure` 之一；`block` 指明记录关于哪个块。
- 记录是写入者陈述的内容，不是 agent 状态的副本：文档服务只记录"谁在何时写了什么"，不判断它是否属实（I4）。
- 带 `block` 的最近一条记录显示在该块的卡片上。
- 块结果引用：块正文中的 `((b<n>.result))` 展开为同一 Run 中关于该块、`kind` 为 `result` 的最近一条记录的文本（[references.md §2](references.md#2-目标种类与解析器)）。因为 U1 中评审需要明确地读取实现的结果，并在预览中看见它读取的是哪一条。

## 5. 读取

- 人：模板视图列出全部 Run，显示名称、状态、开始与结束时间、`done` 为真的块数与块总数。Run 视图显示该 Run 的块、头部与时间线；时间线可以按 `type` 筛选（[contracts.md §K4](contracts.md#k4-文档服务--tern)）。
- 协调者：`runs` 返回全部 Run 的上述摘要；`timeline {run, after?}` 返回序号大于 `after` 的全部条目。因为协调者在 `eval` 中等待 subagent 时，`aside` 消息要到 `eval` 结束后才进入模型（[E2.3](appendix-evidence.md#e23-aside-投递)），编排代码可以在 `eval` 中读取时间线，得知运行中发生的块修改与人的操作。
- Run 视图的头部显示：名称、状态、`done` 为真的块数与块总数、最近一条 `update` 记录的时间，以及当前连接的协调者会话 id 或"没有协调者连接"。
