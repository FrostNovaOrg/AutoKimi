# 原生接入架构

[English](en/architecture.md) | [简体中文](architecture.md)

```mermaid
flowchart TD
  A[工具请求] --> B[原有权限规则]
  B -->|通过| X[执行]
  B -->|拒绝| D[拒绝]
  B -->|待审批| C{权限为 Auto Review?}
  C -->|否| H[原生审批]
  C -->|是| F[预检、证据、快审]
  F -->|allow| V[复核授权与审计]
  F -->|deny / ask| R[完整复审]
  R -->|allow| V
  V -->|成功| X
  F -->|失败| D
  R -->|拒绝或失败| D
  V -->|失败| D
```

关闭两阶段时直接完整审核。两阶段使用相同证据，复审不读取快审结论；模型均不提供工具。

## 引擎与证据

`overlay/packages/agent-core-v2/src/agent/approvalReview/` 实现审核；`patches/native-review.patch` 接入待审批入口并载入配置权限规则。TUI 的直接通过、拒绝及业务确认沿用上游语义。无头模式的附加策略见下文。

只有根代理的真实请求、shell input、已验证审批和回答提供授权；assistant、摘要、委派、hook、工具结果和 shell output 不能授权。关联 `Read` 与有限验证输出只是不可信行为证据，分页、截断及未知脚本不能证明安全。动作和当前授权不静默截断，缺失或超预算均拒绝。

可恢复错误每阶段最多尝试 10 次，退避并遵循 Retry-After，共用总超时。连续两次基础设施失败冷却 30 秒；基础设施故障和证据不足不占安全停轮预算。连续 3 次或最近 50 个结果累计 10 次安全拒绝会停轮。审计失败拒绝执行，保留原安全结论。可拆分副作用更小的独立步骤，禁止绕道达到已拒绝效果。

## 一次授权与列表同步

main agent 的非 critical 模型拒绝最多保留 10 个挑战，同一 `{tool,args,cwd}` 指纹仅保留最新挑战。每次审核完成，通过 `ToolUpdate.customData` 发布带递增 sequence 的完整有效挑战快照，包含工具、参数和理由；通过、消费、替换、淘汰和上下文修订均反映在快照中。

TUI 校验当前 session、main agent 及完整记录后替换列表，忽略重复和迟到 sequence。已发送授权的挑战保持隐藏，直到引擎将其移出快照。快照自带工具信息，兼容早于工具开始或迟于结束的事件。

`/approval`（别名 `/approve`）列出精确拒绝，Enter 进入可滚动详情，默认取消；查看完整参数及 cwd 后，显式选择一次授权并再次 Enter 才提交。SDK 接收后才消费 TUI 记录并报告成功，失败可重试；显式 ID 入口共用确认。发送前重查 session、模式和挑战，独立提交入口不经过旁聊、媒体或缓存提示。

引擎在首次模型调用前验证用户通道、挑战、session/agent、完整指纹和 `prefixRevision()` 并原子消费。授权仅加入复审证据，不能绕过 protected action、显式 ask、critical 等约束，不生成 allow 规则。compaction、undo、clear、session reset 和重启使旧挑战失效。grant 从普通请求中过滤；importContext 标为不可信来源。

## 回答与原生审批

`interactions` 仅查询当前 session、main agent 的已解决记录。批准须 approved、未取消、字段完整且指纹匹配；一次批准在原审批接受或首次模型审核前消费，历史中已执行的批准也排除。session 批准仅在对应规则有效时可用，子代理不能消费根批准。

实际回答与不可信问题分开，支持问题键和无歧义选项；问题或无关肯定回答不能扩大授权。原记录及 createdAt 参与指纹，审核期间授权、规则、模型或配置变化使决定失效。记录限时、限量，不跨重启持久化。

审计保留指纹、结果和授权使用状态，不记录参数、回答、挑战、interaction ID 或模型自由生成理由。

## SDK 与运行包

TUI 通过 SDK 管理审核，不导入引擎服务。官方 CLI 的普通钩子不能解决核心待审批请求，因此构建独立运行时；`autokimi` 保留官方 `kimi`，默认共用账号和配置。其他版本须显式移植验证。

`upstream.lock.json` 固定精确提交。准备器在临时目录应用补丁和 overlay，成功才移入缓存；输入或源码状态变化时拒绝复用。生产打包前再次验证。

运行时、SDK 和生产依赖通过包内相对链接重建。依赖按确定遍历次序编号，保留同名同版本的不同解析节点，标识不含绝对路径。文件、权限和链接共同决定 release。安装复核摘要与版本，在 per-home 锁内更新配置、启动器和回执，失败回滚。摘要不是签名。

## 无头控制层

`patches/headless.patch` 将可选的 per-harness 控制器接入循环、模型请求、工具、权限模式及 SDK。主代理、子代理和审核请求共用累计预算与取消信号；不启用该选项时保留原有行为。CLI 只通过 SDK 创建、恢复和停止 session，不导入引擎内部服务。

CLI 的 `headless/` 维护私有请求、原子状态快照与追加事件日志，独立 worker 执行任务。提交幂等、单任务所有者、单 session 写锁及持久取消指令分开管理；恢复先核对旧 worker 已结束，再从日志恢复状态。原生 SDK 保留 session 历史和自身写锁。

无头模式保留原生 deny，文件能力检查早于原生 allow；有限只读集之外的直接 allow 转入审核。禁用自动目标/定时调度、无人值守一次授权和模式提权。事件协议、预算精度、恢复条件和 Bash 隔离边界见 [无头任务](headless.md)。

## 上游跟随

候选依次验证 CDN 版本、Git tag、npm SHA-512、签名和 provenance commit，并检查 Node、pnpm、原生依赖。独立源码目录完成构建、回归和隔离安装烟测；仅显式 `--install` 或 `upgrade` 切换安装，失败保留旧 release。

`build-kit/` 包含源码差异、工具、测试和文档，不含 Git 元数据。`check` 在仓库中使用 Git 清单，在 build-kit 中扫描源码并排除生成目录；均校验体积、敏感内容和文档链接。`git diff --check` 仅在自身有 Git 元数据时执行。更新工作与报告放在 `KIMI_CODE_HOME/autokimi/update-work`。没有后台更新，日常构建仍使用基线锁。

## 系统沙箱与文件执行层

`autokimiSandbox` 直接启动固定版本 Anthropic 运行时返回的 argv。运行时生成可信宿主包装器，用户命令作为已转义的数据传入 Seatbelt/bubblewrap，在沙箱内解释；启动前清除继承的 shell 启动脚本、动态加载注入变量和常见密钥变量。主进程持有策略、域名与代理生命周期；SDK 关闭时等待清理，权限失败不会自动脱离沙箱重试。模型服务、文件工具与 MCP 不在该 shell 边界中。

`reviewSafeWrite` 位于本地文件后端，因而在计划或允许规则跳过模型审核时仍拒绝多链接文件。完整写入不直接截断旧 inode，而是在验证后原子替换；追加使用验证后的描述符。审批层将当前文件身份加入证据，受保护对象的真实目标不依赖历史动作窗口推断。

## 权限模式与会话兼容

0.4.0 把自动审核提升为引擎、SDK、RPC、状态事件和 transcript 共同支持的 `PermissionMode = manual | review | yolo | auto`。TUI 权限选择器和底栏读取这一状态，`/auto-review` 只保留兼容命令、状态和审核模型设置。`auto` 继续表示 Never Ask。

| 改动面       | 实现边界                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| 权限引擎     | `review` 沿用手动模式的原生策略顺序，只有待审批操作交给审核器；显式 deny 优先，显式 ask 仍拒绝自动批准 |
| 协议与持久化 | SDK、klient、服务端、transcript 和遥测枚举同步；权限事件写入版本 2，并注册可回放的版本状态             |
| TUI          | 四项权限列表、状态栏、兼容命令和 Goal 确认同步；异步切换以最新用户选择为准                             |
| 子代理       | 普通子代理、fork、Swarm 恢复及 Tower 从审核父代理继承 `review`；Tower 不能强制越过该模式进入 Never Ask |
| 无头入口     | 创建及恢复代理时强制 `review`，禁止运行中切换出去；有限只读集外的副作用仍接受更严格审核                |
| 不随模式变化 | 系统沙箱、文件后端保护、模型设置、任务上下文和累计预算；人工问题、计划及 Goal 确认继续由用户决定       |

兼容配置使用顶层 `autokimi_permission_mode`，原生 `default_permission_mode` 保留三种原有值。SDK 的 `setConfig({ defaultPermissionMode })` 写入 AutoKimi 专用键，读取时返回有效默认值；显式 `autokimiPermissionMode` 也可使用。原生 Kimi 忽略该附加键，登录、provider、模型和凭据继续共享。`experimental.approval_review` 只表示能力可用性；关闭时不静默改选其他模式。

新会话、会话索引、工作区目录、会话锁和查询缓存存于 `<KimiHome>/autokimi/` 内。通用 blob 数据仍共享。旧版原生客户端不能直接读取包含 `review` 的新会话；本版不提供把新会话降级写回旧格式的导出。

```sh
autokimi session legacy-list
autokimi session import <id>
autokimi -r <id>
```

导入只复制指定旧会话，拒绝源锁、目标锁、重复 ID、链接、特殊文件及超过 256 MiB 的单文件。复制前后核对源状态，使用暂存目录和原子移动发布；原始数据不被改写。应先正常关闭源会话，崩溃遗留锁须由源客户端安全清理。历史记录、上下文及累计使用信息随副本保留，无头 run 的累计预算仍来自自己的 run 日志。

版本 2 之前的 `manual + 有效审核开关` 迁移为 `review`，旧 `manual + off`、`yolo`、`auto` 保持原模式。版本标记使用户之后显式选择 Always Ask 不会在恢复时被重新启用。权限每次实际切换递增授权代数；模式切换立即取消正在进行的审核请求；决定及未使用的一次授权不能跨越模式切换，即使随后切回 `review` 也会失效。
