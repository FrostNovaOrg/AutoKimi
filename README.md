# AutoKimi

为 Kimi Code 原生 TUI 增加模型权限审核。保留官方 `kimi` 命令，使用独立的 `autokimi` 启动带审核功能的运行时。

当工具操作进入待审批状态时，审核器依据用户授权和具体操作返回 **通过或拒绝**。不确定、超时或审核失败均拒绝，并说明原因；不会转交人工批准。可恢复的模型服务错误会自动退避重试，连续工具级基础设施故障进入短暂冷却；只有连续或累计的安全拒绝会停止当前轮次。

这是基于官方源码的轻量补丁项目。当前固定 Kimi Code **2.3.3**，使用已有 Kimi 登录、provider 和模型配置。它通过引擎权限入口和 SDK 接入原生 TUI，需要独立的 JavaScript 运行时；启动脚本负责选择该运行时。

## 安装

已在 macOS ARM64 上验证；安装器支持 macOS/Linux 的 ARM64、x64，其他组合尚待实测。仓库公开后可一键安装：

```sh
curl -fsSL https://raw.githubusercontent.com/FrostNovaOrg/AutoKimi/main/install.sh | sh
```

安装脚本优先下载当前平台的 Release 包并核对 SHA-256；没有发布包时自动从固定的 Kimi 基线构建。需要 curl 和 tar；源码构建还需要 Git，会下载精确版本的 pnpm，首次构建可能占用数 GB。缺少 Node.js ≥24.15.0 时，脚本将 Node 安装到 AutoKimi 独立目录。安装后显示启动命令和 PATH 指引。

私有阶段或已有源码时，在有访问权限的检出目录运行 `sh install.sh --source`。手动构建安装仍可用：

```sh
git clone https://github.com/FrostNovaOrg/AutoKimi.git
cd AutoKimi
npm run build
npm run install:local -- --timeout-ms 90000
~/.kimi-code/bin/autokimi
```

手动构建需要 Node.js ≥24.15.0 和 pnpm **10.33.0**。安装启用审核并将默认权限模式设为 Always Ask；一键脚本保留已有审核时限，传入 `--timeout-ms 90000` 才设置为 90 秒。登录和模型配置继续共用，官方 `kimi` 可执行文件保留。

进入 TUI 后：

```text
/auto-review status
/auto-review on
/auto-review model <已配置的模型别名>
/auto-review denials
/approval
/auto-review off
```

`/auto-review` 打开设置菜单；开关作用于当前会话，无会话时修改全局默认，审核模型是共享设置。`/auto-review model` 可选择已配置模型或跟随当前会话模型。

`/approval`（别名 `/approve`）先列出可授权命令，Enter 查看完整参数、工作目录和原因。详情默认选择取消；滚动到末尾后，Tab 选择“Approve this action once”，再 Enter 才发送。连续回车和空格均不会授权，Esc 在发送前取消。提交成功后自动返回输入框，失败保留重试入口。`denials` 用于诊断，显式 ID 入口也须经过同样确认。完整工具、参数和 cwd 必须不变且须复审；不生成永久 allow 规则，旧授权在压缩、撤销、重置或重启后失效。

**仅支持交互终端会话。** `autokimi` 禁止 `-p/--prompt`、无终端启动及 ACP/Web 服务；自动化请使用原生 `kimi`。帮助、版本和更新命令可在非交互环境使用。

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

完整可构建源码由锁定的官方提交、补丁和 overlay 共同组成。仓库只保存需要维护的差异；不收录官方历史、依赖、编译产物、登录配置、会话和原始评测记录。源码体积上限为 608 KiB，单文件上限为 128 KiB。

## 文档

- [安装、更新和卸载](docs/installation.md)
- [配置、审核行为和上下文](docs/configuration.md)
- [原生接入架构](docs/architecture.md)
- [开发与上游升级](docs/development.md)
- [超时与常见问题](docs/troubleshooting.md)
- [验证范围与已知限制](docs/verification.md)

日常构建固定 Kimi **2.3.3**，MCP SDK 固定 **1.32.2**。`autokimi update` 取得本项目最新源码并验证候选，`--install` 才安装；`autokimi upgrade` 同步项目修复并执行完整升级。`autokimi --version` 显示项目版本和源码身份。首次启用此更新机制须从 Git 重建安装；详见 [更新说明](docs/installation.md#更新)。

模型审核会产生额外请求和费用，也可能误拒绝或误放行；它不是操作系统沙箱。参见[验证范围](docs/verification.md)。

基于 Moonshot AI 的 MIT 许可源码，保留其版权声明。详见 [LICENSE](LICENSE)、[LICENSE.upstream](LICENSE.upstream) 和 [NOTICE](NOTICE)。
