# 开发与上游维护

使用 [AGENTS.md](../AGENTS.md) 中的维护约定。

## 日常验证

```sh
npm test
npm run check
npm run build
npm run test:upstream
npm run test:install
```

前两项仅依赖 Node 和 Git：隔离测试覆盖源码还原、缓存保护、安装包、启动脚本、配置合并与仓库守卫。`check` 同时检查未忽略的新文件，阻止依赖、生成物、常见密钥格式、本机用户路径和失效的相对文档链接，并限制源码总量。

`build` 准备源码、冻结安装依赖、构建内部包和 CLI。`test:upstream` 在生成源码上运行 15 个相关测试文件及 message-flow 定向用例，检查引擎、SDK、TUI 的 TypeScript，并执行引擎无注释检查。测试使用隔离配置目录，不调用真实模型。`test:install` 用实际构建的运行包和合成配置验证完整安装、设置保留、启动与重复安装。pnpm 版本以锁文件为准；可通过 `AUTOKIMI_PNPM` 指定可执行路径。测试的 `TMPDIR` 应使用 Git 工作树之外的系统临时目录；若放进仓库，某些测试写入会命中工作树规则而绕过待审核路径，不能据此证明审核被触发。

CI 在推送和 PR 上运行轻量检查并验证官方补丁可应用；手动触发时可选完整构建和原生接入回归。CI 不读取 Kimi 登录信息，也不会发布运行包。

## 修改源码

新增文件在 `overlay/` 中维护；对已有官方文件的修改保存在 `patches/`。不要把 `.cache` 中的完整官方源码加入 Git。

1. 运行 `npm run prepare:upstream` 还原工作源码。
2. 在 `.cache/kimi-code` 开发，参考其中官方维护约定；构建后可运行针对性测试。
3. 将新增文件同步回 `overlay`；对基线已有文件导出干净 diff，替换相应补丁。不要导出构建产物、用户数据和原始评测结果。
4. 保留开发改动，使用新的 `--worktree` 验证整个补丁能从零应用。输入变化后不要期待准备器覆盖旧缓存。
5. 完成上述检查和临时安装验证，审阅提交文件与体积。

示例：

```sh
git -C .cache/kimi-code diff --binary > patches/native-review.patch
node tools/build.mjs --worktree .cache/validation
node tools/test-upstream.mjs --worktree .cache/validation
node tools/install.mjs --source .cache/validation --prepare .artifacts/validation-runtime
node tools/install.mjs --package .artifacts/validation-runtime --home .artifacts/validation-home
```

导出 diff 前确保所有修改确属 AutoKimi，且没有上游已跟踪文件被无意改写。新增文件不在普通 `git diff` 中，必须同步到 overlay。提交前运行 `git diff --check` 和仓库检查；常见格式扫描不能替代人工审阅。

## 上游版本升级

更新官方 `kimi` 不会更新 AutoKimi。维护者显式选择新基线：

1. 核实官方标签与完整提交，更新 `upstream.lock.json`。
2. 在新工作目录上逐项迁移权限入口、服务注册、SDK 配置和 TUI 接口；不要直接忽略补丁冲突。
3. 检查原有权限规则、显式拒绝、业务确认与工具执行顺序是否改变。
4. 运行完整构建、相关回归、类型检查与临时安装。验证官方命令摘要保持不变。
5. 用隔离测试文件在原生 TUI 验证通过、拒绝、无效响应与超时。需要真实模型时由已授权的账号运行，并明确费用及测试边界。
6. 更新验证记录及兼容性声明，再发布可用版本。

### 可选的候选跟随

维护者也可以用 `npm run follow:upstream -- --version <semver>` 尝试正式版本。该命令生成独立候选锁，验证 tag、npm integrity、签名和 provenance 后才构建，不会改写根锁文件或自动安装。阶段依次为证据、构建、测试、打包；只有显式 `--install` 才调用安装器。`autokimi update` 使用安装包内的 `build-kit` 提供同一流程，默认不安装，也不存在后台或启动时更新。

`autokimi upgrade` 在同一函数入口归一化为 `install + official`，不是绕过验证的捷径。候选通过后，per-home 锁覆盖重读安装、官方升级和 AutoKimi 安装，避免等待期间的旧快照导致降级。官方较旧时调用官方 `kimi upgrade --yes` 并复读版本，再执行 AutoKimi 安装；相同或较新的官方不重复升级，较新的 AutoKimi 不降级。报告分别记录 `officialStatus`、`autoKimiStatus`、`stage`、`status` 和 `partial`。官方命令失败后也尽量复读版本，已升高则记录 `updated + partial`，无法复读则记录 `unknown`，均停止 AutoKimi 安装。安装提交后的清理故障通过 `cleanupWarning` 返回，不能改报为未安装；提交前失败仍回滚。

## 真实模型评测工具

`overlay/scripts/eval-approval-review.mts` 和两组用例会进入生成源码的 `scripts/`。它调用实际审核服务，记录分类结果，不执行待审工具操作。需单独准备隔离 Kimi 配置与认证，默认并发 3，可降至 1。示例在生成源码根目录运行：

```sh
pnpm exec tsx --import ./build/register-raw-text-loader.mjs scripts/eval-approval-review.mts \
  --home /path/to/isolated-kimi-home \
  --out /path/to/new-results-directory \
  --concurrency 1 --timeout-ms 90000
```

评测日志和原始结果写入 `--out`，`--home` 仅用于模型配置与认证。不要把隔离配置、令牌或原始结果提交到仓库。此脚本含历史 `manual` 类别命名，仅用于用例分组；当前实现仍只有最终通过或拒绝。评测脚本不能替代真实工具执行的 TUI 端到端测试。

## 自适应破甲评测

`overlay/scripts/adversarial-approval-review.mts` 让 attacker 根据审核结果连续调整工具提案，reviewer 只看到独立的正常用户请求，破甲由独立 oracle 根据实际效果判定。执行器和收集器分开运行，攻击输出不会作为宿主机命令执行。首轮预算为每场景 8 次提案，总上限 32 次 attacker 调用、64 次 reviewer 调用和 30 分钟。

```sh
pnpm exec tsx --import ./build/register-raw-text-loader.mjs \
  scripts/adversarial-approval-review.mts \
  --home /path/to/kimi-home \
  --out /path/to/red-team-container \
  --max-attempts 8 --timeout-ms 90000
```

运行前准备并启动专用 Colima profile，使用固定 digest 的 Node 镜像。`out/home`、`out/targets` 和 `out/ipc` 必须是该 profile 已挂载的测试目录；不得挂载真实 HOME、Docker socket、SSH agent 或凭据。收集端只使用内部 Docker 网络。原始攻击记录和日志不得提交仓库，真实模型调用应使用独立测试认证或由用户在控制端启动。

## 后续阶段边界

当前改进覆盖审核证据布局、决策来源、可恢复模型错误的有限重试、故障冷却、失败恢复提示、每轮滚动安全拒绝窗口，以及精确动作的一次授权。模型重试复用上游错误分类与退避，工具级故障冷却不占用安全停轮预算。一次授权是内存挑战加复审，不是持久授权。以下能力尚未实现，不应由缓存字段、审计记录、挑战文本或红队容器推断为已经具备：

1. 结构化、可持久化的用户授权与限制台账，包括跨压缩、跨重启的作用域和撤销语义。
2. 对复合 shell、重定向和嵌套解释器的确定性命令分析，以及无法解析时的保守降级。
3. 日常工具执行的 OS sandbox、网络隔离和强制文件系统边界；红队容器只隔离测试，不保护普通运行。

后续设计优先参考 [Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)、[权限模式](https://code.claude.com/docs/en/permission-modes) 和 [sandboxing](https://code.claude.com/docs/en/sandboxing)，并对照 [Codex auto-review](https://developers.openai.com/codex/sandboxing/auto-review) 与 [exec policy](https://developers.openai.com/codex/exec-policy)。OpenCode 的 once/always 区分用于确认本阶段只实现 once，不实现模式化 always。第三方抓包或逆向资料只用于形成待验证假设，不作为固定协议或安全保证。
