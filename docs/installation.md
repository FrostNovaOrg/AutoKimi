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

官方 `kimi` 更新不影响已安装的 AutoKimi，日常仍固定自己的基线。若需由维护者显式尝试新版本，可运行：

```sh
npm run follow:upstream -- --version 2.3.1
```

该命令验证正式版本的 tag、npm integrity、签名与 provenance，确认它们指向同一个 commit，再在独立目录应用补丁、构建、测试和打包。不会修改根 `upstream.lock.json`，也不会自动安装。报告和 `candidate.lock.json` 位于 `.artifacts/upstream-candidates/` 下；按报告路径使用 `npm run install:local -- --lock <path>` 才会切换，只有显式 `--install` 才会在跟随流程中调用安装器。

安装后的 `autokimi update` 是同样的可选入口：默认只验证，`autokimi update --install` 才安装。运行包额外包含 `build-kit/` 中的 overlay、补丁、构建工具、测试和文档，用于独立重建；更新工作目录位于 `KIMI_CODE_HOME/autokimi/update-work`，不写入 release。

`autokimi upgrade` 是一键更新入口，本身就表示安装意图，不需要额外的 `--install`。它先完成 AutoKimi 候选的证据、构建、测试和打包；官方版本较旧时调用官方 `kimi upgrade --yes`，并复读实际版本确认升级生效，再安装 AutoKimi。官方已经相同或更新时不重复升级，AutoKimi 更新时不降级；包内容未变化时不重复安装，官方变化后即使包相同也会重安装以刷新回执中的官方哈希。`autokimi upgrade --help` 只显示帮助，不检查版本或执行升级。

跟随流程的 HOME 依次使用命令行 `--home`、`AUTOKIMI_HOME`、`KIMI_CODE_HOME`，最后才是 `~/.kimi-code`。生成候选后，per-home 安装锁覆盖重新读取当前安装、官方升级和 AutoKimi 安装；后取得锁的流程重新读取版本，避免用等待前的旧快照降级。直接安装旧包的显式维护操作不受这个跟随流程的版本比较限制。

发布证据、补丁、构建或测试失败都会停止并报告，当前 launcher 和 release 不变。官方升级命令即使返回错误也会尝试复读版本：版本已升高则记录 `officialStatus=updated` 和 `partial`，版本复读失败则记录 `unknown`，不谎称版本未变；这些情况都不继续安装 AutoKimi。官方已升级但 AutoKimi 安装失败也会报告 `partial`，不能视为完整成功。临时目录或锁清理失败发生在提交后时，安装回执和升级报告返回 `cleanupWarning`，不会把已生效安装改报为失败；仍须人工检查残留。旧运行包会保留，安装器不会自动删除历史版本。其他启动参数仍直接进入官方运行时，没有后台任务、启动检查或定时更新。

## 卸载

确认 `~/.kimi-code/bin/autokimi` 含 `# autokimi local launcher` 标记后，可删除该脚本及 `~/.kimi-code/autokimi/`。使用自定义 `--home` 时替换为该目录。保留官方 `kimi`、登录和会话。

共享配置中的审核开关可在卸载前用 `/auto-review off` 关闭；默认权限模式按个人需要调整。不要删除整个 `~/.kimi-code`。
