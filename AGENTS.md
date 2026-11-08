# SaveHub 桌面运行

- Windows 下运行 Electron GUI（`dev`、`start`、桌面 E2E、便携版验收、图标渲染）时，使用工具提供的沙箱外执行权限 `sandbox_permissions: require_escalated`；按当前会话的审批策略执行，不要先在 Codex 沙箱中试启动。
- 使用项目入口：`node scripts/dev.mjs`、`node scripts/start.mjs` 以及 `scripts/` 中的测试脚本。不要直接运行 `electron .`、`electron/cli.js` 或绕过 `desktop-environment.mjs` 的检查。
- 本机 Codex Windows 沙箱账户启动 Electron 曾在 `install_dir_access.cc` 触发 `0x80000003` 原生崩溃；`DESKTOP_LAUNCH_REQUIRES_HOST` 表示进程尚未启动，应通过获准的桌面执行环境重跑。
- 不用 `--no-sandbox`、`sandbox: false` 或修改系统 / 用户目录 ACL 绕过问题。保持 Electron 的 `contextIsolation: true`、`sandbox: true` 和 `nodeIntegration: false`。
- GUI 验证使用 `.test-data` 下的独立临时资料库，只清理本轮创建的测试进程和目录。
- 构建、类型检查、lint 和 Node 单元测试仍可在工具沙箱内运行。
