# 块检查

本文件拥有块检查的规则：检查状态的内容、确定性检查、jev 判定的问题与阈值、检查的触发，以及结果的显示。术语定义见 [README.md §定义](README.md#定义)。编译与取回规则归 [references.md](references.md)；渲染视图的绘制归 [contracts.md §K4](contracts.md#k4-文档服务--tern)；`inspect` 与 `report` 操作在 socket 上的形式归 [contracts.md §K1](contracts.md#k1-文档服务--协调者扩展)。何时检查属于编排，不归本文件。输入：D2.7、S6、S7、I3。

## 1. 检查状态

`inspect {blocks}` 返回检查状态。检查状态的字段：

| 字段 | 含义 |
|---|---|
| `blocks` | 被检查的块 id 列表 |
| `source` | 各块的当前块正文 |
| `compiled` | 这组块的 `CompileResult`，以文档取回表为输入（[references.md §5](references.md#5-文档取回表与预览)） |
| `view` | 文档服务为这些块发送的渲染节点摘要：`md` 节点的文本，`image` 节点的 alt |
| `findings` | 这些块各自的 §2 检查结果 |
| `version` | 检查状态的版本：这些块的依赖闭包（[launch-events.md §3](launch-events.md#3-块变化判定)）中每个块 id 的块正文（文档中不存在的块 id 记为不存在）、引用到的块结果与 `compiled` 一起计算的 SHA-256 |

- `view` 来自文档服务自己发送的节点，因为文档服务是渲染视图的唯一生产者；Tern 是否画出由 §2 的 `render_error` 与 `render_pending` 给出。
- 检查状态不含 agent 状态（I4）。

## 2. 确定性检查

文档服务按块计算下列检查：每个块单独编译，再判定各条件。结果是该块的 `findings`，显示在该块旁。它们不调用模型。

| 检查 | 不通过的条件 |
|---|---|
| `compile` | 该块的编译结果为 `Err` |
| `empty_expansion` | 该块的某个引用展开后的文本为空，或只含空白 |
| `render_error` | 当前视图中，Tern 对该块的某个操作发回过 `error` 事件；或者存在一个不能对应到块的 `error` 事件，并且此后还没有一次全量重绘得到 `ack`。对应规则见 [contracts.md §K4](contracts.md#k4-文档服务--tern) |
| `render_pending` | 最近一个包含该块节点的帧发出 2 s 后仍未收到覆盖它的 `ack` |
| `chart` | 该块正文中被 `splitTableCharts` 判为可出图的表格没有对应的 `image` 节点 |

理由：这些条件可以从文档服务已有的数据直接判定。`chart` 不交给 jev，因为在探针中 jev 对"图是否与表格对应"给出了错误答案（[E2.6](appendix-evidence.md#e26-jev-判定)）。

## 3. jev 判定

jev 判定在协调者会话的 `eval` 中用 `judge_batch` 执行（S7），判定对象是检查状态中的 `source` 与 `compiled`。`view` 与 `findings` 不进入判定对象，因为 §2 已覆盖它们。下表是判定所用的问题与阈值，是闭合列举：

| id | 类型 | instructions | 不通过的阈值 |
|---|---|---|---|
| `missing` | bool | `` `compiled` is the entire prompt a subagent receives; it can see nothing else. Does `compiled` mention material (logs, discussion, files, earlier results) whose content is absent from `compiled`? `` | P(yes) ≥ 0.5 |

- 每个问题只陈述一个条件。因为把两个条件合成一句时，jev 的答案在探针中不可用（[E2.6](appendix-evidence.md#e26-jev-判定)）。
- 一个问题加入本表之前，必须先在通过与不通过的样例上测出可以分开两者的阈值。

## 4. 触发

- 一个块的依赖闭包是以该块为唯一起点的依赖闭包（[launch-events.md §3](launch-events.md#3-块变化判定)）。下列任一情况发生后，文档服务重新计算 `compile`、`empty_expansion` 与 `chart`：该闭包中任一块 id 的块正文改变，或该块被新增或删除；该闭包引用的外部目标在文档取回表中的结果改变；该闭包引用的块结果有了新的 `result` 记录（[runs.md §4](runs.md#4-记录)）。
- 下列任一情况发生后，文档服务重新计算该块的 `render_error` 与 `render_pending`：包含该块节点的帧发出；该帧发出满 2 s；收到覆盖该帧的 `ack`；收到对应到该块或不能对应到块的 `error` 事件。
- 人可以在表单中对选中的块执行"检查"操作（[contracts.md §K4](contracts.md#k4-文档服务--tern)）；文档服务立即重新计算这些块的 `findings`，并把操作作为 `check_requested` 事件发给协调者，内容为 Run id（在模板视图中为空）与块 id 列表。没有连接时按启动请求的规则处理（[launch-events.md §5](launch-events.md#5-启动请求)）。
- 检查结果不阻止 `launch`。何时检查、结果不通过时做什么，属于编排，由协调者决定（S3）。

## 5. 结果显示

- `report {blocks, version, result}` 把一次 jev 判定的结果交给文档服务。`version` 是这次判定所用检查状态的 `version`。`result` 是两种之一：对 §3 表中每个问题 id 各给出一个 P(yes) 的完整答案；或 `judge_unavailable`。键缺失、多出或值不在 [0, 1] 内的 `result` 被拒绝，返回错误 `BadReport`（K1）。
- 文档服务为每组块保留最近一次 `inspect` 发出的 `version`。收到 `report` 时，只有它的 `version` 等于这组块最近一次发出的 `version`，并且此后依赖闭包中没有块 id 的块正文改变、没有块被新增或删除、引用的外部目标没有重新取回、引用的块结果没有新的 `result` 记录，文档服务才接受该结果；否则丢弃它，因为它判定的不是当前的检查状态。
- 文档服务在块旁显示 `findings` 与最近一次被接受的 `report`：P(yes) 达到 §3 阈值的问题显示为不通过，其余显示为通过；`judge_unavailable` 显示为未判定。
- 下列任一情况发生后，文档服务清除已显示的 `report`：依赖闭包中任一块 id 的块正文改变，或该块被新增或删除；引用的外部目标被重新取回；引用的块结果有了新的 `result` 记录；这组块的 `inspect` 发出了与已显示结果不同的 `version`。
- `report` 不写入服务记录文件，因为它是对某一时刻检查状态的判断，状态改变后失效。
