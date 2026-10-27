# 无头任务与编排接入

[English](en/headless.md) | [简体中文](headless.md)

AutoKimi 0.3.0 提供显式 `exec` 入口，适合主代理、任务编排器和脚本调用。默认 `autokimi` 仍进入 TUI；原生 `-p`、ACP 和 Web 服务入口继续禁止。调用前配置好 Kimi 登录、主模型和审核模型，无头进程不会交互登录或索取人工审批。

## 提交、观察与停止

```sh
autokimi runs schema
autokimi exec --prompt-file task.txt --cwd /path/to/project \
  --idempotency-key task-42 --max-steps 30 --max-requests 120 \
  --max-tools 100 --max-tokens 200000 --timeout 15m --detach
autokimi runs status <run-id> --json
autokimi runs events <run-id> --after 0 --limit 100
autokimi runs stop <run-id>
```

把参数放在 `exec` 后；TUI 的全局参数不能用于这些命令。`--prompt` 与 `--prompt-file` 二选一，输入最多 1 MiB。`--model <alias>` 可为新任务选择已配置的主模型；审核器继续使用共享审核设置。`--format jsonl` 是唯一输出格式。

`--detach` 输出一条 `run.accepted` 后返回。独立 worker 持有任务，调用端退出或失联不会自动终止它。省略 `--detach` 时，前台逐行输出当前 attempt 的事件并等待最终结果；SIGINT/SIGTERM 请求取消，等待清理。强制杀死调用端不等于停止任务，应使用 `runs stop`。

`runs stop` 持久化取消请求，排队中也可提交；返回 `run.stop_accepted` 仅表示已接收。编排器应继续查询到终态，确认取消及子进程清理完成。已结束的任务返回当前快照，不会再次启动模型。`status`、`events` 和 `list` 只读取本地状态。

## 协议和幂等

输出为协议 `version: 1` 的 JSONL，stdout 仅输出结构化记录；诊断走 stderr。`runs schema` 提供默认预算、状态和退出码。事件包含 `run_id`、`session_id`（创建后）、`attempt`、`sequence`、`timestamp`、`type`、`data`。`run.started`、`run.usage`、`assistant.delta`、工具事件、`permission.denied` 和 `run.finished` 供编排器跟踪；最终事件的 `data` 包含状态、结果、累计用量及拒绝或错误信息。

`run_id` 标识一次任务，`session_id` 标识原生上下文，`attempt` 标识显式续跑次数。事件序号跨 attempt 单调递增；`--after` 是排他游标，`--limit` 为 1–200。持久保存 `next_cursor`，当 `has_more` 为真时继续分页。文本事件可能分块，最终文本以终态 `final_text` 为准。

同一个 Kimi home 下，`--idempotency-key` 为语义相同的提交去重，包括启动参数顺序不同的重试。相同键与不同输入、预算或权限范围冲突。去重返回原 run，不再启动 worker；旧 attempt 的键不能附着到后续 attempt。每次明确续跑使用新键。键不是分布式锁，不跨机器或 Kimi home 去重。

`runs status` 的退出码只表示查询是否成功；判断任务必须读取 `state.status`、`reason`、`resumable`、`usage` 和 `permission_denials`。`permission_denials` 保留最近 100 项，拒绝总数见 `usage.denials`。终态包括：

| 状态                     | 含义                           | 前台执行退出码              |
| ------------------------ | ------------------------------ | --------------------------- |
| `completed`              | 正常完成且没有权限拒绝         | 0                           |
| `completed_with_denials` | 代理结束，但至少一项操作被拒绝 | 4                           |
| `blocked_input`          | 需要调用者提供回答             | 4                           |
| `stopped`                | 预算、时限、取消或安全停轮     | 预算/时限 5，取消 6，其他 7 |
| `failed` / `interrupted` | 运行错误或 worker 丢失         | 7                           |

请求校验失败返回 2，可重试锁冲突返回 3。`queued`、`running`、`stopping` 均不是终态。不要把“有最终文字”“查询成功”或“取消已接收”当作任务完成。

## 预算与续跑

所有预算均为 run 的累计上限：

| 参数             | 默认值 | 计数范围                              |
| ---------------- | ------ | ------------------------------------- |
| `--max-steps`    | 30     | 主代理和子代理的模型循环步数          |
| `--max-requests` | 120    | 全部模型请求，含审核、两阶段与重试    |
| `--max-tools`    | 100    | 全部工具尝试，含被拒绝的尝试          |
| `--max-tokens`   | 200000 | provider 报告的输入、缓存与输出 token |
| `--timeout`      | 15m    | 累计运行时间，含等待模型、审核和工具  |

限制保存在调用进程的引擎控制器，模型不能通过目标预算工具提高它们。模型请求开始前和工具执行前检查额度；token 依赖 provider 用量上报，单个或并行的在途请求可能超过上限，也不是金额预算。暂停期间不计入运行时间；崩溃恢复只能继承最近持久化的时间及用量，不能保证恢复未上报的 token。清理有独立的有限等待时间。

```sh
# 同一任务续跑；提高的是累计上限，不是新增的步数
# 例如已用 30 步，改为 45 最多再运行 15 步
autokimi exec --resume <run-id> --max-steps 45 \
  --idempotency-key task-42-attempt-2 --detach

# 需要回答时，显式提供补充输入
autokimi exec --resume <run-id> --prompt '选择 A，继续原任务'

# 在已有上下文内开启新任务，获得新的 run 与预算
autokimi exec --session <session-id> --prompt-file next-task.txt --cwd /path/to/project
```

仅 `resumable: true` 可续跑。已耗尽的任一上限必须显式提高；工作目录、模型和网络能力不能在续跑时扩大，只读限制只能收紧。计数、拒绝窗口和原生 session 都继承。安全停轮及普通运行错误不自动重试。`--session` 创建新任务，调用者须明确授权其新范围，且不能并发写同一个 session。不同 session 的锁不互斥工作区；并行写代码时由编排器提供独立工作树或目录。

worker 丢失时标为 `interrupted/worker_lost`。恢复使用原生 SDK 历史，不复制助手文本伪造会话。如果记录中有未完成工具，先检查文件、子进程和外部效果，再显式传 `--accept-uncertain-effects`；该标志只确认已检查，不会回滚或自动重放工具。

## 权限与隔离边界

无头入口强制 Always Ask 和自动审核；审核被环境关闭时，模型调用前失败。试图切换到 auto/yolo 会停止运行。原生 deny 始终生效；通常被原生 allow 直接放行的副作用工具也进入审核。只读工具集保留直接执行路径，但仍受预算、文件范围和原生拒绝规则约束。

`--cwd` 是文件工具的授权工作区，检查真实路径和符号链接，并保护 Kimi home。`--read-only` 只允许有限读取、查询和任务内状态工具，禁用 Bash、写入和 MCP 等副作用能力。默认关闭 WebSearch、FetchURL 与 MCP；`--allow-network` 允许这些工具参与正常审核。它不控制 provider 连接，也不阻断 Bash 内的网络访问。

**这不是操作系统沙箱。** Bash 只做工作目录检查和模型权限审核；已获准 shell 的文件、进程及网络效果不由文件工具范围检查隔离。需要严格隔离时，由编排器在容器或受限账号中运行，并控制凭据和网络。不要将 `--cwd` 或 `--allow-network` 当成系统级边界。

无人值守模式不消费 TUI 一次授权，也不生成伪人工批准。`AskUserQuestion` 返回 `blocked_input`，由父 session 决定后续输入。目标和定时调度由调用者持有；无头任务拒绝创建自主目标、定时任务和脱离运行的后台委派，取消仅清理本任务新建的后台任务。

## 本地状态和运维

状态位于 `<KimiHome>/autokimi/runs/<run-id>/`，目录 0700，任务文件 0600。请求、结果和事件可能包含任务文本，按敏感 session 数据管理，不要提交到仓库或公开日志。自动审核审计保持其独立格式。

每个 run 单 worker，每个原生 session 单写者，提交及所有权通过本地原子文件锁协调。此协议面向单机受信调用者，不是多租户远程服务。事件日志上限 32 MiB，最终文本最多 64 KiB 并通过 `text_truncated` 标识；到达日志限制会失败。当前没有自动删除策略；确认任务停止后再按保留政策清理整项 run，保留需要的游标与结果。替换或卸载运行包前先停止其活跃任务。

测试与已验证平台见[验证记录](verification.md)，配置和费用见[配置说明](configuration.md)。
