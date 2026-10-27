# 贡献与问题反馈

[English](en/CONTRIBUTING.md) | [简体中文](CONTRIBUTING.md)

欢迎报告缺陷、完善文档及提交修复。开始前阅读 [维护约定](../AGENTS.md) 和 [开发流程](development.md)。安全问题请按 [安全政策](SECURITY.md) 处理。

## 报告问题

通过 [GitHub Issues](https://github.com/FrostNovaOrg/AutoKimi/issues) 提供系统、CPU 架构、终端、Node 版本、`autokimi --version`、脱敏配置和最小复现步骤。说明是否来自源码构建或 Release 包。不要附上 API key、OAuth 数据、完整会话、原始审计或真实任务内容。

审核误判反馈使用可公开的合成请求、工具参数与预期授权范围，注明 provider、模型及审核设置。模型输出含不可信内容，单个通过用例不能证明普遍安全；不要对真实数据运行破坏性复现。

## 提交修改

- 新增上游源码放 `overlay/`，修改已有上游文件用 `patches/`；不要提交整个上游检出或生成包。
- 固定精确上游版本，保持 TUI 通过 SDK 接入和官方 `kimi` 的独立性。
- 保留真实权限边界，运行时修复须有覆盖该行为的测试；验证命令和范围写入变更说明。
- 提交前运行 `npm test`、`npm run check` 和 `npm run check:history`；运行时修改另执行构建、相关上游测试及隔离安装。
- 修改 TUI 时遵循上游 `write-tui` 规范，检查窄终端、完整参数、Kitty 按键和取消路径。

使用 MIT 许可贡献，并保留第三方版权与许可。版本更新须同时检查锁文件、文档和平台验证声明。

## 文档语言

默认 [README](../README.md) 使用英文，[简体中文入口](../README.zh-CN.md) 提供完整中文说明。技术文档的中文原文位于 `docs/`，对应英文版位于 `docs/en/`；修改功能、命令或限制时同步更新两种语言，保留语言切换链接。CLI 命令、配置键与实际界面按钮名称不翻译。`npm test` 会检查语言覆盖、文档导航与相对链接锚点。
