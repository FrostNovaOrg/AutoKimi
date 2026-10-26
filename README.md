# AutoKimi

为 Kimi Code 原生 TUI 增加模型权限审核。保留官方 `kimi` 命令，使用独立的 `autokimi` 启动带审核功能的运行时。

当工具操作进入待审批状态时，审核器依据用户授权和具体操作返回 **通过或拒绝**。不确定、超时或审核失败均拒绝，并说明原因；不会转交人工批准。可恢复的模型服务错误会自动退避重试，连续工具级基础设施故障进入短暂冷却；只有连续或累计的安全拒绝会停止当前轮次。

这是基于官方源码的轻量补丁项目。当前固定 Kimi Code **2.3.0**，使用已有 Kimi 登录、provider 和模型配置。它通过引擎权限入口和 SDK 接入原生 TUI，需要独立的 JavaScript 运行时；启动脚本负责选择该运行时。

## 安装

已在 macOS 上验证；安装器面向 macOS/Linux，Linux 尚未实测。需要 Node.js ≥24.15.0、Git、pnpm **10.33.0**，以及已配置的 Kimi 账号或模型。首次构建会下载官方源码和依赖，构建目录可能占用数 GB。

```sh
git clone https://github.com/FrostNovaOrg/AutoKimi.git
cd AutoKimi
npm run build
npm run install:local -- --timeout-ms 90000
~/.kimi-code/bin/autokimi
```

如果 `~/.kimi-code/bin` 已在 PATH 中，之后直接运行 `autokimi`。上述安装会启用审核、将默认权限模式设为 Always Ask，并把总审核时限设为 90 秒。登录信息和模型配置继续共用。安装只生成独立运行包和 `autokimi` 脚本，保留官方 `kimi` 可执行文件。

进入 TUI 后：

```text
/auto-review status
/auto-review on
/auto-review model <已配置的模型别名>
/auto-review denials
/approval
/auto-review off
```

`/approval`（别名 `/approve`）列出可授权命令，Enter 将选中项从 ✗ 变为 ✓ 并发送一次授权，再按 Enter 或 Esc 关闭。`denials` 用于诊断，显式 ID 仍兼容。工具、完整参数和 cwd 必须不变且须复审；不生成永久 allow 规则。compaction、undo、session reset 或重启后旧授权失效。

**官方 `/auto` 是 Never Ask 模式，会暂停分类器。** 使用 AutoKimi 时保持 Always Ask；`/auto-review on` 会切回该模式。审核开启状态会显示在底栏。

## 源码组织

| 路径                          | 内容                                             |
| ----------------------------- | ------------------------------------------------ |
| `overlay/`                    | 新增的分类器、审核服务、TUI 命令、测试和评测工具 |
| `patches/native-review.patch` | 官方现有文件的权限入口、SDK、TUI 与配置接入改动  |
| `upstream.lock.json`          | 官方源码的精确版本、提交和构建工具版本           |
| `tools/`                      | 源码还原、构建、打包、安装与仓库检查             |
| `test/`                       | 源码还原和安装器的隔离测试                       |
| `.cache/`、`.artifacts/`      | 本地生成目录，均不进入 Git                       |

完整可构建源码由锁定的官方提交、补丁和 overlay 共同组成。仓库只保存需要维护的差异；不收录官方历史、依赖、编译产物、登录配置、会话和原始评测记录。源码体积上限为 512 KiB，单文件上限为 128 KiB。

## 文档

- [安装、更新和卸载](docs/installation.md)
- [配置、审核行为和上下文](docs/configuration.md)
- [原生接入架构](docs/architecture.md)
- [开发与上游升级](docs/development.md)
- [超时与常见问题](docs/troubleshooting.md)
- [验证范围与已知限制](docs/verification.md)

官方 `kimi` 更新不会自动改变已安装的 AutoKimi，日常构建仍固定 **2.3.0**。维护者可显式运行 `npm run follow:upstream -- --version 2.3.1` 验证候选，或在安装后使用 `autokimi update`；`update` 默认只验证并生成候选，只有显式 `--install` 才安装。`autokimi upgrade` 用于一键更新：先验证 AutoKimi 候选，官方较旧时执行官方升级并复读版本，再安装 AutoKimi 或刷新安装回执。没有后台更新；失败或部分成功会写入报告，旧 AutoKimi release 会保留。

模型审核会产生额外请求和费用，也可能误拒绝或误放行；它不是操作系统沙箱。参见[验证范围](docs/verification.md)。

基于 Moonshot AI 的 MIT 许可源码，保留其版权声明。详见 [LICENSE](LICENSE)、[LICENSE.upstream](LICENSE.upstream) 和 [NOTICE](NOTICE)。
