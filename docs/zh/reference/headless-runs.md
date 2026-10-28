# 无头任务

`kimi exec` 通过自动权限审核和累计预算执行可查询进度的任务。请先启用 [Auto Review 能力](../guides/auto-review.md)。单次提示词仍可使用 `kimi -p`，其原有输出协议保持不变。

## 启动和查询任务

```sh
kimi exec --prompt "Fix the failing tests in this workspace" --max-steps 30 --timeout 15m --detach
kimi runs status <run-id> --json
kimi runs events <run-id> --after 0 --limit 100
kimi runs stop <run-id>
```

`--detach` 立即返回 run ID；不传此参数则持续输出 JSONL 事件，直到本次执行结束。`runs status`、`events`、`list`、`stop` 和 `schema` 不会启动模型。停止操作先确认已接收取消请求，再查询状态，直到清理完成。

使用 `runs status` 查询不存在的任务会返回 `run_not_found`，不会创建任务记录。当其他记录不完整或损坏时，`runs list` 仍会返回可读取的任务。可选的 `warnings` 数组通过 `run_id`、`code` 和 `message` 标明被跳过的记录；判断列表是否完整前，应检查这些警告。

使用 `--cwd <path>` 授权其他工作区，使用 `--prompt-file <path>` 读取 UTF-8 提示词文件，使用 `--model <alias>` 为新任务选择模型。任务参数放在 `exec` 后。`--idempotency-key <key>` 使相同提交的重试返回同一任务；相同键配合不同请求会被拒绝。

## 预算

| 参数 | 默认值 | 计数范围 |
| --- | --- | --- |
| `--max-steps` | 30 | main agent 与子 Agent 的模型循环步数 |
| `--max-requests` | 120 | 模型请求，包含审核与重试 |
| `--max-tools` | 100 | 工具尝试次数 |
| `--max-tokens` | 200000 | 已报告的输入与输出 token |
| `--timeout` | `15m` | 累计活跃运行时间 |

所有上限均为正整数。时间接受 `ms`、`s`、`m` 或 `h`。token 用量在请求完成后报告，因此一次请求可能超出上限；供应商不报告用量时无法精确估算。步数、请求、工具和时间提供独立限制。

## 接续任务

```sh
kimi exec --resume <run-id>
kimi exec --resume <run-id> --prompt "Continue after the requested clarification" --max-steps 60
```

接续时保留原生会话上下文、工作区限制、累计用量和原有预算，并在提交下一条指令前重新激活已暂停或阻塞的目标。预算已耗尽时必须显式提高上限；重启执行不会清零用量。`--session <session-id>` 在已有会话中创建新任务，不能与 `--resume` 同用。

任务仍活跃时，其他 worker 不能接续。worker 意外退出后，须先检查尚不确定的工具副作用，再传入 `--accept-uncertain-effects`。取消会清理本次任务拥有的工具与后台工作，清理后才允许接续。清理失败会报告为失败，不会当作正常停止。

## 权限与输入

所有任务均使用 `review`，恢复原本处于 Never Ask 的会话时也一样。运行中切换到其他模式会停止任务。带副作用的工具即使在普通交互会话中会被 allow 规则直接批准，也须经过审核；显式 deny 规则继续生效。

`--read-only` 将工作区操作限制在支持的只读工具集合，同时允许内部目标状态管理。目标会自动开始并保持 Auto Review，后续轮次共享任务的累计预算。目标变化通过 `goal.updated` 事件报告，最新快照可在 `state.goal` 查询。目标暂停或阻塞时返回可接续的非成功结果，原因为 `goal_paused` 或 `goal_blocked`；提高目标内部预算不会提高调用者的任务限制。

网络工具和 MCP 默认关闭，只有传入 `--allow-network` 后才可使用，且仍须审核。Shell 执行要求系统沙箱及已配置的允许域名。Cron 定时调度、无人值守的一次授权和代答人工问题不可用。出现人工问题时返回 `blocked_input`；调用者取得答案后，可通过新提示词接续。

## 事件与退出码

`kimi runs schema` 输出协议版本 1、默认值、状态、权限要求和退出码。事件使用单调递增序号；`--after` 是跨执行尝试的排他游标。输出为 JSONL，每行一个 JSON 对象。

`tool.progress` 通过 `data.message` 提供工具的进度文字，最多 2,048 个字符。`data.kind` 区分状态、输出和进度；工具提供时还会包含 `percent`、`replace` 和 `custom_kind`。现有事件标识、游标及协议版本保持不变。

| 退出码 | 含义 |
| --- | --- |
| 0 | 完成 |
| 2 | 请求无效 |
| 3 | 可重试冲突 |
| 4 | 需要人工输入、存在权限拒绝或目标已停止 |
| 5 | 达到预算上限 |
| 6 | 已取消 |
| 7 | 运行失败 |

任务可能在存在拒绝的情况下完成其他允许的工作。请检查 `status`、`reason`、`permission_denials` 和 `resumable`；仅凭退出码不能了解全部结果。

## 存储

私有任务请求、状态、取消请求和事件日志位于 `<KimiHome>/runs/<run-id>/`。原生会话继续位于 `<KimiHome>/sessions/`，使用原有会话锁。任务所有权和会话锁阻止多个进程同时写入；事件与审计日志拒绝不安全链接及特殊文件。
