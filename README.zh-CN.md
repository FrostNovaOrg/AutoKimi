# AutoKimi

[English](README.md) | [简体中文](README.zh-CN.md)

为 Kimi Code 原生 TUI 和可观察的无头任务提供模型权限审核。

[MIT](LICENSE) · [安装](docs/installation.md) · [配置](docs/configuration.md) · [架构](docs/architecture.md) · [贡献](docs/CONTRIBUTING.md)

为 Kimi Code 原生 TUI 增加基于模型的自动权限审核。保留官方 `kimi` 命令，使用独立的 `autokimi` 启动带审核功能的运行时。

当工具操作进入待审批状态时，审核器依据用户授权和具体操作返回 **通过或拒绝**。不确定、超时或审核失败均拒绝，并说明原因；不会自动回退到人工批准。可恢复的模型服务错误会自动退避重试，连续工具级基础设施故障进入短暂冷却；只有连续或累计的安全拒绝会停止当前轮次。

**AutoKimi 是独立维护的 MIT 开源项目，不属于 Moonshot AI 官方发行版。** 这是基于官方源码的轻量补丁项目。当前固定 Kimi Code **2.3.3**，使用已有 Kimi 登录、provider 和模型配置。它通过引擎权限入口和 SDK 接入原生 TUI，需要独立的 JavaScript 运行时；启动脚本负责选择该运行时。

## 能力与边界

- 默认隔离 Bash 的文件写入及网络访问；无沙箱时拒绝执行，不自动降级。
- 在原生终端交互中审核待审批工具，支持两阶段判断、服务故障退避和审计。
- 对符合条件的模型拒绝提供一次精确重试；完整详情和默认取消的二次确认防止误授权。
- 提供面向代理编排的无头任务：JSONL 事件、幂等提交、累计预算、取消和原生上下文续跑。
- 可单独选择审核模型、provider 和接口地址，默认跟随当前代理模型。
- 固定上游提交、冻结依赖与补丁重建，独立安装、更新及保留旧运行包。

TUI 中原有 allow/deny 规则先执行，审核器接收待审批操作。无头 `exec` 进一步让副作用工具经过审核，同时保留原生拒绝及有限只读工具集。模型可能误判。0.3.1 默认将 Bash 及子进程放入 Anthropic 的系统沙箱，文件工具和 MCP 仍使用各自权限边界。ACP 和 Web 服务请使用原生 Kimi。

| 项目                 | 当前状态                                     |
| -------------------- | -------------------------------------------- |
| AutoKimi / Kimi Code | 0.3.1 / 2.3.3                                |
| 构建依赖             | Node.js ≥24.15.0；pnpm 10.33.0               |
| 已实测               | macOS ARM64：构建、TUI 回归及两种安装路径    |
| 待验证               | Linux 终端交互及其他平台组合；Windows 不支持 |

Linux x64 CI 已通过构建、回归和隔离安装检查，详见[验证记录](docs/verification.md)。

Linux shell 还要求主机允许沙箱创建所需用户命名空间。Ubuntu 24.04+ 的限制可能需要管理员配置，见[故障排查](docs/troubleshooting.md)。

## 安装

已在 macOS ARM64 上验证；安装器支持 macOS/Linux 的 ARM64、x64，Linux x64 已通过 CI 检查。一键安装：

```sh
curl -fsSL https://raw.githubusercontent.com/FrostNovaOrg/AutoKimi/30e5c1d5ca21fe1289e902fd9158c07f4f40828a/install.sh | sh -s -- --revision 30e5c1d5ca21fe1289e902fd9158c07f4f40828a
```

一键命令固定安装脚本及 AutoKimi 提交，并从固定 Kimi 基线构建；不再自动执行可变 main。指定 `--version` 获取运行包时，必须通过绑定仓库、工作流和提交的 GitHub 构建证明；本地包须提供独立可信的 `--sha256`。需要 curl 和 tar；源码构建还需要 Git，会下载精确版本的 pnpm，首次构建可能占用数 GB。缺少 Node.js ≥24.15.0 时，脚本将 Node 安装到 AutoKimi 独立目录。安装后显示启动命令和 PATH 指引。Linux 的 shell 沙箱需要 `/usr/bin/bwrap`、`/usr/bin/socat` 和 `/usr/bin/rg`，Debian/Ubuntu 可安装 `bubblewrap socat ripgrep`。macOS 使用系统 Seatbelt。

已有源码时，在检出目录运行 `sh install.sh --source`。也可手动构建安装：

```sh
git clone https://github.com/FrostNovaOrg/AutoKimi.git
cd AutoKimi
git checkout --detach 30e5c1d5ca21fe1289e902fd9158c07f4f40828a
npm run build
npm run install:local -- --timeout-ms 90000
~/.kimi-code/bin/autokimi
```

手动构建需要 Node.js ≥24.15.0 和 pnpm **10.33.0**。安装启用审核并将默认权限模式设为 Always Ask；一键脚本保留已有审核时限，传入 `--timeout-ms 90000` 才设置为 90 秒。登录和模型配置继续共用，官方 `kimi` 可执行文件保留。

首次使用运行 `/login`，或通过 `/provider` 添加服务并用 `/model` 选择模型；已有 Kimi 配置可直接复用。共享配置中的默认权限模式改动也影响原生 Kimi 下次启动。

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

主代理和自动化通过显式无头入口调用：

```sh
autokimi exec --prompt-file task.txt --cwd /path/to/project --max-steps 30 --detach
autokimi runs status <run-id> --json
autokimi runs events <run-id> --after 0
autokimi runs stop <run-id>
```

任务强制自动审核，预算由调用者持有。`--resume <run-id>` 保留累计计数并续跑原生上下文；`--session <session-id>` 在已有上下文中开启新任务。权限拒绝会明确标记为未完整完成，接入前请阅读[无头协议](docs/headless.md)。原生根命令 `-p/--prompt`、无终端启动 TUI 和 ACP/Web 服务继续禁止。

**官方 `/auto` 是 Never Ask 模式，会暂停分类器。** 使用 AutoKimi 时保持 Always Ask；`/auto-review on` 会切回该模式。审核开启状态会显示在底栏。

## 源码组织

`upstream.lock.json` 固定官方提交，`overlay/` 保存新增源码，`patches/` 修改既有文件，`tools/` 完成准备、构建和安装。仓库只维护差异，不收录完整上游历史、依赖、运行包、登录配置或会话；生成目录 `.cache/`、`.artifacts/` 不入 Git。开发步骤见 [开发文档](docs/development.md)。

## 文档

- [安装、更新和卸载](docs/installation.md)
- [配置、审核行为和上下文](docs/configuration.md)
- [无头任务与编排接入](docs/headless.md)
- [原生接入架构](docs/architecture.md)
- [开发与上游升级](docs/development.md)
- [超时与常见问题](docs/troubleshooting.md)
- [验证范围与已知限制](docs/verification.md)
- [贡献与问题反馈](docs/CONTRIBUTING.md)
- [安全政策](docs/SECURITY.md)

日常构建固定 Kimi **2.3.3**，MCP SDK **1.32.2**。`autokimi update` 获取最新项目源码并验证候选，`--install` 才安装；`autokimi upgrade` 还可能升级官方 `kimi`。`autokimi --version` 显示项目及源码身份。详见 [更新说明](docs/installation.md#更新)。

审核调用使用所选 provider，会产生额外请求和费用，也可能误拒绝或误放行；模型审核与 Bash 系统沙箱分别生效，文件工具及 MCP 不受 shell 沙箱约束。参见[验证范围](docs/verification.md)。

基于 Moonshot AI 的 MIT 许可源码，保留其版权声明。详见 [LICENSE](LICENSE)、[LICENSE.upstream](LICENSE.upstream) 和 [NOTICE](NOTICE)。
