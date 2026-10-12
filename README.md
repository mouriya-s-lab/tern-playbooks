# Tern Playbooks

Tern Playbooks 是一个 omp 扩展。它在每个 omp 主会话中注册 `playbook_*` 工具，由模型自己决定何时使用。调用这些工具的主会话就是协调者：它和人在 Tern 中共同编辑一份 Playbook，块以表单卡片显示。Playbook 把阶段设计和执行放在一起：设计块里人写需求，协调者按人的修改 prompt 修订以组件可视化的设计；执行块正文中的 `((target | slice))` 引用被编译成 subagent 的 prompt，协调者在 `eval` 中用 `agent()` 把工作交给 subagent；块被修改时，依赖它的运行中工作会通知协调者。

## 需要

- [Bun](https://bun.sh)
- Tern，omp 运行在 session daemon 托管的 pane 中（pane 环境中有 `TERN_PANE`）。没有 `TERN_PANE` 时，`playbook_open` 不能在 omp 旁边打开文档服务。
- omp（`omp` 在 `PATH` 中）。
- `gh`，已登录；只在引用 GitHub issue 或 PR 时需要。

## 安装

在 omp 中安装插件：

```sh
omp plugin install 'https://github.com/mouriya-s-lab/tern-playbooks.git#master'
```

地址末尾的 `#master` 不能省：省略分支时 bun 请求 `…/tarball/`，GitHub 返回 404，安装失败。

- 安装时 omp 会运行一次扩展。扩展先检查 `PATH` 中有没有 `tern`：没有时安装失败，omp 回滚，什么都不留下。
- 有 Tern 时，扩展把插件包里的 `tern-plugin/` 用 `tern plugin link` 装到 Tern，Tern 的命令面板随即有"Playbook: 打开"。已经装好时不重复操作。
- 之后每个 omp 主会话都有 `playbook_*` 工具；已经在运行的 omp 会话要重启后才有。
- omp 只对 git 或 npm 来源运行这次安装检查；从本地路径安装（`omp plugin install ./tern-playbooks`）只建立符号链接，Tern 侧在第一次启动 omp 会话时才装上。
- `omp plugin uninstall tern-playbooks` 不会通知 Tern；卸载后用 `tern plugin unlink tern-playbooks` 移除 Tern 侧。

## Playbook 文件

一个 YAML 文件。块有两种，按字段区分；多行文本用块标量书写，保持原样：

```yaml
title: 修 issue
blocks:
  - id: b1
    title: 缓存方案
    requirement: |
      重启后缓存不能丢；读延迟要低。
    design: |
      ## A 结论
      ```callout ok 用 Redis
      重启后数据还在。
      ```
      ## B 请求路径
      ```flow LR
      Client -> Gateway -> [(Redis)]
      ```
    done: false
  - id: b2
    title: 上下文
    body: |
      ((https://github.com/cli/cli/issues/1000))
      ((file:src/calc.ts | lines(1..40)))
    done: false
  - id: b3
    title: 实现
    body: |
      按下面的设计和上下文修复问题：
      ((b1 | panel(B)))
      ((b2))
    done: false
```

- **执行块**（`body`）是要运行的 prompt，正文是 Markdown，可以写引用。
- **设计块**（`requirement` 与 `design`）对应一个设计或业务单元，不能直接启动，由执行块引用。
- 只写 `body` 的旧文件照常打开；`body` 与 `requirement`/`design` 混写，或缺少这些字段，文件不能解析。
- `file:` 路径相对于 Playbook 文件所在目录。

## 设计块

| 部分 | 谁写 | 怎么改 |
|---|---|---|
| 需求 `requirement` | 人 | 卡片上用铅笔直接改 |
| 设计 `design` | 协调者 | 人不直接改；人点"写修改 prompt"写下要改哪里、改成什么，再点"提交修改" |
| 修改记录 | 人提交的修改 prompt | 只追加，存在 `<文件>.revisions.jsonl`（Run 的在 `<名>.runs/<run>.revisions.jsonl`）；读块时不附带，用 `playbook_read {op: "revisions"}` 查询 |

提交修改时必须有协调者连接，否则提交被拒，修改 prompt 留在编辑框里。提交后协调者会话收到带这条 prompt 的通知，协调者用 `playbook_edit` 的 `write`、`replace` 或 `panel` 修订设计。在 Run 中协调者修改了设计，引用它的运行中 Launch 会收到 `block_changed`。新 Run 的修改记录从空开始，模板的记录仍可单独查询。

设计用 [answer-me-with-html](https://github.com/QingYunA/answer-me-with-html) 的稿件格式书写，由文档服务自己解析并以 Tern 原生节点绘制：

- 稿头 `---`（`template: sheet|doc`、`title`、`subtitle`、`cols`，其余键显示在标题下）、导语、`## A 标题 {span=2 rows=2 bare meta="…"}` 面板。`sheet` 面板排成网格，`doc` 排成一列。
- Markdown 正文、`$…$` 与 `$$` 公式、表格（单元格以 `ok`/`no`/`warn` 开头时显示为 ✓/✗/!）、单独一行的图片 `![说明](路径)`（只读 Playbook 目录内的文件）。
- 组件：`flow`、`er`、`sequence`、`tree`、`timeline`、`limits`、`annot`、`kv`、`callout`、`ask`（只展示，不收集选择）、`diff`、`html`、`svg`，以及带 `src=`/`lines=`/`hl=`/`title=`/`start=` 的代码块。写法见 `am help <组件>`。
- `flow`、`er`、`tree` 的行可用 `+ `、`- `、`~ ` 标出新增、删除、修改，卡片上可在"变更/之前/之后"间切换。
- 稿件问题带行号显示在块旁，检查项 `draft` 不通过。

执行块这样引用设计块：

| 写法 | 得到 |
|---|---|
| `((b1))` | 需求与设计，分别包在 `<requirement>`、`<design>` 中 |
| `((b1 \| requirement))` | 只有需求 |
| `((b1 \| design))` | 整份设计稿 |
| `((b1 \| panel(B)))` | 标题写明 ID `B` 的那个面板；没写 ID 的面板不能引用 |

设计稿里的 `((…))` 不会被展开。`lines`、`section` 不能用于设计块，`requirement`、`design`、`panel` 不能用于执行块。

## 使用

在 Tern pane 中运行的 omp 会话里直接用自然语言提要求，例如"在这个目录建一个 playbook，第一块是缓存方案的设计，第二块让 agent 按设计的请求路径实现，打开给我看"。模型会自己调用工具：写出 YAML 文件，用 `playbook_open` 在当前 pane 右侧打开文档服务，然后读写块、编译、开始 Run，并在 `eval` 中启动 subagent。这个会话就是协调者，本扩展不会另外启动 agent。

文档服务的 pane 在协调者会话结束后保留，头部显示"没有协调者连接"。之后任一 omp 会话对同一个文件调用 `playbook_open`，就会连接到这个服务，不会再开新的 pane。

工具（除 `playbook_open` 外，只打开了一份 Playbook 时可以省略 `doc`）：

| 工具 | 操作 |
|---|---|
| `playbook_open` | 连接 Playbook，没有文档服务时在旁边打开 |
| `playbook_read` | 读全部块或一个块；`revisions` 查询设计块的修改记录 |
| `playbook_edit` | `title`、`done`、`replace`、`write`、`panel`、`insert`（执行块）、`insert_design`（设计块，需求留空由人写）、`delete`；`replace`/`write` 作用于执行块正文或设计块的设计稿；修改已有块时在这一次调用内加锁、修改、解锁 |
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

执行块正文整体是一个 `js` 或 `py` 围栏代码块时，它是编排块。启动它分两步：`playbook_launch {op: "launch", run, blocks: ["b4"]}` 得到 `l<n>`，再发一个全部代码为 `await playbook.exec("l<n>")` 的 `eval`；扩展把这个单元替换为该 Launch 冻结的编排代码，并且不限时。JS 编排代码中 `playbook` 的 Run 与文档默认取这个 Launch：

```js
var impl = await playbook.run({ blocks: ["b2"], agent: "task:mid", label: "Implementation" });
var review = await playbook.run({ blocks: ["b3"], agent: "task:mid", label: "Review" });
```

- 当 omp 的默认 subagent 被禁用时，需要用 `agent:` 指定一个可用的 agent。
- `py` 编排块中没有 `playbook` 辅助；扩展设置 `PLAYBOOK_DOC`、`PLAYBOOK_RUN`、`PLAYBOOK_LAUNCH`，代码直接调用 `tool.playbook_*` 与 `agent()`。它需要 omp 的 Python 后端可用，用 `omp setup python --check` 确认。

## 检查

文档服务对每个块做确定性检查，结果显示在块旁：执行块检查编译、空展开与表格图表，设计块检查稿件（`draft`）。jev 判定由协调者在 `eval` 中经 `judge` 模型角色完成，再用 `playbook_check` 的 `report` 写回。

## 测试

```sh
bun x tsc --noEmit -p tsconfig.json
bun test
```
