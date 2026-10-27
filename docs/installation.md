# 安装、更新和卸载

[English](en/installation.md) | [简体中文](installation.md)

## 一键安装

在终端执行：

```sh
curl -fsSL https://raw.githubusercontent.com/FrostNovaOrg/AutoKimi/TRUSTED_COMMIT/install.sh | sh -s -- --revision TRUSTED_COMMIT
```

安装脚本支持 macOS/Linux 的 ARM64 和 x64；macOS ARM64 已实测，Linux x64 已通过 CI 构建、回归和隔离安装，终端交互尚待实测。需要 curl、tar，源码路径还需要 Git。默认从显式可信的 AutoKimi 提交构建，Kimi 版本由锁文件固定。指定 `--version` 时才尝试对应平台运行包，并在 `SHA256SUMS` 之外验证绑定该提交的 GitHub 构建证明。下载或摘要校验失败会停止。源码构建下载精确版本的 pnpm，无须全局安装它。

缺少 Node.js ≥24.15.0 时，脚本校验官方 Node 包摘要并安装到 `<home>/autokimi/tools/`，不修改系统 Node。默认 HOME 使用 `AUTOKIMI_HOME`、`KIMI_CODE_HOME`、`~/.kimi-code`；`--home` 优先。脚本不改 shell 配置，完成后打印启动路径和需要的 PATH 命令。不要移动安装器选择的 Node 路径。

本地检出目录支持以下安装方式：

```sh
sh install.sh --source
sh install.sh --version v0.3.1 --revision TRUSTED_COMMIT
sh install.sh --package /path/to/autokimi-v0.3.1-darwin-arm64.tar.gz --sha256 TRUSTED_SHA256 --home /path/to/kimi-home
sh install.sh --timeout-ms 90000
```

`--version` 选择 AutoKimi Release 标签，指定版本没有对应平台包时会报错；加 `--source` 则构建 `--revision` 指定的提交并核对版本。`--package` 要求同目录有匹配该文件的 `SHA256SUMS`。`--source` 强制源码构建。脚本安装会启用审核并切回 Always Ask；省略 `--timeout-ms` 会保留已有时限。首次使用仍须在交互会话登录或配置模型。

## 构建并安装

先完成官方 Kimi 登录或模型配置。使用 Node.js ≥24.15.0 和 pnpm 10.33.0；若已有不同版本，可用自己的 Node 版本管理工具安装，或将 `AUTOKIMI_PNPM` 指向指定版本的 pnpm 可执行文件。

```sh
npm run build
npm run install:local -- --timeout-ms 90000
```

`build` 下载锁定的官方标签，核对提交和版本，应用补丁并构建独立的 JavaScript 运行时。它不修改或重新编译已安装的官方原生 `kimi` 可执行文件。依赖安装使用官方冻结的锁文件。

安装器默认使用 `KIMI_CODE_HOME`，未设置时使用 `~/.kimi-code`，生成：

```text
~/.kimi-code/bin/autokimi
~/.kimi-code/autokimi/releases/<release-id>/
~/.kimi-code/autokimi/installation.json
```

安装器核对官方 `kimi` 文件的前后摘要，拒绝覆盖不由它管理的同名 `autokimi`。同一配置目录的安装通过 `install.lock` 串行执行；配置、启动器和回执使用备份与原子写入，后置失败会回滚。若安装进程崩溃遗留锁文件，确认没有安装器仍在运行后再删除该文件。脚本保留工作目录和命令参数，固定安装时的配置目录，关闭该独立运行时的官方自动更新。安装需要可用的 Node；移动或删除 Node 后需重新安装脚本。

安装会通过随包携带的 SDK 合并配置：启用 `experimental.approval_review`、设置 `default_permission_mode = "manual"`。传入 `--timeout-ms` 才会修改审核时限；其他审核设置、providers、models 和登录信息保持原值。若 `config.toml` 是指向有效配置文件的符号链接，新配置会在临时 HOME 生成后原子写回真实目标，成功和回滚都保留链接。**配置与官方版共用，因此默认权限模式变动也会影响官方版下次启动。**

90 秒是两阶段合计的上限，正常返回后立即继续，不会每次等待 90 秒。省略参数会保留已有时限；没有配置时源码默认是 30 秒。

## 分开打包和安装

```sh
npm run package:runtime
node tools/install.mjs --package .artifacts/runtime --timeout-ms 90000
```

运行包包含 CLI、配置 SDK、原生预编译资源、网页资源和生产依赖，release 由整包内容、文件权限和相对链接共同决定。安装已打好的包无需重新构建或依赖原开发目录，但会重新核验完整内容。安装脚本本身仍从此仓库运行。包与具体平台相关；不要把 macOS 的可选原生依赖包直接用于 Linux。

`--prepare` 的目标必须是新目录，生成源码必须通过锁定提交、输入指纹和源码状态校验。再次打包时选择新路径，或在确认不需要旧包后自行清理。

## 维护者打包 Release

在目标系统和架构上完成构建与测试、提交源码后执行：

```sh
npm run package:release
```

该命令要求源码无未提交修改，输出 `.artifacts/release/autokimi-v<版本>-<平台>-<架构>.tar.gz` 和 `SHA256SUMS`，包含启动运行所需依赖、许可和独立安装工具。运行包与平台、架构绑定，安装器拒绝不匹配的包。重复文件名会报错，避免覆盖已经准备的产物。

将已验证的平台包及合并的 `SHA256SUMS` 手动上传至对应 `v<版本>` 的 GitHub Release 后，一键脚本即可优先使用它们。无需先启用 CI；没有发布包时仍可通过源码路径安装。

## 隔离配置或离线开发

```sh
node tools/install.mjs --package .artifacts/runtime --home .artifacts/kimi-home
```

`--home` 同时决定配置、启动脚本和运行包位置。该目录需要自己的模型配置；安装器不会复制真实登录信息进去。

复用本地官方 Git 源码可避免再次下载源码：

```sh
npm run prepare:upstream -- --source /path/to/local/kimi-code
npm run build -- --offline --store-dir /path/to/pnpm-store
```

本地源的未提交改动不会被复制。离线安装要求 pnpm 缓存完整。已经安装依赖时可用 `npm run build -- --skip-install`。`--worktree` 可指定另一份生成源码，但后续构建、测试、打包也须传入对应路径；打包器用 `--source <生成源码目录>`。

## 更新

`git pull` 后重新构建、安装。修改 overlay 或补丁后，源码准备器会拒绝复用旧缓存，避免抹掉开发改动：先保留 `.cache/kimi-code` 内需要的修改，再自行移走或删除该生成目录，重新构建。准备器不会自动清空已有目录。

官方 `kimi` 更新不影响已安装的 AutoKimi，日常仍固定自己的基线。若需由维护者显式验证某个正式版本，可运行：

```sh
npm run follow:upstream -- --version 2.3.3
```

该命令验证正式版本的 tag、npm integrity、签名与 provenance，确认它们指向同一个 commit，再在独立目录应用补丁、构建、测试和打包。不会修改根 `upstream.lock.json`，也不会自动安装。报告和 `candidate.lock.json` 位于 `.artifacts/upstream-candidates/` 下；按报告路径使用 `npm run install:local -- --lock <path>` 才会切换，只有显式 `--install` 才会在跟随流程中调用安装器。

安装后的 `autokimi update` 先从本项目固定 GitHub 仓库取得 `main` 的最新源码，再使用其中的补丁验证 Kimi 候选；默认只验证，`autokimi update --install` 才安装。`--revision <完整提交 SHA>` 可固定 AutoKimi 源码；这里的 **`--version` 选择 Kimi 基线**，与 `install.sh --version` 选择 AutoKimi Release 的含义不同。源代码检查或下载失败即停止，不回退到旧补丁。运行包额外包含 `build-kit/` 中的 overlay、补丁、构建工具、测试和文档，用于独立重建；更新工作目录位于 `KIMI_CODE_HOME/autokimi/update-work`，不写入 release。项目更新报告 `project-update.json` 记录源码身份，`runtime/report.json` 记录候选及安装状态。

`autokimi --version` 显示 AutoKimi 版本、源码提交、修改状态、源码摘要及 Kimi 版本；归档源码没有 Git 提交时会明确标记。包清单和安装回执保存同一身份信息。

`autokimi upgrade` 同样先获取最新 AutoKimi 源码，是一键更新入口，本身就表示安装意图，不需要额外的 `--install`。它先完成 AutoKimi 候选的证据、构建、测试和打包；官方版本较旧时调用官方 `kimi upgrade --yes`，并复读实际版本确认升级生效，再安装 AutoKimi。官方已经相同或更新时不重复升级，AutoKimi 更新时不降级；包内容未变化时不重复安装，官方变化后即使包相同也会重安装以刷新回执中的官方哈希。`autokimi upgrade --help` 只显示帮助，不检查版本或执行升级。

更新使用 `--home`、`AUTOKIMI_HOME`、`KIMI_CODE_HOME`、`~/.kimi-code` 依次解析 HOME；安装时加锁并重读当前版本。失败查看项目与运行时两份报告；`partial` 表示部分生效，`cleanupWarning` 表示生效后的清理或报告故障。旧 release 保留；没有后台更新。细节见 [故障排查](troubleshooting.md)。

旧版安装器不会自行取得此更新机制；首次升级需 `git pull` 后重建安装。此后 `autokimi upgrade` 才会同步本项目修复。

## 卸载

确认 `~/.kimi-code/bin/autokimi` 含 `# autokimi local launcher` 标记后，可删除该脚本及 `~/.kimi-code/autokimi/`。使用自定义 `--home` 时替换为该目录。保留官方 `kimi`、登录和会话。

共享配置中的审核开关可在卸载前用 `/auto-review off` 关闭；默认权限模式按个人需要调整。不要删除整个 `~/.kimi-code`。

## 安装信任链（0.3.1）

推荐命令固定安装脚本的完整提交，并将同一提交传给 `--revision`。脚本只下载该提交的 bootstrap，先校验预置 SHA-256，再执行；独立 Node 24.15.0 的四个平台摘要也预置在脚本中，不再把同源动态摘要当成信任根。最初选择的脚本与提交仍须来自可信来源，固定摘要不证明代码无漏洞。

默认安装从该确切 AutoKimi 提交构建，不跟随 main 或 latest。可信本地 Git 检出运行 `sh install.sh --source` 时使用当前 HEAD；未提交开发改动需按开发流程自行构建。`--version` 指定运行包时，还须提供与包构建相同的 `--revision`。使用 GitHub CLI 验证 Sigstore 构建证明，绑定仓库、`.github/workflows/release.yml`、源码提交、签名工作流提交及 GitHub 托管 runner；未签名、来源不符或验证失败不会解包执行。缺少 gh 时使用显式 `--source`。

本地包可以改用独立可信渠道取得的 `--sha256`；从同一下载位置顺手取得的 SHA256SUMS 不构成独立信任。`SHA256SUMS` 仍作传输完整性检查，不能单独授权代码执行。手动发布工作流只生成已验证、已证明的 Actions 运行包，不会自动创建 Release；本次修复未发布新二进制资产。

Linux 运行 Bash 还需要 `/usr/bin/bwrap`、`/usr/bin/socat`、`/usr/bin/rg` 及可用的用户命名空间/seccomp。缺少这些能力时仍可使用文件工具，shell 会拒绝启动。配置与外部容器下的兼容模式见[配置说明](configuration.md#shell-系统沙箱031)。
