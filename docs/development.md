# 开发与上游维护

[English](en/development.md) | [简体中文](development.md)

使用 [AGENTS.md](../AGENTS.md) 中的维护约定。

## 日常验证

```sh
npm test
npm run check
npm run check:history
npm run build
npm run test:upstream
npm run test:install
npm run test:headless
```

前两项仅依赖 Node 和 Git：隔离测试覆盖源码还原、缓存保护、安装包、启动脚本、配置合并与仓库守卫。`check` 同时检查未忽略的新文件，阻止依赖、生成物、常见密钥格式、本机用户路径和失效的相对文档链接，并限制源码总量。

`build` 准备源码、冻结安装依赖、构建内部包和 CLI。`test:upstream` 在生成源码上运行审核、CLI、MCP OAuth、上游模型设置等相关测试文件及 message-flow 定向用例，检查引擎、SDK、TUI 的 TypeScript，并执行引擎无注释检查。测试使用隔离配置目录，不调用真实模型。`test:install` 用实际构建的运行包和合成配置验证完整安装、设置保留、启动与重复安装。pnpm 版本以锁文件为准；可通过 `AUTOKIMI_PNPM` 指定可执行路径。测试的 `TMPDIR` 应使用 Git 工作树之外的系统临时目录；若放进仓库，某些测试写入会命中工作树规则而绕过待审核路径，不能据此证明审核被触发。

仓库配置了推送和 PR 的轻量 CI 检查及补丁应用验证，手动触发可选完整构建和原生接入回归。GitHub Actions 已在 Linux x64 上通过完整工作流，详见[验证记录](verification.md)。CI 不读取 Kimi 登录信息，也不会发布运行包。

## 修改源码

新增文件在 `overlay/` 中维护；对已有官方文件的修改保存在 `patches/`。不要把 `.cache` 中的完整官方源码加入 Git。

1. 运行 `npm run prepare:upstream` 还原工作源码。
2. 在 `.cache/kimi-code` 开发，参考其中官方维护约定；构建后可运行针对性测试。
3. 将新增文件同步回 `overlay`；对基线已有文件导出干净 diff，替换相应补丁。不要导出构建产物、用户数据和原始评测结果。
4. 保留开发改动，使用新的 `--worktree` 验证整个补丁能从零应用。输入变化后不要期待准备器覆盖旧缓存。
5. 完成上述检查和临时安装验证，审阅提交文件与体积。

更新 overlay 和补丁后，使用以下命令验证：

```sh
node tools/build.mjs --worktree .cache/validation
node tools/test-upstream.mjs --worktree .cache/validation
node tools/install.mjs --source .cache/validation --prepare .artifacts/validation-runtime
node tools/install.mjs --package .artifacts/validation-runtime --home .artifacts/validation-home
```

每个补丁应导出其负责的全部既有文件，并保留原有补丁中的未修改部分。不要将整个生成目录的 diff 覆盖到单个补丁，以免混入其他补丁或丢失已有修改。导出前确认没有上游已跟踪文件被无意改写。新增文件不在普通 `git diff` 中，必须同步到 overlay。提交前运行 `git diff --check` 和仓库检查；常见格式扫描不能替代人工审阅。

## 上游版本升级

更新官方 `kimi` 不会更新 AutoKimi。维护者显式选择新基线：

1. 核实官方标签与完整提交，更新 `upstream.lock.json`。
2. 在新工作目录上逐项迁移权限入口、服务注册、SDK 配置和 TUI 接口；不要直接忽略补丁冲突。
3. 检查原有权限规则、显式拒绝、业务确认与工具执行顺序是否改变。
4. 运行完整构建、相关回归、类型检查与临时安装。验证官方命令摘要保持不变。
5. 用隔离测试文件在原生 TUI 验证通过、拒绝、无效响应与超时。需要真实模型时由已授权的账号运行，并明确费用及测试边界。
6. 更新验证记录及兼容性声明，再发布可用版本。

### 可选的候选跟随

候选更新、项目源码获取、安装回执和失败状态见 [安装说明](installation.md#更新)。

源码预算为 896 KiB，覆盖冻结依赖补丁、TUI 确认、安装回归及中英文文档；缓存、依赖和运行包仍不得入库。

## 发布前的仓库审计

在完整 Git 检出中运行 `npm run check:history`，扫描所有可达分支和标签的提交、历史文件与常见敏感格式；浅克隆会被拒绝。可追加 `-- --pattern MODEL_IDENTIFIER` 检查某个标识，匹配忽略大小写；`--all-objects` 额外包含本地不可达对象。工具只报告对象、路径和规则，不输出文件正文。历史检查不代表远端缓存或其他副本已被清理。

发布前另用全新 mirror 克隆核验远端 refs，并复核 GitHub 描述、Topics、Issue/PR 和附件。运行包、用户配置、凭据、会话和原始评测不得入 Git。若发现真实凭据，应先撤销，再评估历史清理；不要只删除当前文件。

当前源码保持 npm 的 `private: true` 以防误发布，不影响 GitHub 开源。发布产物流程见 [安装文档](installation.md#维护者打包-release)。平台未实测的部分需如实说明；CI 的实际运行结果须另行核实，不得用本地结果代替。

`test:headless` 使用实际安装包和本地模拟模型服务，验证幂等、事件游标、真实文件工具审核、权限拒绝、累计预算续跑、取消与子进程清理、输入阻塞和 worker 崩溃恢复，不调用真实付费模型。手动完整 CI 同时运行此烟测。

安全修复回归还覆盖本地文件后端、受保护路径发现和评测脚本。`test:headless` 使用始终允许的合成审核服务验证实际 shell 的配置写入、变量拆分链接、嵌套解释器和网络限制。Linux 集成 CI 安装 bubblewrap、socat 和 ripgrep。发布者可手动运行 `release.yml` 生成带 GitHub 构建证明的归档；工作流不自动发布 Release，安装者须绑定实际构建提交。
