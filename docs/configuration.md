# 配置与审核行为

[English](en/configuration.md) | [简体中文](configuration.md)

## 开关与权限模式

```toml
default_permission_mode = "manual"

[experimental]
approval_review = true

[permission.review]
timeout_ms = 90000
max_context_chars = 60000
two_stage = true
# model = "provider/model-alias"
# policy = "附加的可信操作策略"
```

配置通常位于 `~/.kimi-code/config.toml`。合并到已有文件的对应表中，勿重复定义 TOML 表。审核模型使用已配置别名；未指定或设为 `@session` 时，跟随当前代理模型及其认证。

| 设置                | 源码默认值   | 范围/意义                                            |
| ------------------- | ------------ | ---------------------------------------------------- |
| `approval_review`   | `false`      | 安装器和 `/auto-review on` 开启                      |
| `timeout_ms`        | `30000`      | 1000–120000 毫秒，两阶段合计；安装示例显式设为 90000 |
| `max_context_chars` | `60000`      | 4000–100000 字符的审核证据预算，不是 token 数        |
| `two_stage`         | `true`       | 快审不通过时，独立再审一次                           |
| `model`             | 当前代理模型 | 不继承主代理的 thinking effort                       |
| `policy`            | 无           | 最多 8000 字符，另附在审核系统策略中                 |

`KIMI_CODE_EXPERIMENTAL_APPROVAL_REVIEW` 或总开关 `KIMI_CODE_EXPERIMENTAL_FLAG` 可以覆盖配置。被环境变量控制时，TUI 会提示来源，无法用命令改写该覆盖。

非法 `review` 配置不会连带删除 `permission.rules`：运行时保留原始非法值并使相关审核拒绝，严格配置写入仍会报错，不会静默恢复默认审核设置。

`/auto-review on` 开启审核并切回 Always Ask；`status` 查询并同步底栏缓存；`off` 恢复所选权限模式的原有审批行为。有活动会话时，on/off 只覆盖当前会话并保存在 session metadata 中，不改变其他工作目录的会话；无活动会话时才修改全局默认值。环境变量强制开关仍优先。`/auto` 是官方 Never Ask，`yolo` 同样会使审核暂停。异步开启或会话切换期间，以最新会话和权限状态为准，不会用过期快照回写权限模式或底栏。

## 审核模型、effort 与接口地址

未指定 `permission.review.model` 或设为 `@session` 时，审核跟随触发该操作的代理模型；主代理对应 `/model` 当前选择，子代理可能不同。显式选择别名后，审核使用该别名；`/auto-review model` 提供已配置模型选择，`/auto-review status` 显示当前设置。审核模型是共享配置，开关则可按会话覆盖。

审核的 thinking effort 策略固定在实现中：始终思考且支持 `low` 的模型用 `low`；该类模型不支持 `low` 时用默认 effort 或 `on`；其他模型用 `off`。快审与完整审核一致，不继承主代理的 effort。当前没有审核专用 effort 配置键。

自定义审核服务可增加独立 provider 和模型别名，合并到已有 `config.toml` 的相应表中：

```toml
[providers.review_api]
type = "openai"
base_url = "https://api.example.com/v1"
api_key_env = "REVIEW_API_KEY"

[models.reviewer]
provider = "review_api"
model = "YOUR_MODEL_ID"
max_context_size = 32768 # 按实际模型能力填写

[permission.review]
model = "reviewer"
```

密钥通过所选环境变量提供。地址优先级为模型级 `base_url`、provider 级 `base_url`、协议对应的环境变量或默认值。`permission.review` 引用模型别名，不接受独立的 `base_url` 或 `effort` 键。调整共享 provider 会影响同样引用它的模型；独立 provider 便于单独管理审核的地址和凭据。修改后重启交互会话并查询状态。

## 最终只有通过或拒绝

原有权限规则先执行。原本可以直接通过或明确拒绝的操作沿用原规则，只有进入待审批入口的操作交给分类器。显式 `ask` 规则在审核模式下直接拒绝；不会弹出权限批准框。

开启两阶段时，快审返回有效 `allow` 即通过；快审返回 `deny` 或内部 `ask` 时，再做一次独立完整审核。第二次不读取第一次结论，使用相同证据。最终仍不确定时转为拒绝。关闭两阶段则只做一次完整审核。

超时、模型不可用、响应无效/截断、证据超限、授权或设置在审核中变化、审计写入失败均拒绝当前操作，但恢复方式取决于来源。审核模型调用会对上游判定为可恢复的 provider 错误自动重试，每个审核阶段最多 10 次尝试，使用与 Kimi 主循环相同的指数退避、`Retry-After` 和取消语义。重试及等待都计入同一审核总超时；安全拒绝、不可恢复错误和用户取消不会重试。

每轮连续 3 次实际安全拒绝，或最近 50 个审核结果（包含当前决定）中累计 10 次安全拒绝，都会停止本轮。`reviewer`、`timeout` 和 `audit` 不占用这个安全拒绝预算；连续两次工具级基础设施故障进入 30 秒冷却，冷却后允许重试，成功完成模型审核且审计可用时重置故障计数。证据不足可以补齐后重试；新轮次重置全部计数、冷却和窗口。审计失败仍把当前操作转为 `audit` 拒绝，但安全计数保留模型原来的安全结论，同时保留最终基础设施故障用于诊断；不能因为审计不可用而抹掉连续安全拒绝。

### 决策来源与恢复

审计中的 `source` 区分 `model`（模型实际判决）、`policy`（确定性预检）、`config`（配置非法）、`evidence`（授权或证据不可用）、`authorization`（审核期间授权或设置变化）、`timeout`、`reviewer`（模型服务或响应故障）和 `audit`（审计故障）。这些来源只用于诊断和恢复，不改变最终二元权限结果。

- `evidence` 允许先读取相关脚本、补齐完整证据，再在原有精确授权范围内重试；它不是安全停轮的理由。
- `reviewer`、`timeout` 和 `audit` 明确属于基础设施故障，不是动作危险的安全判决；先由模型自动重试，仍失败则退避并等待后续冷却，不会仅因此停止整轮。
- `authorization` 要求用户重新确认精确动作和范围，不能仅凭变化前的授权重试。
- `model` 仅在符合下节条件时允许用户显式授权一次精确重试；`policy` 和 `config` 保持严格拒绝语义，配置问题应先修正配置，不放宽自动批准边界。

拆分任务只有在每一步都缩小实际副作用、可独立验证且不会产生原被拒绝效果时才允许，每一步都须重新审核。不得通过换工具、脚本、编码或委托达到同一个被拒绝的效果。

涉及审核配置、代理指令文件和不支持的自定义审批回调会预先拒绝。文件访问预检还会跟踪文件或父目录符号链接及悬空链接目标，拒绝通过普通别名访问这些受保护目标。只有完全匹配、且安装回执、受控 release 路径、入口哈希和启动器整文件哈希均有效的 `<home>/bin/kimi --version` 与 `<home>/bin/autokimi --version` 可绕过该路径保护，随后仍须通过正常审核。业务问答、计划或目标确认，以及登录和工作区信任等产品流程仍可能需要交互；一般待审批工具不会打开传统权限弹窗，唯一人工覆盖是下述精确一次授权。

### 精确动作的一次授权

`/auto-review` 打开设置菜单，集中展示状态、开关、审核模型和待授权拒绝。`/auto-review model` 打开可搜索模型列表；未知别名不写入配置，`model @session` 恢复跟随当前会话模型。模型设置是所有会话共用的配置，开关作用范围在菜单和结果中标明。

`/approval`（别名 `/approve`）列出当前 session 可授权的拒绝，Enter 先进入详情。详情支持 ↑↓、PgUp/PgDn、Home/End 查看完整工具、参数、cwd 和原因；默认焦点为取消。滚动到末尾后，Tab 或 ←→ 选择“Approve this action once”，再次 Enter 才发送。连续回车、普通空格和 Kitty 协议的空格均不会授权。Esc 在列表取消，在详情返回列表。显式 `/auto-review approve <toolCallId>` 同样需要此确认，不支持 `all`。

发送时面板显示进度；SDK 确认接收后才消费 TUI 记录并报告成功，随后自动返回输入框。提交失败保留记录，可重试。授权直接发往原 main session，不被媒体附件、旁聊或缓存提示改道；会话变化或不处于空闲状态会拒绝提交。

只有 main agent 的真实模型非 critical 拒绝可授权。挑战绑定 toolCallId、完整 `{tool,args,cwd}` 指纹和 `prefixRevision()`，最多保留 10 条；首次复审前消费，失败也不能复用。授权只增加 `verified_one_time_user_approval`，仍须 fast/full 复审，不直接执行、不修改权限规则。compaction、undo、clear、reset 或重启使其失效；子代理和后台自动批准不支持。

### 真实回答与审批记录

仅直接用户提示和 shell input 可作为请求，shell output 不算。问题回答和审批只读取当前 session、main agent 的真实已解决 interaction，不从工具文本或其他 session 重建授权。审批必须 `resolved + approved`，字段完整且 `{tool,args,cwd}` 完全匹配；一次批准在原流程和首次审核前消费，session 批准还须对应规则存在。

最近 8 条问题回答以 `human_question_answers` 传递，问题文本列为 `questions_untrusted`，不能扩大目标或工作区。记录时间、回答和规则参与授权指纹，审核期间变化会使决定失效。interaction 由 facade 限时限量保留，不是跨压缩或重启的持久授权。

## 审核能看到什么

证据不是整段会话，只包含：

- 当前工具、完整参数、cwd、代理，以及根代理最近 8 条真实用户请求；hook、skill、摘要、工具输出和子代理文本不能授权。
- 最近 8 个工具调用，以及路径相关的 `Read` 结果；包命令还可关联清单及其引用的本地脚本。最多保留 8 条并标明完整性，分页或截断结果不完整。显式 `max_chars` 须由工具状态同时证明范围完整和文件末尾，正文出现截断文字不算工具截断。
- 最近 4 条标准验证命令结果，含成功状态、输出尾部 4000 字符和截断标记。
- 精确一次授权、未消费且匹配的真实审批，以及最近 8 条真实问题回答。授权证据不包含挑战值，问题文本不可信。

预算不足先减少验证输出、历史调用和较旧读取，不截断当前操作或固定授权证据；超限则拒绝。`pending_action` 最后出现，两阶段复用同一证据且第二阶段不读取第一阶段结论。先完整读取相关脚本可提供行为证据；不完整证据可能保守拒绝，只能拆成真正缩小且可独立验证的步骤，不能换工具达到同一被拒效果。

## 审计

会话目录的 `approval-review.jsonl` 保存时间、工具标识、模型、结论、来源、耗时、指纹、拒绝计数、停轮及授权使用标记，不保存原始请求、参数、回答、interaction ID、挑战或模型自由理由。文件为 `0600` 且拒绝跟随符号链接，不应上传。

AutoKimi 开放交互 TUI、显式 `exec` 无头任务及已列出的管理命令，新上游入口默认拒绝。根命令 `-p/--prompt`、ACP/Web 和无终端启动 TUI 仍报错；自动化请使用 [无头任务接口](headless.md)。无头任务强制 Always Ask 与审核，不能使用 TUI 一次授权；预算由调用者设置并跨续跑累计。

旧 MCP OAuth 凭据若没有 `issuer`，AutoKimi 会要求重新登录，不复用其中的令牌或客户端密钥；原始存储保留供原生 `kimi` 使用。新登录会保存授权服务器绑定。

## Shell 系统沙箱（0.3.1）

Bash 默认通过固定版本的 `@anthropic-ai/sandbox-runtime` 执行。macOS 使用 Seatbelt，Linux 使用 `/usr/bin/bwrap`、`/usr/bin/socat` 和 `/usr/bin/rg`，并要求随包固定的 seccomp 辅助程序可执行。应用直接启动可信运行时生成的包装器 argv，先验证后端确实能启动，再在沙箱内解释用户命令。继承的启动脚本和动态加载注入变量会被清除；沙箱不可用时拒绝执行，不回退到普通 shell。

```toml
[permission.review]
shell_sandbox = true
shell_allowed_domains = ["registry.npmjs.org"]
```

默认仅工作目录和系统临时目录可写，Kimi home、已发现的指令文件及其真实目标保持受保护；已有受保护硬链接会阻止 shell 启动。网络域名默认空列表，拒绝 Unix socket 和本地绑定；无头入口还须有 `--allow-network` 才能使用配置中的域名。provider 的模型连接不在子进程沙箱中。常见凭据环境变量及解释器注入变量不会传给子进程。

这一默认会阻止工作区外写入、未授权网络、Docker socket、部分全局缓存及外部 Git 工作树元数据写入；请使用项目内缓存，或由父编排器完成这些操作。已在外部容器中隔离的可信 TUI 用户可以显式设置 `shell_sandbox = false` 恢复旧的模型审核 shell 行为；这会失去系统边界，路径文本检查仅是辅助。无头任务始终要求 shell 沙箱，不能利用该设置降级。

权限规则中的命令参数仍是原始字符串 glob；`Bash(rm *)` 不涵盖所有绝对路径或嵌套解释器变体。需要完全禁用一类工具时使用工具级规则。系统沙箱只覆盖 shell，原生默认允许的读取、Web 和 MCP 行为仍须按各自策略评估。

AutoKimi 的版本特例还要求 `static-v1` 回执，输出的是静态安装身份；它不是安装目录的实时完整性证明。原生 Kimi 的特例仅验证命令文件摘要，不认证其全部依赖，实际执行仍经过 shell 沙箱和正常审核。
