# 常见问题

## 只看到 `/auto`，没有 `/auto-review`

先确认运行的是 `autokimi`，而非官方 `kimi`。官方 `/auto` 是 Never Ask。安装完成后可用 `command -v autokimi` 查看脚本位置，并执行 `autokimi --version`。版本号仍是上游 2.3.0；判断功能以 TUI 中 `/auto-review status` 是否可用为准。

如果命令不存在，确认所选配置目录的 `bin` 已加入 PATH。若同名命令早已存在，安装器会拒绝覆盖，需要先确认其归属。

## 显示 ON，但没有执行审核

使用 `/auto-review on` 切回 Always Ask。Never Ask 和 yolo 会暂停审核；原有策略直接通过的操作也不会逐次请求分类器。

如提示环境覆盖，检查 `KIMI_CODE_EXPERIMENTAL_APPROVAL_REVIEW` 与 `KIMI_CODE_EXPERIMENTAL_FLAG`。环境变量优先于配置。

## Review timed out

该信息表示时限内没有取得最终判决，操作因此拒绝；它不代表模型已判断操作危险。两个阶段共用一个总时限，首阶段消耗过长会压缩第二阶段时间。

源码默认总时限为 30 秒。可以在配置的 `[permission.review]` 中设置 `timeout_ms = 90000`，或重新安装时显式传 `--timeout-ms 90000`。单纯重新安装但不传参数会保留原值。

先查看该会话 `approval-review.jsonl` 的 `durationMs`、`reason` 和 `stopTurn`。若多次耗时接近配置上限，检查 provider 响应速度、限流与模型可用性。90 秒仍会超时，应检查服务状态及请求规模；不要用重复执行已拒绝动作的方式探测。

此前一次本机排查中，186 条审核里有 5 条在约 30 秒超时。超时窗口内有首阶段用量事件，提示第二阶段可能来不及完成；旧审计没有分阶段计时，不能确定排队或推理各占多少。延长时限是针对这一现象的处理，尚无证据证明所有未来超时都已消除。

## 拒绝已读取过的脚本或较早授权的操作

审核证据不包含读取结果或脚本正文，也不把压缩摘要视为用户授权。上下文的具体范围见[配置文档](configuration.md)。这会导致保守拒绝；需由用户在后续请求中提供新的具体授权或调整任务范围，不能让代理换工具绕过原拒绝。

## Reviewer unavailable / invalid response

可能是模型别名、认证或 provider 错误，也可能是响应非规定 JSON、截断或被过滤。先验证模型配置可用；不要把完整认证信息贴到 issue。`/auto-review model <别名>` 可以选择已有配置的模型。

连续基础设施失败达到阈值会停止当前轮次，这是避免反复消耗或绕过拒绝的行为。

## 缓存提示 local edits 或 Overlay changed

准备器会保护已生成源码内的修改。把需要的修改同步到 overlay/补丁并备份后，再用新的 `--worktree` 还原，或自行清理旧生成目录。不要通过删除状态标记强制复用不一致的源码。
