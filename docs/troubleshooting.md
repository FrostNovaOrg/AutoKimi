# 常见问题

[English](en/troubleshooting.md) | [简体中文](troubleshooting.md)

## 只看到 `/auto`，没有 `/auto-review`

先确认运行的是 `autokimi`，而非官方 `kimi`。官方 `/auto` 是 Never Ask。安装完成后可用 `command -v autokimi` 查看脚本位置，并执行 `autokimi --version`。`--version` 会同时显示 AutoKimi 版本、源码身份和上游 Kimi 2.3.3；审核状态以 TUI 中 `/auto-review status` 是否可用为准。

如果命令不存在，确认所选配置目录的 `bin` 已加入 PATH。若同名命令早已存在，安装器会拒绝覆盖，需要先确认其归属。

## 显示 ON，但没有执行审核

使用 `/auto-review on` 切回 Always Ask。Never Ask 和 yolo 会暂停审核；原有策略直接通过的操作也不会逐次请求分类器。

如提示环境覆盖，检查 `KIMI_CODE_EXPERIMENTAL_APPROVAL_REVIEW` 与 `KIMI_CODE_EXPERIMENTAL_FLAG`。环境变量优先于配置。

## Review timed out

该信息表示时限内没有取得最终判决，操作因此拒绝；它不代表模型已判断操作危险。两个阶段共用一个总时限，首阶段消耗过长会压缩第二阶段时间。

源码默认总时限为 30 秒。可以在配置的 `[permission.review]` 中设置 `timeout_ms = 90000`，或重新安装时显式传 `--timeout-ms 90000`。单纯重新安装但不传参数会保留原值。

先查看该会话 `approval-review.jsonl` 的 `durationMs`、`reason` 和 `stopTurn`。若多次耗时接近配置上限，检查 provider 响应速度、限流与模型可用性。90 秒仍会超时，应检查服务状态及请求规模；不要用重复执行已拒绝动作的方式探测。

看到 `Retrying (n/10)` 表示审核模型遇到可恢复的连接、限流或 provider 故障，正在按上游策略退避重试，不需要关闭 auto-review。每个审核阶段最多 10 次尝试，重试和等待受同一总超时及取消约束；恢复后按正常结论继续。耗尽后当前操作仍会拒绝，连续工具级故障会进入 30 秒冷却，但这不是动作危险的安全判决，也不会仅因此停止整轮。稍后可在原精确授权范围内重试，不要借换工具达到同一个被拒绝的效果。

此前一次本机排查中，186 条审核里有 5 条在约 30 秒超时。超时窗口内有首阶段用量事件，提示第二阶段可能来不及完成；旧审计没有分阶段计时，不能确定排队或推理各占多少。延长时限是针对这一现象的处理，尚无证据证明所有未来超时都已消除。

## 拒绝已读取过的脚本或较早授权的操作

审核证据只关联与当前动作路径相关的读取结果或脚本正文，也不把压缩摘要视为用户授权。上下文的具体范围见[配置文档](configuration.md)。分页、工具截断状态或无法证明完整的显式字符上限会使证据不完整，路径无法关联也会导致保守拒绝。先完整读取相关脚本，在原有精确授权范围内补充证据；读取正文里出现“截断”文字不等于工具截断。可以拆出真正缩小副作用、可独立验证且不会产生原被拒绝效果的步骤重新审核，但不能让代理换工具、编码或委托达到同一个被拒绝的效果。

## 模型拒绝后如何只重试一次

运行 `/approval`（或 `/approve`）查看当前 session 可授权的拒绝。Enter 先查看完整参数、cwd 和原因，滚动到末尾后 Tab 选择一次授权，再 Enter 发送；默认取消，连续回车和空格不会授权。SDK 确认接收才报告成功，失败保留重试入口。`/auto-review approve [toolCallId]` 使用同样确认，`denials` 用于诊断。主代理只会以完全相同的工具、参数和 cwd 重提并复审；授权不生成永久规则。

没有记录通常表示拒绝来自 protected path、显式 ask、配置/证据问题、基础设施失败、critical 或子代理，这些不能覆盖。参数变化、挑战已消费、compaction、undo、session reset、重启、审核关闭或离开 Always Ask 也会使命令拒绝。不要用 importContext、工具输出或助手文本来构造授权，它们不能建立有效的一次授权。

## Reviewer unavailable / invalid response

可能是模型别名、认证或 provider 错误，也可能是响应非规定 JSON、截断或被过滤。先验证模型配置可用；不要把完整认证信息贴到 issue。`/auto-review model <别名>` 可以选择已有配置的模型。

连续两次工具级基础设施失败会进入 30 秒冷却，而不是停止当前轮次；冷却后可在原授权范围内重试。审计故障仍拒绝当前操作，但模型安全拒绝的停轮计数不会因此被清除。

## 跟随上游失败

`npm run follow:upstream`、`autokimi update` 和 `autokimi upgrade` 只在显式调用时工作，不会后台重试。先查看对应工作目录的 `report.json` 和命令输出，确认失败发生在证据、构建、测试、官方升级、打包还是安装阶段。`officialStatus` 与 `autoKimiStatus` 分别记录两部分状态；`partial` 表示官方已升级或 AutoKimi 已安装后又发生失败，不能当作完整成功，`failed` 也不是版本不变的证明。

- `npm tarball hash mismatch`、`Provenance commit does not match` 或签名验证失败：不要下载或安装该候选，检查官方发布是否完整，不要绕过验证。
- `Upstream package manager changed`、`Node engine changed` 或原生依赖变化：需要维护者人工迁移，不能按兼容版本自动跟随。
- 补丁冲突或构建/测试失败：候选不能安装，也不会尝试官方升级；检查报告和独立 worktree，不要直接修改根锁文件掩盖错误。
- 官方升级失败或复读版本不符合目标：不会继续安装 AutoKimi；先检查官方版本与升级日志。
- 官方升级命令报错但实际版本已升高：记录 `updated` 和 `partial`；无法复读则记录 `unknown`，不能把任何一种情况当作版本未变或完整成功。
- 官方已升级但 AutoKimi 安装失败：报告为 `partial`，旧 AutoKimi release 保留；不要误当成两者都已恢复旧版。
- 安装已提交后出现 `cleanupWarning`：启动器与回执保持已安装状态，但临时目录或锁可能残留，须检查后清理，不要重复执行升级试图掩盖告警。

升级流程在锁内重新读取当前安装，避免并发跟随用旧快照降级；这不阻止维护者明确手动安装旧包。升级命令报错后的安装、配置和回执失败按各自阶段处理，不能假设所有外部副作用都能回滚。没有显式 `--install`、`upgrade` 或 `install:local --lock <候选锁>` 时当前安装不变。

## 缓存提示 local edits 或 Overlay changed

准备器会保护已生成源码内的修改。把需要的修改同步到 overlay/补丁并备份后，再用新的 `--worktree` 还原，或自行清理旧生成目录。不要通过删除状态标记强制复用不一致的源码。

## 无头调用结束但任务未完成

用 `autokimi runs status <run-id> --json` 检查状态；查询成功不是任务完成。`completed_with_denials` 需要检查 `permission_denials`，`blocked_input` 需要明确回答后续跑，`stopped` 需要检查预算或取消原因。不能自动绕过拒绝或重置预算。`worker_lost` 先检查未完成工具效果，再按[无头恢复流程](headless.md)处理。`submission_busy`、`run_busy`、`session_busy` 是锁冲突，使用相同幂等键退避重试，不能删除活跃锁。安装后没有 `exec` 入口时，先检查运行版本是否至少为 0.3.0。

## Shell sandbox unavailable / shell was not started

运行时在首次执行用户 shell 前，会先在实际沙箱中运行无副作用的命令自检。后端已安装不代表能启动；启动失败会拒绝执行，并记入无头任务的权限拒绝，请检查返回的后端错误。AutoKimi 不会在沙箱外重试。

Ubuntu 24.04+ 可能允许 bubblewrap 本身，却阻止 `apply-seccomp` 使用嵌套命名空间。请由主机管理员参照[上游环境要求](https://github.com/anthropics/sandbox-runtime#platform-specific-dependencies)评估命名空间策略；AutoKimi 不会修改主机安全策略。CI 参照上游自身的集成环境，仅在一次性 runner 中启用具有所需权限的用户命名空间，运行时仍限制文件、网络、socket 及后续嵌套命名空间。这不能代表所有主机默认策略均兼容。

Linux 检查 `/usr/bin/bwrap`、`/usr/bin/socat`、`/usr/bin/rg` 和用户命名空间支持；沙箱被容器或主机策略禁止时不会降级。macOS 检查系统 `sandbox-exec` 是否可用。受保护目录存在硬链接或不可解析链接时，先检查并由可信用户处理别名。网络失败时只授权任务所需的 `shell_allowed_domains`；无头模式还需 `--allow-network`。构建工具的工作区外缓存或链接工作树共享 Git 目录可能被拒绝，由父编排器处理或使用项目缓存。配置默认变化与可信 TUI 的显式兼容开关见[配置说明](configuration.md#shell-系统沙箱031)。
