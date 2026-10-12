# Tern Playbooks

Tern Playbooks 是一个 omp 扩展。它在每个 omp 主会话中注册 `playbook_*` 工具，由模型自己决定何时使用。调用这些工具的主会话就是协调者：它和人在 Tern 中共同编辑一份 Playbook，块以表单卡片显示，块正文中的 `((target | slice))` 引用被编译成 subagent 的 prompt，协调者在 `eval` 中用 `agent()` 把工作交给 subagent；块被修改时，依赖它的运行中工作会通知协调者。设计见 [design/README.md](design/README.md)。

## 需要

- [Bun](https://bun.sh)
- Tern，omp 运行在 session daemon 托管的 pane 中（pane 环境中有 `TERN_PANE`）。没有 `TERN_PANE` 时，`playbook_open` 不能在 omp 旁边打开文档服务。
- omp（`omp` 在 `PATH` 中）。
- `gh`，已登录；只在引用 GitHub issue 或 PR 时需要。

## 安装

```sh
bun install
ln -s "$PWD" ~/.omp/agent/extensions/tern-playbooks
tern plugin link "$PWD/tern-plugin"
```

- omp 扩展：`package.json` 的 `omp.extensions` 声明了扩展入口，omp 每次启动会话时都会加载它，不需要 `-e`。已经在运行的 omp 会话要重启后才有 `playbook_*` 工具。
- Tern 插件：`tern-plugin/` 在 Tern 的命令面板中提供"Playbook: 打开"。它从本仓库加载文档服务入口，所以要用 `link` 安装，不能用 `tern plugin install` 复制。

## Playbook 文件

一个 YAML 文件。块正文用块标量书写，保持多行文本原样：

```yaml
title: 修 issue
blocks:
  - id: b1
    title: 上下文
    body: |
      ((https://github.com/cli/cli/issues/1000))
      ((file:src/calc.ts | lines(1..40)))
    done: false
  - id: b2
    title: 实现
    body: |
      按下面的上下文修复问题：
      ((b1))
    done: false
```

引用的目标与截取表达式见 [design/references.md](design/references.md)。`file:` 路径相对于 Playbook 文件所在目录。

## 使用

在 Tern pane 中运行的 omp 会话里直接用自然语言提要求，例如"在这个目录建一个 playbook，第一块引用 notes.txt 的前两行，第二块让 agent 总结第一块，打开给我看"。模型会自己调用工具：写出 YAML 文件，用 `playbook_open` 在当前 pane 右侧打开文档服务，然后读写块、编译、开始 Run，并在 `eval` 中启动 subagent。这个会话就是协调者，本扩展不会另外启动 agent。

文档服务的 pane 在协调者会话结束后保留，头部显示"没有协调者连接"。之后任一 omp 会话对同一个文件调用 `playbook_open`，就会连接到这个服务，不会再开新的 pane。

工具（规格见 [design/contracts.md §K2](design/contracts.md#k2-协调者扩展--协调者会话)；除 `playbook_open` 外，只打开了一份 Playbook 时可以省略 `doc`）：

| 工具 | 操作 |
|---|---|
| `playbook_open` | 连接 Playbook，没有文档服务时在旁边打开 |
| `playbook_read` | 读全部块或一个块 |
| `playbook_edit` | `title`、`done`、`replace`、`insert`、`delete`；修改已有块时在这一次调用内加锁、修改、解锁 |
| `playbook_compile` | `compile`（得到块编译出的 prompt）、`refetch` |
| `playbook_check` | `inspect`、`report` |
| `playbook_run` | `start`、`finish`、`list` |
| `playbook_timeline` | `read`、`post`、`snooze` |
| `playbook_launch` | `launch`、`bind`、`info`、`rebase`、`close` |

在 `eval` 中可以直接使用 `playbook` 辅助，扩展会在执行前把它导入单元：`await playbook.run({ run: "r1", blocks: ["b2"] })` 创建 Launch、启动 subagent、绑定、等待并记录结果；`playbook.agent(...)` 启动并绑定后立即返回，用于并行启动多个，再对每个调用 `playbook.result(...)`。使用 `playbook.run` 或 `playbook.result` 且没有给出 `timeout` 的单元不限时。

另有两条给人用的命令：

- `/playbook-add`：把会话中的一条消息加入某个 Run 的时间线。
- `/playbook-show`：转到 Playbook 所在的 pane。

工具与命令只出现在 omp 的主会话中，subagent 看不到它们。

在 Tern 中也可以直接打开 Playbook：聚焦 Playbook 的 YAML 文件块，按 Ctrl+Shift+P 打开命令面板，选"Playbook: 打开"。只有聚焦的是 `.yaml` 或 `.yml` 文件块时，这个命令才会出现在面板里。该文件已有文档服务时，它的 pane 会被显示出来；没有时，会在旁边开一个文档服务 pane。这个命令不会启动 omp，协调者仍是之后对这个文件调用 `playbook_open` 的 omp 会话。

## 编排块

块正文整体是一个 `js` 或 `py` 围栏代码块时，它是编排块。启动它分两步：`playbook_launch {op: "launch", run, blocks: ["b4"]}` 得到 `l<n>`，再发一个全部代码为 `await playbook.exec("l<n>")` 的 `eval`；扩展把这个单元替换为该 Launch 冻结的编排代码，并且不限时。JS 编排代码中 `playbook` 的 Run 与文档默认取这个 Launch：

```js
var impl = await playbook.run({ blocks: ["b2"], agent: "task:mid", label: "Implementation" });
var review = await playbook.run({ blocks: ["b3"], agent: "task:mid", label: "Review" });
```

- 当 omp 的默认 subagent 被禁用时，需要用 `agent:` 指定一个可用的 agent。
- `py` 编排块中没有 `playbook` 辅助；扩展设置 `PLAYBOOK_DOC`、`PLAYBOOK_RUN`、`PLAYBOOK_LAUNCH`，代码直接调用 `tool.playbook_*` 与 `agent()`。它需要 omp 的 Python 后端可用，用 `omp setup python --check` 确认。

## 检查

文档服务对每个块做确定性检查，结果显示在块旁。jev 判定由协调者在 `eval` 中经 `judge` 模型角色完成，再用 `playbook_check` 的 `report` 写回；规则见 [design/checks.md](design/checks.md)。

## 测试

```sh
bun x tsc --noEmit -p tsconfig.json
bun test
```
