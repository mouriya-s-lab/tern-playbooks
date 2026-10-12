# Tern Playbooks

Tern Playbooks 是一个 omp 扩展。它在每个 omp 主会话中注册 `playbook` 工具，由模型自己决定何时使用。调用这个工具的主会话就是协调者：它和人在 Tern 中共同编辑一份 Playbook，块以表单卡片显示，块正文中的 `((target | slice))` 引用被编译成 subagent 的 prompt，协调者在 `eval` 中用 `agent()` 把工作交给 subagent；块被修改时，依赖它的运行中工作会通知协调者。设计见 [design/README.md](design/README.md)。

## 需要

- [Bun](https://bun.sh)
- Tern，omp 运行在 session daemon 托管的 pane 中（pane 环境中有 `TERN_PANE`）。没有 `TERN_PANE` 时，`open` 不能在 omp 旁边打开文档服务。
- omp（`omp` 在 `PATH` 中）。
- `gh`，已登录；只在引用 GitHub issue 或 PR 时需要。

## 安装

```sh
bun install
ln -s "$PWD" ~/.omp/agent/extensions/tern-playbooks
tern plugin link "$PWD/tern-plugin"
```

- omp 扩展：`package.json` 的 `omp.extensions` 声明了扩展入口，omp 每次启动会话时都会加载它，不需要 `-e`。已经在运行的 omp 会话要重启后才有 `playbook` 工具。
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

在 Tern pane 中运行的 omp 会话里直接用自然语言提要求，例如"在这个目录建一个 playbook，第一块引用 notes.txt 的前两行，第二块让 agent 总结第一块，打开给我看"。模型会自己调用 `playbook` 工具：写出 YAML 文件，用 `open` 在当前 pane 右侧打开文档服务，然后读写块、编译、开始 Run，并在 `eval` 中用 `agent()` 启动 subagent。这个会话就是协调者，本扩展不会另外启动 agent。

文档服务的 pane 在协调者会话结束后保留，头部显示"没有协调者连接"。之后任一 omp 会话对同一个文件调用 `open`，就会连接到这个服务，不会再开新的 pane。

`playbook` 工具的操作列表见 [design/contracts.md §K1](design/contracts.md#k1-文档服务--协调者扩展) 与 [§K2](design/contracts.md#k2-协调者扩展--协调者会话)。另有两条给人用的命令：

- `/playbook-add`：把会话中的一条消息加入某个 Run 的时间线。
- `/playbook-show`：转到 Playbook 所在的 pane。

工具与命令只出现在 omp 的主会话中，subagent 看不到它们。

在 Tern 中也可以直接打开 Playbook：聚焦 Playbook 的 YAML 文件块，按 Ctrl+Shift+P 打开命令面板，选"Playbook: 打开"。只有聚焦的是 `.yaml` 或 `.yml` 文件块时，这个命令才会出现在面板里。该文件已有文档服务时，它的 pane 会被显示出来；没有时，会在旁边开一个文档服务 pane。这个命令不会启动 omp，协调者仍是之后对这个文件调用 `open` 的 omp 会话。

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
- 等待 subagent 的 `eval` 调用要给出足够的 `timeout`（`0` 表示不限），否则默认的单元时限会在 subagent 结束前中断它。
- 当 omp 的默认 subagent 被禁用时，需要用 `agent:` 指定一个可用的 agent。
- `py` 编排块需要 omp 的 Python 后端可用，用 `omp setup python --check` 确认。

## 检查

文档服务对每个块做确定性检查，结果显示在块旁。jev 判定由协调者在 `eval` 中经 `judge` 模型角色完成，再用 `playbook` 的 `report` 写回；规则见 [design/checks.md](design/checks.md)。

## 测试

```sh
bun x tsc --noEmit -p tsconfig.json
bun test
```
