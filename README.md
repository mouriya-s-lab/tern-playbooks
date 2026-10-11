# Tern Playbooks

人和一个 omp 协调者在 Tern 中共同编辑一份 Playbook：块以表单卡片显示，块正文中的 `((target | slice))` 引用被编译成 subagent 的 prompt，协调者在 omp `eval` 中用 `agent()` 编排 subagent；块被修改时，依赖它的运行中工作会通知协调者。设计见 [design/README.md](design/README.md)。

## 需要

- [Bun](https://bun.sh)
- Tern，并在 session daemon 托管的 pane 中运行（pane 环境中有 `TERN_PANE`）。没有 `TERN_PANE` 时，“启动协调者”与“转到协调者”按钮不显示，其余功能不受影响。
- omp（`omp` 在 `PATH` 中）。
- `gh`，已登录；只在引用 GitHub issue 或 PR 时需要。

```sh
bun install
```

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

## 启动

在一个 Tern pane 中运行文档服务：

```sh
bun src/service/main.ts path/to/playbook.yaml
```

在界面头部点“启动协调者”，Tern 在右侧新建一个 pane 并启动协调者。也可以在任意终端手动启动，命令与头部显示的相同：

```sh
env PLAYBOOK_DOC=/abs/path/to/playbook.yaml omp -e /abs/path/to/tern-playbooks/src/extension/index.ts
```

协调者会话中可用：

- 工具 `playbook`：协调者读写块、开始与结束 Run、启动与绑定、写记录、检查等，操作列表见 [design/contracts.md §K1](design/contracts.md#k1-文档服务--协调者扩展)。
- `/playbook-add`：把会话中的一条消息加入某个 Run 的时间线。
- `/playbook-show`：转到 Playbook 所在的 pane。

`playbook` 工具与命令只出现在协调者的主会话中，subagent 看不到它们。

## 编排块

块正文整体是一个 `js` 或 `py` 围栏代码块时，它是编排块；协调者启动它后，在 `eval` 中执行其中的代码。JS 示例：

```js
var doc = "/abs/path/to/playbook.yaml";
var run = "r1";
async function pb(op, args) { return JSON.parse(await tool.playbook({ doc, op, args })); }
var launch = await pb("launch", { run, blocks: ["b2"] });
var child = await agent(launch.text, { agent: "task:mid", label: "Implementation" });
await pb("bind", { launch: launch.launch, agent: child.id });
var result = await child.wait();
await pb("post", { run, kind: "result", block: "b2", launch: launch.launch, text: result });
```

- JS 中 `agent()` 返回的 handle 要先 `await` 才能读取 `id`。
- 当 omp 的默认 subagent 被禁用时，需要用 `agent:` 指定一个可用的 agent。
- `py` 编排块需要 omp 的 Python 后端可用，用 `omp setup python --check` 确认。

## 检查

文档服务对每个块做确定性检查，结果显示在块旁。jev 判定由协调者在 `eval` 中经 `judge` 模型角色完成，再用 `playbook` 的 `report` 写回；规则见 [design/checks.md](design/checks.md)。

## 测试

```sh
bun x tsc --noEmit -p tsconfig.json
bun test
```
