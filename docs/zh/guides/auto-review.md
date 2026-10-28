# Auto Review

Auto Review（自动审核）是一种实验性权限模式，通过独立的模型请求审核原本需要审批的工具操作。审核不确定或失败时拒绝执行。默认权限仍为 Always Ask（始终询问）。

## 启用 Auto Review

在 TUI 中打开 `/permission`，选择 `Auto Review (not enabled)`，即可启用能力并为当前会话选择该模式。确认默认选择取消，并说明模型用量。启用能力会修改共享配置，但不会改变其他会话的权限模式。若环境变量锁定了关闭状态，TUI 会提示重启时如何启用。

在已有的 `config.toml` 中添加以下表；如果已有 `[experimental]`，则将配置键合并进去：

```toml
[experimental]
approval_review = true
```

使用 `kimi --permission-mode review` 启动，或在 `/permission` 中选择 Auto Review。若要将其作为新会话的默认模式，设置顶层配置键 `default_permission_mode = "review"`。只启用实验能力不会改变权限模式或已有会话。

也可以仅为一次调用启用能力：

```sh
KIMI_CODE_EXPERIMENTAL_APPROVAL_REVIEW=1 kimi --permission-mode review
```

## 审核结果

Auto Review 会先检查受保护的文件路径，再执行原生权限规则。它拒绝修改 `AGENTS.md`、`CLAUDE.md`、`KIMI.md` 和 `.agents/`，并保护 `.kimi-code/` 与 Kimi 运行数据目录，使用别名访问也会检查。正常读取工作区指令仍可进行。在普通文档正文中提及这些文件名，不会被当作访问对应文件。

通过这些检查后，在交互会话中，原本直接通过的操作保持直接通过；显式 deny 规则继续生效，显式 ask 规则不能被自动批准。其他待审批操作交给审核模型。快审可以批准操作，否则由独立的完整审核检查相同证据。结论不确定、证据不可用、模型错误、超时或审计日志不可用时均拒绝执行。

文件操作绑定审批前检查到的文件与父目录身份。其他进程在审核期间或执行前改变目标时，操作会被拒绝，必须重新解析。写入已有文件时直接使用经过校验的已打开文件，因此更换软链接无法将待执行的写入重定向到其他文件。这些写入保留已有文件身份，不采用原子替换。

Auto Review 下，无论 Agent 创建目标还是使用 `/goal`，交互与无头会话都会直接开始，不要求人工确认。启动目标保持 Auto Review，不会授权后续操作；无头目标的各轮次共享任务的累计预算。业务问题和计划审阅仍由用户决定，非交互调用不能代替用户批准这些交互。连续安全拒绝会停止当前轮次；基础设施故障使用有界重试和冷却，不占用安全拒绝预算。

审核请求不提供工具。只有真实用户请求和已验证的人工响应能够提供授权；Assistant 消息、摘要、Hook、工具输出、导入上下文和子 Agent 指令都不能授权。

## 管理审核

`/approval` 打开审核管理，权限切换继续使用 `/permission`。

| 命令 | 操作 |
| --- | --- |
| `/approval status` | 查看当前模式和审核模型 |
| `/approval model` | 选择已配置的审核模型 |
| `/approval model @session` | 跟随各 Agent 当前使用的模型 |
| `/approval denials` | 列出当前会话中可申请一次授权的拒绝 |
| `/approval approve` | 查看拒绝详情并确认一次重试 |
| `/approval approve <toolCallId>` | 查看指定拒绝操作 |

授权对话框显示完整工具参数和工作目录，默认选择取消，并要求独立的二次确认。授权只允许对完全相同的操作重试一次，重试仍须通过审核。它不能绕过显式规则、受保护的指令或配置，以及 critical 风险限制。切换权限、撤销或压缩上下文、关闭会话和重启都会使旧授权失效。

对话、恢复后的历史和会话选择器会显示可读的一次授权摘要。原始授权记录仍保留在原生会话中，用于验证和审计。

审核模型是共享配置，权限模式属于当前会话。默认跟随 Agent 的模型及认证；选择其他别名后，使用该别名的供应商、base URL 和凭据。审核证据会发送给对应供应商，审核及重试会产生模型用量。审核使用实现规定的 low/off effort 策略，不继承 main agent 选择的 effort。

```toml
[permission.review]
# model = "configured-reviewer-alias"
timeout_ms = 30000
max_context_chars = 60000
two_stage = true
shell_sandbox = true
shell_allowed_domains = []
# policy = "Additional trusted operator policy"
```

## Shell 沙箱

Auto Review 在 macOS 或 Linux 的系统沙箱中执行 `Bash` 及其后代进程。其他权限模式保留原有 Shell 执行路径。接受审核的 Shell 操作必须使用沙箱；关闭 `shell_sandbox`、缺少辅助程序或平台不受支持时直接报错，不会脱离沙箱执行命令。

Linux 需要 `bubblewrap`、`socat` 和 `ripgrep`，内核或容器策略也必须允许沙箱运行。原生安装包包含固定版本的 seccomp 辅助程序。Windows 可以审核其他工具及已有文件写入，但本实现不提供接受审核的 `Bash` 执行、新文件创建或目录创建。macOS 和 Linux 的文件创建还要求系统支持通过固定的目录身份访问，否则会被拒绝。

沙箱将写入限制在工作区和临时目录，保护 Kimi 配置与 Agent 指令，并禁止访问常见凭据目录。Shell 网络默认禁止，须显式配置允许的域名；带预算的无头任务还须传入 `--allow-network`。Shell 沙箱不包含文件工具、MCP 服务或模型请求，这些能力继续接受各自的权限检查。所有权限模式下，文件写入都会拒绝有多个硬链接的普通文件。

## 其他客户端

单次非交互提示词可以显式选择权限模式：

```sh
kimi --permission-mode review -p "Inspect this project and fix the failing test" --output-format stream-json
```

未显式选择模式时，`kimi -p` 保留现有行为和输出协议。需要查询进度、累计预算、取消或后台执行时，使用[无头任务](../reference/headless-runs.md)。

只有启用审核能力时，ACP 才会提供新增的 `review` 模式。在 Kimi Code for VS Code 中，使用 `/permission` 打开原生选择器，或使用 `/permission review`；重新连接审核会话时保留其模式。显式执行旧权限命令仍可改变模式。

SDK 接受 `permission: "review"`，服务端提示词 API 接受 `permission_mode: "review"`。桌面与网页界面维护在其他仓库，需要在对应仓库同步权限选择器。客户端必须理解新增值后才能使用审核会话，不能将未知值转换为 Never Ask。

## 会话兼容

会话、索引、缓存和锁继续使用 Kimi 原有数据目录。已有 Always Ask、Ask When Needed 和 Never Ask 会话保留权限，不需要导入，也不会自动转换。切换权限会立即取消进行中的审核，并使旧授权失效。

旧版客户端可能不理解持久化事件或协议中的 review 值。降级前保留会话导出或备份；只改变最后的权限模式不会移除历史中的审核事件。
