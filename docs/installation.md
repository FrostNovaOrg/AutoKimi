# 安装、更新和卸载

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

安装器核对官方 `kimi` 文件的前后摘要，拒绝覆盖不由它管理的同名 `autokimi`。脚本保留工作目录和命令参数，固定安装时的配置目录，关闭该独立运行时的官方自动更新。安装需要可用的 Node；移动或删除 Node 后需重新安装脚本。

安装会通过随包携带的 SDK 合并配置：启用 `experimental.approval_review`、设置 `default_permission_mode = "manual"`。传入 `--timeout-ms` 才会修改审核时限；其他审核设置、providers、models 和登录信息保持原值。**配置与官方版共用，因此默认权限模式变动也会影响官方版下次启动。**

90 秒是两阶段合计的上限，正常返回后立即继续，不会每次等待 90 秒。省略参数会保留已有时限；没有配置时源码默认是 30 秒。

## 分开打包和安装

```sh
npm run package:runtime
node tools/install.mjs --package .artifacts/runtime --timeout-ms 90000
```

运行包包含 CLI、配置 SDK、原生预编译资源、网页资源和生产依赖。安装已打好的包无需重新构建或依赖原开发目录。安装脚本本身仍从此仓库运行。包与具体平台相关；不要把 macOS 的可选原生依赖包直接用于 Linux。

`--prepare` 的目标必须是新目录。再次打包时选择新路径，或在确认不需要旧包后自行清理。

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

官方 `kimi` 更新不影响已安装的 AutoKimi。AutoKimi 固定自己的基线；即使接口看似没变，也须按[上游升级流程](development.md)验证后迁移。旧运行包会保留，安装器不会自动删除历史版本。

## 卸载

确认 `~/.kimi-code/bin/autokimi` 含 `# autokimi local launcher` 标记后，可删除该脚本及 `~/.kimi-code/autokimi/`。使用自定义 `--home` 时替换为该目录。保留官方 `kimi`、登录和会话。

共享配置中的审核开关可在卸载前用 `/auto-review off` 关闭；默认权限模式按个人需要调整。不要删除整个 `~/.kimi-code`。
