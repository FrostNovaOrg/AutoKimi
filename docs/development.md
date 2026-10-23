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

`build` 准备源码、冻结安装依赖、构建内部包和 CLI。`test:upstream` 在生成源码上运行 13 个相关测试文件，检查引擎、SDK、TUI 的 TypeScript，并执行引擎无注释检查。测试使用隔离配置目录，不调用真实模型。`test:install` 用实际构建的运行包和合成配置验证完整安装、设置保留、启动与重复安装。pnpm 版本以锁文件为准；可通过 `AUTOKIMI_PNPM` 指定可执行路径。

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

## 真实模型评测工具

`overlay/scripts/eval-approval-review.mts` 和两组用例会进入生成源码的 `scripts/`。它调用实际审核服务，记录分类结果，不执行待审工具操作。需单独准备隔离 Kimi 配置与认证，默认并发 3，可降至 1。示例在生成源码根目录运行：

```sh
pnpm exec tsx scripts/eval-approval-review.mts \
  --home /path/to/isolated-kimi-home \
  --out /path/to/new-results-directory \
  --concurrency 1 --timeout-ms 90000
```

不要把隔离配置、令牌或原始结果提交到仓库。此脚本含历史 `manual` 类别命名，仅用于用例分组；当前实现仍只有最终通过或拒绝。评测脚本不能替代真实工具执行的 TUI 端到端测试。
