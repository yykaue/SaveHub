# SaveHub 1.1.5 整改执行结果

执行与核验日期：2026-11-04—2026-11-05（Asia/Shanghai）。

依据：[整改复核与后续优化清单](savehub_review_followup.md)，包括该文档第 1.1 节的最终恢复点规则、第 1.2 节的 **20 MiB** 分类日志要求，以及 Windows x64 / macOS Apple Silicon arm64 的支持范围。

本轮沿用中断前的工作区，基线提交为 `5d74950`。先核对 Git 状态、未提交改动、测试日志和实际产物，再继续未完成的验证与收尾；没有重新初始化工程、覆盖已完成修改或重写历史 1.1.4 发行物。当前源码和文档修改仍在工作区，未提交、未打标签、未推送或发布 Release。

## 1. 执行结论

已实施双队列保留与找回约束、20 MiB 分类日志、事务与损坏隔离修复、摘要缓存和流式复制、界面及模块拆分、共享契约与文案、测试去重和分层 CI。Windows 1.1.5 的安装包、便携包与完整解包目录已重新生成，实际包、便携启动、静默安装后的运行及卸载均经过本轮验证。

**仍有平台验证边界**：本机是 Windows；macOS Apple Silicon 的实际 APFS 两种大小写模式、DMG/ZIP、签名及公证没有在本轮运行。相应脚本和 CI 已配置，不能据此记为实机通过。远端 GitHub Actions 和 draft Release 也未触发。Windows 安装测试采用静默模式，未逐页操作安装向导。

## 2. 最终产品行为

### 2.1 恢复点保留与找回

| 项目 | 实现行为 |
| --- | --- |
| 默认值 | 每个游戏读档恢复点 5 条，已移除恢复点 15 条 |
| 设置范围 | 两项全局设置；每个游戏分别覆盖或继承。显式 `0` 与继承状态分开 |
| 输入校验 | 前后端拒绝负数、小数、空值、非有限数和超出安全整数的值 |
| 淘汰依据 | 记录的 `updatedAt` 从早到晚；相同时间使用稳定次序，保留 `createdAt` 历史信息 |
| 流转 | 活动队列超额先软移除；已移除队列超额再物理删除，无额外确认、提醒或成功提示 |
| `0` 的含义 | 对应队列不保留记录；活动上限为 0 时，单个、所选和全部找回均禁用 |
| 找回数量 | 生效活动上限 N > 0 且本批 K ≤ N；校验的是整批数量，不是空余位置 |
| 超限批次 | UI 提示并禁止继续；后端写入前再次校验，拒绝时无部分更新 |
| 成功找回 | 批内统一使用当前时间更新 `updatedAt`，保留创建时间，完成批次后统一清理两队列 |
| 满额找回 | 仍可找回合法批次，随后移除修改时间最早的超额活动记录 |
| 计数口径 | 所有恢复点均计数，收藏与保护不豁免自动容量规则；普通存档不受该策略影响 |
| 事务安全 | 即使 0/0，也先保留读档安全副本；提交或回滚完成后才清理，物理删除意图持久化并可在重启后重试 |

旧库缺少新设置时采用 5/15，旧 `maxRestorePoints` 不再沿用。旧记录缺少 `updatedAt` 时以合法创建时间作为固定兼容值，之后写入持久化，不以每次读取时间替代。配置、manifest 及导出索引版本保持原兼容格式；导入导出往返测试继续覆盖。

损坏事务所属游戏可确认时，限制该游戏写入并暂缓其自动清理；无法识别所属游戏时，保留证据并暂缓所有游戏的恢复点自动清理，重启后也不误删可能仍被事务依赖的安全副本。该异常保护优先于正常保留上限，不应为了立即满足数量设置而删除恢复现场。

### 2.2 日志、平台和首次使用

- 运行日志位于 `userData/logs/<类型>/<操作>.jsonl`，类型为 info / warn / error，操作涵盖启动、存读档、导入导出、找回、清理、配置及恢复。操作 ID 关联各阶段和不同类型记录。
- 所有分类及旧日志迁移后的内容共用 **20,971,520 字节**上限，按 UTF-8 字节和全局记录顺序淘汰最早完整记录。写入与裁剪串行；单条详情有大小限制。日志失败不会改变已提交的存读档结果。
- `transactions/`、`import-transactions/` 是恢复业务状态，不参与运行日志淘汰。设置页提供“打开日志目录”。
- 系统目标只包含 Windows x64 与 macOS arm64，没有 Intel Mac / universal 构建。
- 新库为空，添加游戏时可选三个模板或从空白开始；模板不注入作者本机路径，应用不自动读取桌面脚本。设置页的已移除游戏入口跳转到统一“全部游戏”页面。

## 3. F01—F09 处理结果

| 编号 | 已执行改动 | 验证与边界 |
| --- | --- | --- |
| F01 | 在恢复事务中明确提交边界；提交后清理失败独立记录，不再进入文件替换回滚 | 原目标存在、不存在两种注入失败均保持已提交内容；0 值策略仍先生成并校验安全副本 |
| F02 | 活动超额软移除；物理删除复用持久化 purge 流程，避免嵌套 exclusive 锁 | 0/15、5/0、0/0、标记计数、部分文件已删后中断与重启清理通过 |
| F03 | 0 剩余空间拒绝；同卷合并 safety / stage 峰值预算，跨卷分别检查；statfs 失败显式报错 | 零空间、阈值以下、恰好阈值、阈值以上、同/跨卷及 statfs 失败均有注入测试。余量保持 5% + 64 KiB，属于预检，不替代 ENOSPC 回滚 |
| F04 | 对恢复和覆盖导入日志进行 schema、路径和状态验证，损坏与恢复 I/O 失败分别处理；提供 `.previous` 显式恢复选项 | 保留现场、限制受影响游戏写入；未知归属的损坏日志在多次重启后仍保留安全副本。资料库不会静默重置为空 |
| F05 | 隔离使用时间戳加 UUID；移动失败保留原文件，记录真实路径及原因 | 同名旧证据保留、注入隔离 EACCES 后不声称成功 |
| F06 | 完整校验 manifest 时间、类型、平台、记录及统计；坏记录局部呈现；日期显示兜底 | 非法摘要不拖垮整个 state；合法旧修改时间兼容；列表缓存不替代操作前校验 |
| F07 | 全局与单游戏设置、5/15 默认、修改时间排序、0 禁用、整批找回限制、找回后清理 | 覆盖原文 7 行找回边界表；实际包 UI + IPC 超限无变更、满额合法找回、0 值入口禁用通过 |
| F08 | 五套原业务 E2E 和新增恢复点套件统一使用公共 harness 选择实际可执行文件 | 无效路径失败且不回退源码；实际包报告明确记录版本、packaged 标记与 ASAR 路径 |
| F09 | 公共关闭、超时处理、失败截图、trace、报告和 fixture 清理；原始错误与清理错误分别保留 | 注入报告失败仍保留原业务异常；CI 失败证据使用 `always()` 上传 |

主要文件：[retention.mjs](../electron/retention.mjs)、[restore-transaction.mjs](../electron/restore-transaction.mjs)、[recovery.mjs](../electron/recovery.mjs)、[library-config.mjs](../electron/library-config.mjs)、[fs-utils.mjs](../electron/fs-utils.mjs)、[remediation.test.mjs](../tests/remediation.test.mjs)。

## 4. 原审查 22 项对应结果

“完成”表示主要目标已实现并完成本机适用检查；不表示消除了所有未来优化空间。

| # | 当前状态 | 实施内容 |
| --- | --- | --- |
| 1 | 完成主要目标 | `AppError(code, params)` 和结构化 IPC 错误；常见系统错误映射；主进程与渲染层共用 `shared/locales` |
| 2 | 完成主要目标 | 仅摘要的 LRU 缓存，8 MiB 预算；按游戏失效；列表只索引记录 ID；自定义图标通过受控资源 URL 独立加载；普通存档及游戏列表每页 100 条 |
| 3 | 完成 | 双队列、设置、找回限制、事务安全和空间预算，见第 2、3 节 |
| 4 | 完成主要目标 | Library/Game/Manifest/Journal/导入计划等关键类型；共享 Bridge/Result/Progress；IPC 参数 schema、生成 preload、编译期反例与运行时参数验证；preload 和必要脚本纳入检查。部分旧通用校验边界仍使用 any，未声称全库零 any |
| 5 | 完成 | 20 MiB 分类日志、操作 ID、旧轮转迁移、完整记录淘汰、日志目录入口 |
| 6 | 完成主要目标 | 提取 Library/Themes/Settings 页面和 `useSaveHub`，保留现有弹窗模块，App 负责组合与交互编排 |
| 7 | 完成 | ESLint、Prettier、EditorConfig、项目命令和 CI 检查；格式化已有源码。当前未提交 diff 同时包含机械格式和行为变更，审阅时可使用 `git diff -w` |
| 8 | 完成主要目标 | 读档事务、快照导入/导出、保留、恢复、配置、图标和缓存各自成模块；无运行时 storage/game-transfer 循环依赖 |
| 9 | 保留并回归通过 | 键顺序无关的递归比较 |
| 10 | 完成主要目标 | 完整事务校验、唯一隔离文件、受影响游戏限制、显式从 `.previous` 恢复及损坏原件保留 |
| 11 | 保留并回归通过 | 语言通过订阅同步；不在 render 修改全局语言 |
| 12 | 完成 | 空库启动、可选模板、移除作者路径和桌面脚本自动读取 |
| 13 | 完成主要目标 | 复制同时计算哈希；capture 首次清单只读取元数据，仍保留目标及 sourceAfter 完整内容校验；真实 payload 测量见第 6 节 |
| 14 | 完成 | 已移除游戏统一管理入口，设置页跳转 |
| 15 | 保留并回归通过 | 两位序号使用 padStart |
| 16 | 保留并回归通过 | 完成事件绕过进度节流 |
| 17 | 实现完成，Apple Silicon 实测待运行 | 路径包含判断使用实际文件系统 dev/ino 身份；新增真实 APFS 敏感/不敏感卷脚本。Windows 身份测试通过，不替代 Mac 实测 |
| 18 | 保留并回归通过 | 生产 CSP 移除开发 WebSocket；独立图标使用受控协议 |
| 19 | 保留并回归通过 | favicon 相对路径，实际包图标可解码 |
| 20 | 范围完成 | Windows x64 / macOS Apple Silicon arm64；不增加 Intel 任务 |
| 21 | 配置完成，远端执行待验证 | PR 精简 Windows 检查；主分支/tag 双平台源码与实际包回归；摘要、ASAR 审计、失败证据和仅 tag 的 draft Release；写权限仅授予 draft 作业 |
| 22 | 完成 | 提取公共 E2E harness；Playwright runner 单 worker；trace、唯一证据目录和目标身份。原 9 个脚本全部有实际用途，删除整文件数为 0 |

E2E 去重保留 smoke、interactions、deletion、import、game-management 的独立业务断言；portable 检查真实 NSIS 便携启动，保留专用 CDP 连接。新增的 harness、preload 生成器、恢复点用例、包/安装/APFS 验证、摘要和性能脚本均有模块、package、CI 或本文明确的手动入口，没有用删除有效覆盖来减少脚本数。

## 5. 本轮验证结果

环境：Windows x64、Node.js `24.22.2`、Electron `45.1.0`、pnpm 固定 `11.25.0`。使用本机已安装依赖；锁文件已同步，**未把现有依赖验证宣称为全新联网安装验证**。TypeScript 7 原生编译器负责检查，ESLint 使用 TypeScript 6 的 JS API 兼容别名，两个依赖分别固定版本。

`pnpm install --lockfile-only --frozen-lockfile --offline --ignore-scripts` 已通过，确认 package 与冻结锁文件一致；该检查不会重装依赖或执行安装脚本。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| TypeScript / checkJs | 通过 | `node node_modules/@typescript/native/bin/tsc --noEmit` |
| ESLint、Prettier、preload 契约 | 通过 | lint、format:check、check:contracts 对应本地入口 |
| 单元与文件系统回归 | **134/134**，0 失败、0 跳过 | `unit-complete.log`，包含补齐的阈值、跨卷和 statfs 故障边界 |
| 生产 Vite 构建 | 通过 | 产物已进入实际包，并通过逐文件 ASAR 比对 |
| 最终解包版 E2E | **6/6 套件**，56 个业务检查，渲染错误 0 | `package-e2e-complete.log`、package 下的 `run.json` 与 trace |
| 最终便携 EXE | **5/5 检查**，渲染错误 0 | `portable-complete.log` 及便携报告 |
| 最终安装 EXE | 静默安装成功；已安装程序 smoke + retention **2/2 套件**；卸载成功 | `installer-complete.log`、`installation.json`，success / uninstalled 均为 true |
| 包内一致性与附件摘要 | 通过 | `audit-win32-x64.json`、`SHA256SUMS.txt` |
| 规模与真实 I/O 基线 | 已运行 | `benchmark.json`；界面补充测量见下一节 |
| 实际包界面规模测量 | 三档均通过，渲染错误 0 | `benchmark-ui-complete.log`、`benchmark-ui.json` |

数量口径：56 是六个脚本内部检查项的合计（13 + 16 + 6 + 6 + 11 + 4），不是 56 个 Playwright runner 用例。实际包报告全部指向 `release/1.1.5/win-unpacked/SaveHub.exe`，目标版本 1.1.5、`packaged: true`。安装版报告另指向本轮隔离安装目录中的 EXE。

测试只使用合成资料库。安装脚本先检查既有安装和快捷方式，避免覆盖用户安装；本轮安装位置在 `.test-data/installer-<唯一值>`，卸载后核对注册项并清理自己的测试目录。真实用户资料库和原游戏存档未用于验证。

## 6. 性能测量与解释

### 6.1 后端摘要

| 摘要数 | 应用缓存冷读 ms | 暖读 p50 / p95 ms | state JSON 字节 | 缓存字节 | 进程 RSS 字节 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 55.51 | 1.76 / 1.91 | 43,187 | 55,212 | 53,575,680 |
| 1,000 | 408.85 | 4.10 / 6.94 | 425,687 | 552,012 | 65,433,600 |
| 10,000 | 3,652.32 | 27.47 / 31.42 | 4,259,687 | 5,529,012 | 149,811,200 |

每档冷读 1 次、暖读 10 次。这里的冷/暖指应用摘要缓存，没有清空操作系统磁盘缓存。列表 fixture 有合法 manifest，仅 seed 带 payload；列表读取不会读取 payload。缓存只存摘要，10,000 条占约 5.27 MiB，受 8 MiB 预算约束。UI 收到的 state 仍随记录数增长，未改为服务端分页或增量 IPC。

### 6.2 真实存档复制

| 场景 | 实际 payload | p50 / p95 ms | 每次读取字节 | 每次写入字节（含元数据） | 采样峰值 RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 个大文件 | 33,554,432 | 148.30 / 165.09 | 100,663,296 | 33,555,252 | 214,437,888 |
| 1,000 个小文件 | 4,096,000 | 2,151.48 / 2,273.46 | 12,288,000 | 4,302,226 | 212,201,472 |

每场景 5 次，p95 为这 5 次中的最大值。读取量为 payload 的 3 倍，对应复制时哈希、目标校验和复制后的源校验；没有以 size/mtime 替代内容一致性。字节统计是 JavaScript 实际读取流及 FileHandle 写入量，不等于物理磁盘 I/O；RSS 每 5 ms 采样，包含同进程此前的摘要测量。上述结果是本机规模基线，不是与历史发行版的受控性能对照或所有硬件上的承诺。

### 6.3 实际包界面

使用 `scripts/benchmark-ui.mjs` 在最终 Windows 实际包中测量 100 / 1,000 / 10,000 条摘要的游戏切换、全量搜索、滚动和翻页。普通存档的 DOM 行数限制为每页 100 条；恢复点面板没有改成分页，较大自定义上限仍可继续评估虚拟列表。

| 摘要数 | DOM 行数 | 切换 p50 / p95 ms | 搜索 p50 / p95 ms | 下一页 p50 / p95 ms | 滚动后两帧 p50 / p95 ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 100 | 594.11 / 622.09 | 86.30 / 120.86 | 不需翻页 | 12.60 / 14.70 |
| 1,000 | 100 | 590.02 / 674.08 | 93.31 / 118.62 | 146.91 / 153.98 | 13.00 / 13.70 |
| 10,000 | 100 | 595.13 / 633.49 | 81.86 / 128.60 | 144.74 / 160.91 | 10.00 / 11.50 |

详细数据、目标程序身份及方法说明见 `test-results/benchmark-ui.json`，随验证证据归档。切换、搜索和翻页包含 Playwright 操作与断言开销及两帧等待；滚动是程序滚动后两帧的耗时，不当作 FPS 或用户输入延迟。每档 5 次，不设硬件相关的固定通过阈值。

首次界面测量因测试定位器未计入游戏按钮的存档数量而失败，修正定位后重新运行并取得上述完整结果；失败运行的报告、截图和 fixture 保留，未计为通过。

## 7. 产物与复跑

产物目录：[release/1.1.5](../release/1.1.5)。历史 `release/1.1.4` 保留。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| SaveHub-1.1.5-win-x64.exe | 122,034,932 | `c112971962897dc746ce1bc63c2c989d4793a7fdd225afe6d4b42d78eb8c9201` |
| SaveHub-1.1.5-Windows-x64-portable.exe | 111,007,668 | `c76f5208f5b7db20122826e132811e3c3e892ffcf34aaf931bf9e5fce0248489` |

解包目录必须整体保留使用；`app.asar` 审计覆盖 electron、shared、dist 和图标等运行文件，`.d.ts` 是编译期声明，不作为运行包必须包含的文件。附件摘要只列公开分发的顶层 EXE/DMG/ZIP，避免让下载用户依赖未发布的解包目录。

在项目根目录复跑，任一步骤失败先停止并排查；GUI 测试需要正常桌面权限和独立资料库：

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm check:contracts
pnpm test
pnpm build
pnpm test:e2e
pnpm dist:win
node scripts/test-package.mjs
pnpm test:portable
pwsh -NoProfile -File scripts/test-installer.ps1
node scripts/benchmark.mjs
$env:SAVEHUB_TEST_EXECUTABLE = (Resolve-Path 'release/1.1.5/win-unpacked/SaveHub.exe').Path
node scripts/benchmark-ui.mjs
Remove-Item Env:SAVEHUB_TEST_EXECUTABLE
pnpm checksums
pnpm audit:release
git diff --check
```

安装测试只在没有既有 SaveHub 安装/快捷方式的 Windows 测试环境执行。更完整的环境准备、参数和各平台命令见 [开发与发布指南](开发与发布指南.md)。本轮因沙箱限制，GUI 和打包经工具审批在正常 Windows 权限下执行；该权限差异不能混同为产品断言失败。

Apple Silicon 后续执行 `pnpm dist:mac`、`node scripts/test-package.mjs`、`node scripts/test-apfs.mjs`、摘要与审计，并保留该平台结果。CI 使用原生 arm64 `macos-15` runner，并在开始时断言架构；[GitHub runner 官方说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)列出了对应架构。编译器/API 分离依据 [TypeScript 7 官方迁移说明](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0)。

## 8. 证据归档与交付边界

本轮选定日志、实际包/便携/安装的 run.json、截图、trace、性能 JSON、发布审计和源码状态归档到 `release/1.1.5/verification/`。旧的失败尝试保留在 `.test-data` 或对应运行目录，未以旧成功报告覆盖本次失败；最终通过结果以本文指向的 complete 日志和实际程序身份为准。

快捷入口：[证据目录](../release/1.1.5/verification/)、[发布审计](../release/1.1.5/audit-win32-x64.json)、[附件摘要](../release/1.1.5/SHA256SUMS.txt)。这些产物由 Git 忽略；本报告、需求文档及开发指南可以随源码提交。

- Windows 包未配置 Authenticode 签名；macOS 配置保留 ad-hoc 签名，尚未配置 Developer ID 和公证。
- 未运行远端 CI、创建 draft Release 或正式对外发布；这些行为需要已提交源码对应的标签和远端执行结果。
- 当前工作区包含未提交修改；包内逐文件摘要证明与本机运行源码相符，不代表已经形成可追溯的发布提交。
- Mac 实机、全新联网依赖安装和可视化安装向导仍是独立验收项。本文没有将历史 Mac 结果或静默安装结果等同于这些验证。

本轮不引入 CAS、不重构磁盘格式，也没有删除仍有独立覆盖的 E2E 脚本。后续可根据真实资料库规模继续评估增量 state、恢复点分页和剩余 any 边界收紧；这些不影响本次已落实的恢复点和日志规则。
