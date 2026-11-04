# SaveHub 整改复核与后续优化清单

审查日期：2026-11-04（Asia/Shanghai）

审查对象：`main` 分支，提交 `f711d5db70f32fae71b1e19321445cc378d6e30a`，版本 `1.1.4`。

对照文档：[savehub_review.md](C:/Users/Limbo/Desktop/SaveHub/docs/savehub_review.md)，其原审查基线为 `617bc29`。

范围：Electron 主进程、preload、存储及文件事务、游戏/存档导入导出、React 页面及弹窗、双语文案、测试脚本、构建配置、CI、发布审计及使用文档。开始审查时工作区干净，原审查没有修改业务实现。

需求修订：2026-11-04，按用户确认的恢复点双队列、修改时间排序、找回数量限制、20 MB 分类日志和系统支持范围更新；此前脚本引用核查基于 `99ede31`。本轮补充需求和验收口径，未实施存储、日志或界面功能改动。第 2 节保留原审查实测结果，不代表这些新需求已经实现。

## 1. 结论

**尚未完成全部整改。当前实现已经解决部分问题，但新加入的自动清理和异常恢复逻辑仍有需要优先修复的缺陷。现有测试全部通过，不能据此认定整改已经完成。**

按原文 22 项的主要目标统计：

| 判定 | 数量 | 原文编号 |
|---|---:|---|
| 已完成主要目标 | 6 | #9、#11、#15、#16、#18、#19 |
| 部分完成 | 9 | #1、#2、#3、#4、#5、#6、#8、#10、#17 |
| 主要整改尚未实施 | 6 | #7、#12、#13、#14、#21、#22 |
| 支持范围已明确，无需扩展 | 1 | #20 |

判定依据是问题是否得到解决，不要求逐字照搬原文建议。例如 #16 通过“完成事件绕过节流”解决原问题，不必强制采用 trailing throttle；#20 已明确只支持 Windows 和 macOS Apple Silicon，Intel Mac 不在支持范围，不再作为待整改项。

本次最需要优先处理的是：

1. **读档已经提交后，恢复点清理异常仍会进入回滚，可能将刚恢复的文件移出游戏目录。**见 F01。
2. **自动清理直接物理删除活动恢复点，没有先移入“已移除的恢复点”，且部分物理删除失败没有可重试的清理状态。**见 F02。
3. **磁盘可用空间为 0 时，容量预检错误地放行。**见 F03。
4. **坏事务日志、坏 manifest 的隔离仍不完整，部分损坏仍会阻断整个应用。**见 F04—F06。
5. **默认 5/15 的双队列、全局设置及单游戏覆盖尚未实现，现有说明也未匹配这一规则。**见 F07。

这些结论来自当前源码检查和隔离合成数据复现，不代表真实用户资料库已经发生了相同问题。

### 1.1 恢复点保留规则（本轮确认，作为整改目标）

两类恢复点分别设置保留数量，处理顺序为“读档恢复点 → 已移除的恢复点 → 物理删除”。设置值表示允许保留的最大数量：已有 N 条时仍保留 N 条，新增或移入导致超过 N 条后，淘汰修改时间最早的超额记录。

| 队列 | 默认保留数量 | 超额处理 | 数量为 0 |
|---|---:|---|---|
| 读档恢复点 | **5** | 将修改时间最早的记录移入“已移除的恢复点”，保留文件及记录身份；满足下述找回条件时可找回 | 此队列不保留记录，记录进入“已移除的恢复点”并继续按其上限处理；单个和批量找回均不可进行 |
| 已移除的恢复点 | **15** | 对修改时间最早的记录执行物理删除，不可恢复 | 此队列不保留记录，进入该队列的记录执行物理删除 |

设置与执行口径：

- **全局设置**包含两项数量，对所有未设置对应游戏覆盖值的游戏生效；**单游戏设置**可覆盖对应数量，仅作用于该游戏。每项均可恢复为“继承全局”，其优先级为游戏显式值 > 全局值 > 默认值（5/15）。
- 数量只能是包含 0 的自然数，即非负整数。前端和后端均校验；负数、小数、空值、NaN、Infinity 和超出安全整数范围的值不得保存。**0 表示不保留，不表示无限保留，也不表示关闭自动清理**；继承全局需用独立状态表达，不能用 0 代替。
- **排序约定**：两队列均按存档记录的**修改时间**从早到晚淘汰，修改时间统一由记录元数据维护（目标字段 `updatedAt`），相同时间使用稳定次序。创建时间 `createdAt` 保留作历史信息，不作为日常淘汰依据；payload 文件的 mtime、目录时间也不代替记录修改时间。新建记录初始化修改时间，找回记录按下述规则刷新修改时间。
- **找回数量限制**：设该游戏当前生效的“读档恢复点”保留数量为 N，本次选中的待找回记录数量为 K。只有 **N > 0 且 1 ≤ K ≤ N** 时才允许继续找回；此限制针对本次找回数量，队列中的已有记录在找回后统一参与容量清理。
- **超限及 0 值处理**：批量找回超过 N 时提示“本次选择 K 条，读档恢复点最多保留 N 条，请减少选择”，禁止进入下一步或执行找回，不自动截取前 N 条，也不部分执行。N 为 0 时，单个找回、找回所选和找回全部均不可进行，界面显示禁用原因。前端入口和后端执行层均校验，后端在写入前重新读取生效设置；校验拒绝时不修改记录状态、修改时间或队列内容。
- **找回时间与执行顺序**：先完成整批数量及记录可找回性校验，再将记录找回到“读档恢复点”，将每条记录的修改时间更新为**本次找回的当前时间点**，创建时间保持原值。批量操作采用同一执行时间点及稳定的批内次序，完成整批状态和时间更新后再清理，避免逐条找回、逐条淘汰产生中间结果。
- **找回后的自动清理**：若活动队列原有 A 条，成功找回 K 条后超过 N，则将其中修改时间最早的 `A + K - N` 条移入“已移除的恢复点”，再按后者上限清理。活动队列已满时仍可找回符合数量限制的记录，找回后执行上述自动移除；最终活动队列不超过 N 条。
- 先处理活动队列超额，再处理已移除队列超额。新建恢复点、手动移除、成功找回、导入恢复点、修改保留数量和启动恢复完成后，都应按最终生效值检查两队列；减小上限时一次处理全部超额记录，增加上限不会找回已物理删除的文件。
- 自动移除及自动物理删除均按设置执行，**不弹额外确认、提醒或成功提示**。设置页和说明文档写清数量及 0 的含义；主动找回超限时仍必须显示上述阻止提示。其他用户主动操作保留既有确认流程。
- 不再要求新增“固定恢复点/转换普通存档”功能作为本项的完成条件，也不沿用旧实现“只计算未收藏、未保护恢复点”的容量口径。两队列按记录总数执行所设上限。
- 未完成的读档事务仍必须先生成并校验 safety 副本，保留其恢复依赖；即使两项均为 0，也只能在事务成功提交、或失败现场恢复完成后执行相应清理。物理清理的中断重试必须与用户“找回”区分：已物理删除的内容不能恢复，尚未删完的内容需要继续完成清理。

配置示例与验收结果：

| 生效设置（读档 / 已移除） | 正常事务结束并完成清理后的行为 |
|---|---|
| 5 / 15 | 每游戏最多 5 条活动恢复点、15 条已移除恢复点；新记录挤出的旧记录依次流转 |
| 0 / 15 | 活动恢复点为 0，最多保留 15 条已移除恢复点；单个和批量找回均不可进行 |
| 5 / 0 | 最多保留 5 条活动恢复点；被移除的恢复点自动物理删除 |
| 0 / 0 | 完成事务所需的临时安全备份后，两队列均不保留恢复点；单个和批量找回均不可进行 |
| 全局 5 / 15，游戏 A 覆盖 2 / 8 | A 使用 2 / 8，其他继承游戏使用 5 / 15；A 恢复继承后使用当前全局值 |

找回边界验收（记录均满足其他可找回条件）：

| 活动上限 N | 活动已有 A | 本次找回 K | 预期结果 |
|---:|---:|---:|---|
| 5 | 0 | 6 | 提示超限并阻止下一步；全部记录保持原状态和修改时间 |
| 5 | 0 | 5 | 允许整批找回，修改时间更新为当前找回时间；活动队列保留 5 条 |
| 5 | 5 | 1 | 允许单个找回，更新时间后将修改时间最早的 1 条移入已移除队列 |
| 5 | 4 | 3 | 允许整批找回，更新时间后将修改时间最早的 2 条移入已移除队列 |
| 5 | 5 | 5 | 允许整批找回，更新时间后将修改时间最早的 5 条移入已移除队列 |
| 0 | 0 | 单个或批量 | 均不可进行；不变更任何记录或触发找回后的清理 |
| 游戏覆盖 2 | 2 | 3 | 即使全局上限为 5，也按该游戏的生效上限 2 拒绝 |

### 1.2 日志分类与容量规则（本轮确认）

运行日志的**总保留容量上限为 20 MB**（沿用项目的二进制容量口径，即 20 × 1,024 × 1,024 = 20,971,520 字节）。所有分类文件合计达到上限时，自动在全部日志中按时间从早到晚删除完整的旧记录；后续写入同样执行淘汰，保证日志总容量不超过上限。保留最新记录，不将一条 JSON 日志截成无法解析的半条记录。

日志按**类型和操作分别记录**：类型可采用 `info / warn / error`，操作涵盖启动、存档、读档、导入、导出、找回、自动清理、配置修改及异常恢复等。按这两个维度写入独立分类文件，例如 `logs/info/recover.jsonl`、`logs/error/recover.jsonl`、`logs/info/prune.jsonl`；同一次操作的各阶段通过操作 ID 关联。每条记录包含时间、类型、操作名称、操作 ID、阶段和结果，并按需包含游戏/快照 ID、错误码及详细信息；分类文件名使用固定类型和操作名称，不为每个操作实例新建文件。

**20 MB 是全部类型、操作及历史归档共同使用的合计上限**，各分类不各自分配 20 MB。旧 `savehub.log`、`savehub.1.log` 应纳入分类迁移和总容量统计；按记录的类型和操作归类，缺少分类信息的历史记录纳入明确的兜底分类。按 UTF-8 实际字节计算容量，同时间记录按全局写入次序淘汰；分类写入、全局容量统计和裁剪应统一串行协调，避免并发覆盖或合计超额。单条日志本身超过上限时需限制详细字段大小并留下完整、可解析的记录。

该规则作用于 `userData/logs/` 下的运行/诊断日志；`transactions/`、`import-transactions/` 等未完成事务恢复文件是业务状态，继续按事务生命周期清理，不受日志容量淘汰规则影响。

### 1.3 操作系统范围（已明确）

仅支持 **Windows** 和 **macOS Apple Silicon**；当前构建目标为 Windows x64 与 macOS arm64。**不支持、也不计划增加 Intel Mac 版本，不增加 macOS x64/universal 构建或验收任务**。macOS 的路径、权限、签名和包内运行验证仍需在 Apple Silicon 上完成。

## 2. 本次验证结果与边界

运行环境为 Windows、Node.js `v24.22.2`，使用工作区已经安装的依赖。以下结果均为本次实际执行结果。

| 检查 | 结果 | 说明 |
|---|---|---|
| TypeScript/checkJs | 通过 | `node node_modules/typescript/bin/tsc --noEmit` |
| 生产构建 | 通过 | `node node_modules/vite/bin/vite.js build` |
| 单元测试 | **102/102 通过** | `node --test tests/*.test.mjs`，0 失败、0 跳过 |
| 基础 UI | **13 项通过** | `node scripts/smoke.mjs`，退出码 0 |
| 存档交互 | **16 项通过** | `node scripts/interactions.mjs`，退出码 0 |
| 删除交互 | **6 项通过** | `node scripts/deletion-interactions.mjs`，退出码 0 |
| 导入交互 | **6 项通过** | `node scripts/import-interactions.mjs`，退出码 0 |
| 游戏管理交互 | **11 项通过** | `node scripts/game-interactions.mjs`，退出码 0 |
| 五套界面测试渲染错误 | **均为 0** | 共 52 个脚本检查项；不是 52 个独立测试运行器用例 |
| 补充故障与缓存探针 | 发现问题 | 详见 F01—F06 及第 5 节；探针执行完成不等于被测行为正确 |
| 现有 Windows 发布包审计 | **失败** | `node scripts/audit-release.mjs`；现有 ASAR 中不存在 `electron/fs-utils.mjs` |

补充说明：

- 初次在受限环境运行 UI smoke 时，清理测试资料库遇到 `EBUSY ... data/lockfile` 并留下测试进程；该次退出码为 1，不计入通过结果。确认并结束该次测试进程后，以正常 Windows 权限、独立合成资料库、`SAVEHUB_KEEP_TEST_DATA=1` 重跑五套界面测试，全部取得完整结束结果。清理异常掩盖原始错误的问题见 F09。
- 本机 `pnpm --version` 在尝试切换到项目固定版本时遇到全局 store lock 的访问限制，并回退显示 `12.16.1`。因此本次直接调用已安装的 Node、TypeScript、Vite 和测试脚本；**未验证全新环境中的 `pnpm install --frozen-lockfile`**，未修改锁文件或依赖。
- 所有界面结果对应**当前源码 + 本次重新构建的 dist + 开发 Electron runtime**。没有重新打包，也没有把旧安装包的验收结果归到当前源码。
- 发布审计在包内容比较阶段已经失败，尚未执行到完整发行附件摘要核验。因此不能把此次结果描述为“所有发行文件 SHA-256 已验证”。旧包与新源码不一致也不等于旧包本身损坏。
- 原审查没有在 macOS Apple Silicon、真实 APFS 大小写敏感/不敏感卷上运行，没有操作安装向导，没有触发远端 GitHub Actions 或发布 Release。Intel Mac 不在支持及待验收范围。仓库内既有 macOS 验收文字仅作为历史记录，不作为本次验证证据。

## 3. 对原审查文档逐项复核

代码链接指向本次 Windows 工作区，行号对应上述提交；后续修改代码后需重新定位。

| # | 原问题 | 判定 | 当前证据与尚缺工作 |
|---:|---|---|---|
| 1 | 后端错误未国际化 | **部分完成** | 业务错误大范围改为 `translate` / `this.t()`；[ErrorBoundary](C:/Users/Limbo/Desktop/SaveHub/src/main.tsx:14) 已使用 `t()`，英语缺失路径错误单测通过。但 [IPC](C:/Users/Limbo/Desktop/SaveHub/electron/main.mjs:145) 仍传字符串，未实现 `AppError(code, params)`；[preload](C:/Users/Limbo/Desktop/SaveHub/electron/preload.cjs:3) 重新抛普通 Error。后端完整词典与渲染词典仍并存，底层文件系统错误也未统一映射。长期方案未完成。 |
| 2 | `state()` 全量扫描 | **部分完成** | [manifestCache](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:87) 避免重复读取、解析未变化的 manifest；有 stat 签名和写入失效。但 [state](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:252) 仍遍历全部游戏，[readSnapshot](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:530) 每次检查路径并克隆完整 `records`，缓存无容量上限。图标仍跟随 `...game` 全量回传，前端 [perform](C:/Users/Limbo/Desktop/SaveHub/src/App.tsx:227) 仍每次刷新。需要摘要缓存、按游戏失效、缓存预算及图标独立加载，见第 5 节。 |
| 3 | 恢复点保留策略与容量预检 | **部分完成，存在缺陷** | [旧实现默认保留 20 个](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:60)，直接物理删除超额活动恢复点，且 `limit <= 0` 直接跳过清理；这些行为均不符合第 1.1 节的新规则。应改为默认 5/15 双队列、按修改时间淘汰、0 不保留、全局值和单游戏覆盖，并限制单次找回数量、在找回时更新修改时间；自动清理不额外提醒，找回超限必须提示并阻止执行。capture/restore/export 已加入 `statfs`，但零剩余空间判断及同盘峰值估算仍需修复，见 F01—F03、F07。 |
| 4 | 后端无类型检查、IPC 三处同步 | **部分完成** | [tsconfig](C:/Users/Limbo/Desktop/SaveHub/tsconfig.json:8) 已启用 `allowJs + checkJs` 并包含 `electron/*.mjs`，本次检查通过。不过大量关键模型仍为 `any`；`electron/preload.cjs`、`scripts/` 没纳入。METHODS 仅用于 preload，main 注册和 [Bridge](C:/Users/Limbo/Desktop/SaveHub/src/types.ts:32) 仍分别手写，参数和返回值没有共同类型来源。 |
| 5 | 日志容量、记录覆盖与静默吞错 | **部分完成** | [Logger](C:/Users/Limbo/Desktop/SaveHub/electron/logger.mjs:4) 当前按约 1 MiB 轮转并额外保留上一份，不符合第 1.2 节“日志按类型和操作分别记录、合计上限 20 MB、全局淘汰最早记录”的规则。IPC 错误及部分回滚/清理已有日志；[openFolder('logs')](C:/Users/Limbo/Desktop/SaveHub/electron/main.mjs:227) 有后台能力，但设置页没有入口。仍需分类文件、完整操作阶段、错误信息及 F05 的隔离失败日志，并测试跨分类裁剪、并发写入和历史日志迁移。 |
| 6 | App 巨石组件 | **部分完成** | 已格式化 App 并抽出 `Modal`、`GameForm`、`SnapshotForm`、`RestoreConfirm`、`DeleteConfirmation`。但 [App.tsx](C:/Users/Limbo/Desktop/SaveHub/src/App.tsx:113) 仍为 **1,390 行、56,952 字节**，页面、15 类 modal 状态和大部分业务回调仍集中；没有独立 Library/Themes/Settings 页面与 `useSaveHub`。 |
| 7 | 无 lint/格式化工具 | **主要整改未实施** | package、CI 中仍没有 lint/format 脚本；没有 ESLint、Prettier、`.editorconfig` 配置。旧 `format.ts` 死代码已清理，但其他文件仍有超长单行：SnapshotList 最长 1,039 字符，GameManagement 最长 710 字符。一次性格式化不能替代持续检查。 |
| 8 | storage 职责过多及循环依赖 | **部分完成** | [fs-utils](C:/Users/Limbo/Desktop/SaveHub/electron/fs-utils.mjs:1) 已抽出；[game-transfer](C:/Users/Limbo/Desktop/SaveHub/electron/game-transfer.mjs:4) 改从它导入工具，运行时循环依赖已消除（JSDoc 类型引用不算运行时 import），`equal` 已共享。但 storage 仍约 1,600 行，读档、快照导入导出和恢复集中；manifest/inventory 也仍在通用工具模块里。继续按事务边界拆分并保留故障测试。 |
| 9 | JSON 字符串比较依赖键顺序 | **已完成主要目标** | [equal](C:/Users/Limbo/Desktop/SaveHub/electron/fs-utils.mjs:23) 已改为递归比较，并忽略对象中值为 undefined 的属性；关键调用共用该实现；[键顺序测试](C:/Users/Limbo/Desktop/SaveHub/tests/storage.test.mjs:955) 通过。`signature()` 仍使用固定投影的 JSON 序列化用于指纹，这与原问题不同。 |
| 10 | 损坏日志/资料库导致启动失败 | **部分完成** | JSON 语法错误日志已有 quarantine 和提示。但结构错误、隔离失败、同名隔离文件处理尚不完整，见 F04/F05；[library.json 损坏](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:125) 仍抛错并由 main 退出，没有从 `.previous` 恢复的选择，也不保存 `.corrupt-时间戳` 副本。 |
| 11 | render 中修改语言全局变量 | **已完成主要目标** | [App](C:/Users/Limbo/Desktop/SaveHub/src/App.tsx:115) 使用 `useSyncExternalStore`，[refresh](C:/Users/Limbo/Desktop/SaveHub/src/App.tsx:175) 获取后端状态后同步语言，已移除 render 中的 `setLanguage`。localStorage 用作初始语言并被后端状态覆盖。双语切换与重载测试通过；双词典问题归到 #1，避免重复计数。 |
| 12 | 作者本机预设 | **主要整改未实施** | [main](C:/Users/Limbo/Desktop/SaveHub/electron/main.mjs:51) 仍以 `makePresets()` 初始化；[presets](C:/Users/Limbo/Desktop/SaveHub/electron/presets.mjs:23) 仍包含三款游戏、D 盘 Steam 路径及 Desktop/save.sh 读取；[默认选中](C:/Users/Limbo/Desktop/SaveHub/src/App.tsx:125) 仍是 elden-ring。没有空库 + 模板选择流程。若保留现状，应明确是产品选择，而不是声称已完成此项。 |
| 13 | 存读档重复全量读取 | **主要整改未实施** | [capture](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:469) 仍为源 inventory、copyFile、目标 inventory、sourceAfter inventory；[restore](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:829) 仍有多轮 inventory。没有流式复制时计算哈希，也未提供大文件性能数据。优化时不得直接以 size/mtime 替代内容一致性保证，见第 5 节。 |
| 14 | 已删除游戏入口重复 | **主要整改未实施** | [设置页](C:/Users/Limbo/Desktop/SaveHub/src/App.tsx:956) 仍保留“已移除的游戏”完整列表，[全部游戏](C:/Users/Limbo/Desktop/SaveHub/src/AllGames.tsx:45) 也有已删除页；设置列表没有相同的彻底删除/重试操作。可改为跳转到统一页面。 |
| 15 | 两位序号错误 | **已完成主要目标** | [App](C:/Users/Limbo/Desktop/SaveHub/src/App.tsx:719) 已使用 `String(...).padStart(2, '0')`，10 不会变为 010。 |
| 16 | 节流吞掉完成事件 | **已完成主要目标** | [main](C:/Users/Limbo/Desktop/SaveHub/electron/main.mjs:43) 对 null 及 `completed >= total` 的事件直接发送。它不是通用 trailing throttle，但解决了原文明确指出的 100/100 被节流问题。无 total 的 checking 阶段仍为采样进度；若需保留每阶段最后一帧，再补独立进度协议。 |
| 17 | macOS 路径大小写绕过 | **部分完成，待平台验证** | [within](C:/Users/Limbo/Desktop/SaveHub/electron/fs-utils.mjs:96) 已对 win32/darwin 做小写折叠及 NFC，字符串用例通过。没有用真实文件系统规范化身份，也没有真实 APFS 卷测试；大小写敏感卷上的两个独立路径可能被保守误判为重叠。需分别验证大小写敏感/不敏感卷与现有路径别名，而不是只测字符串。 |
| 18 | 生产 CSP 保留开发 WebSocket | **已完成主要目标** | [Vite 插件](C:/Users/Limbo/Desktop/SaveHub/vite.config.ts:8) 在 build 时剔除开发 WebSocket；本次实际 [dist/index.html](C:/Users/Limbo/Desktop/SaveHub/dist/index.html:6) 的 connect-src 只有 self。 |
| 19 | file 协议下 favicon 绝对路径 | **已完成主要目标** | [入口](C:/Users/Limbo/Desktop/SaveHub/index.html:8) 已改为相对路径；实际构建输出为 `./assets/icon-D16OpIGT.svg`，资源存在，UI smoke 的图标检查通过。 |
| 20 | 操作系统支持范围 | **范围已明确，无需扩展** | 仅支持 Windows 和 macOS Apple Silicon；[package](C:/Users/Limbo/Desktop/SaveHub/package.json:54) 的 Windows x64、macOS arm64 目标符合范围。Intel Mac 不支持，不新增 macOS x64/universal。此项从待决策清单移除，继续保留 Windows 和 Apple Silicon 的实际包验收。 |
| 21 | CI 成本及发布链路 | **主要整改未实施** | [workflow](C:/Users/Limbo/Desktop/SaveHub/.github/workflows/build.yml:1) 仍对 PR、主分支和 tag 运行双平台全量 E2E + 打包；无分层、SHA256 生成、audit、draft Release，权限仍为 contents: read。README 已说明签名限制，但 CI 主体没有改。当前包与源码不一致，见第 6 节；签名/公证仍属发布决策。 |
| 22 | E2E 重复与未使用脚本 | **主要整改未实施；引用核查已完成** | 已核对全部 9 个工程脚本：6 个 E2E 均有 package/CI 入口，其他 3 个是有实际入口的开发、图标及发布工具；未发现可删除的无关联且未使用脚本。重复集中在 fixture、launch、dialog mock、报告及 cleanup，需抽公共 harness，保留各业务用例；详见第 5.5 节。F08/F09 和测试运行器/trace 缺口仍未实施整改。 |

## 4. 需要新增或升级处理的问题

以下 F 编号是本次复核发现，不替代原文编号。P1 为应先于继续发布/扩展功能处理的行为风险；P2 为健壮性、运维或验证缺口。

### F01 · P1 · 已提交读档可能被清理异常触发回滚

- **证据**：[storage.mjs:864–896](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:864)，以及 [rollback:929–944](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:929)。`committed` 已持久化，stage/journal 已清理，随后 `pruneRestorePoints()` 仍在同一个 try/catch 内；其外层扫描抛错时，catch 只判断 `journalWritten`，仍调用 rollback。
- **复现**：创建一份含 save.dat 的快照；删除合成游戏目录中的 save.dat；读档成功安装文件后，在恢复点扫描处注入 EIO。
- **实测**：读档返回失败，游戏目录的 save.dat 不存在；刚安装的数据被移到重新创建的 `.savehub-restore-.../failed/save.dat`，日志状态变成 `rolled-back`。原快照仍能校验，文件也保留在 failed 目录，**不是不可恢复的数据销毁**，但已提交的读档结果被改变了。
- **整改**：明确不可回退的提交边界。提交后的双队列清理、日志不得再进入文件替换回滚路径；清理失败记录诊断信息并作为独立重试任务处理，正常自动淘汰不额外提醒。两项上限为 0 时也必须先完成当前读档安全备份和事务，再清理。不能只在某一个调用处吞错而让提交状态仍不明确。
- **验收**：对“原目标存在”和“原目标不存在”分别注入提交后清理/日志/列表读取失败；游戏目录始终保持已校验的新内容，记录成功读档及单独的清理异常。

### F02 · P1 · 自动清理未按双队列流转，物理删除缺少中断重试状态

- **证据**：[pruneRestorePoints:774–786](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:774) 直接 `fs.rm(folder, recursive)`，而 [deleteSnapshots:733–742](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:733) 会先落盘 `.purge-*.json`、重命名至 `.purging-*`，然后删除。
- **复现**：保留上限设为 1，连续读档触发清理；模拟递归删除已移除旧 manifest 后遇到 EBUSY。
- **实测**：读档本身成功，但旧 payload 残留；记录被识别为 `kind: manual, corrupted: true`，不存在 purge marker；调用永久删除重试返回 manifest ENOENT，界面也禁止选择/删除该损坏记录。没有自动恢复清理的路径。
- **整改**：活动恢复点超额时先持久化为“已移除”，保留文件及身份；仅已移除队列超额时执行不可恢复的物理删除。物理删除复用或抽取“落盘删除意图—暂存重命名—删除—中断重试”的内部事务，无额外提醒。这里的重试用于删完残留，不是把已物理删除记录恢复给用户。注意当前 restore 已持有 exclusive，不能直接嵌套调用再次获取锁的公开 deleteSnapshots。
- **验收**：按第 1.1 节验证 5/15 和各种 0 值组合及修改时间排序；活动移除后仅在满足数量限制时可找回，活动上限为 0 时禁止找回，已物理删除后不可找回；在移除状态落盘、删除前、改名后、部分文件移除后模拟失败和进程中断，重启后能完成清理，其他游戏不受影响。

### F03 · P1 · 完全满盘时空间预检反而放行

- **证据**：[assertDiskSpace:229–249](C:/Users/Limbo/Desktop/SaveHub/electron/fs-utils.mjs:229)，条件要求 `available > 0 && available < needed`。
- **实测**：请求写入 1 MiB，模拟 `bavail=0, bsize=4096`，检查正常返回；只剩 4 KiB 时反而正确报空间不足。这是零值边界缺陷。
- **整改**：将合法的零可用空间纳入拒绝条件，区分“读取容量失败”和“容量为零”。容量读取失败至少应留下诊断信息。读档前按实际目标卷计算 safety、恢复 stage 及元数据的峰值增量；同盘时合并估算，跨盘时分别检查。
- **额外差异**：当前余量是 `1.05 × 字节数 + 64 KiB`，不是原文建议的 1.1；这可作设计选择，但应说明依据。现有预检并不消除检查后外部程序占满磁盘的可能，ENOSPC 仍必须走可靠回滚。
- **验收**：0 字节、低于阈值、恰好阈值、足够空间、statfs 失败、同盘与跨盘均有测试；失败时不产生半提交快照或破坏原存档。

### F04 · P2 · 只隔离 JSON 语法错误，结构损坏仍阻止启动

- **证据**：[recoverTransactions:960–985](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:960)、[recoverImportReplacements:1094–1118](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:1094)。try/catch 只包裹 readFile/JSON.parse，结构和恢复逻辑在其外部。
- **实测**：分别将两个事务目录中的日志内容设为合法 JSON `{}`，启动仍失败，错误为“无效的项目或存档标识”或“导入覆盖事务无效”，文件未被隔离。
- **整改**：对单个日志做完整 schema/路径/状态验证，区分日志损坏与恢复动作的 I/O 失败。保留日志和现场，列出受影响游戏；无法确认其一致性时限制该游戏写入，其他游戏仍可使用。不能把所有恢复失败都当成“坏 JSON”后继续读写。
- **验收**：语法错误、`null`、`{}`、错误版本、非法路径、缺字段及恢复 I/O 失败均有各自结果；同时补上 library.json.previous 的显式恢复流程。

### F05 · P2 · 隔离失败也声称“已隔离”，隔离文件名可冲突

- **证据**：[storage.mjs:963–970](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:963)、[1098–1105](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:1098)。移动使用原文件名，`.catch(() => {})` 忽略失败，随后无条件写成功含义的提示。
- **实测**：注入 rename EACCES 后启动继续，原日志仍在原位置，quarantine 中没有文件，提示却是“已隔离保留供排查”。
- **整改**：隔离目标使用不会覆盖旧证据的唯一名称；移动失败单独记录并如实展示原路径和失败原因。不要把读取权限错误误认为 JSON 内容损坏。
- **验收**：目标已有同名文件、目录权限不足、日志暂时不可读/不可移动时，保留两份证据，不报虚假的隔离成功，后续启动行为明确。

### F06 · P2 · manifest 摘要字段缺少校验，坏记录可拖垮全库状态

- **证据**：[validateManifest:345–373](C:/Users/Limbo/Desktop/SaveHub/electron/fs-utils.mjs:345) 检查 records 和路径，但没有完整验证 `createdAt`、`kind`、`platform`、`bytes`、`fileCount` 等摘要；[snapshots:249](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:249) 在单条错误捕获之外直接调用 `createdAt.localeCompare`。
- **实测**：两份其余内容有效的合成 manifest 将 `createdAt` 设为 null，`state()` 整体失败：`Cannot read properties of null (reading 'localeCompare')`。没有按现有设计转成可展示的损坏记录。
- **影响**：一个摘要损坏可影响整个资料库加载；非法日期字符串还可能进入 [dateLabel](C:/Users/Limbo/Desktop/SaveHub/src/format.ts:25) 并导致渲染错误。空间预算目前也直接使用摘要 bytes，应防止其与 records 总和不一致。
- **整改**：集中验证完整 manifest schema 和派生统计，补安全的日期显示及排序兜底；新增的记录修改时间 `updatedAt` 同样纳入校验。在单条记录范围内保留错误，不影响其他游戏。对历史允许缺省的字段应明确兼容规则，避免升级后把合法旧记录全部标为损坏；修改时间的旧格式兼容见 F07。
- **验收**：创建/修改时间损坏、未知 kind/platform、负数/字符串 bytes、错误 fileCount、缺少可选旧字段都有测试；合法旧格式正常加载，损坏单条可定位，非法修改时间不会直接进入自动淘汰排序。

### F07 · P1 · 双队列保留设置及找回限制未实现

- **证据**：[README 中文第 136 行](C:/Users/Limbo/Desktop/SaveHub/README.md:136) 写“应用不会自动清理恢复点”，[英文同段](C:/Users/Limbo/Desktop/SaveHub/README.en.md:136) 也写 never auto-deletes；[旧实现](C:/Users/Limbo/Desktop/SaveHub/electron/storage.mjs:765) 默认保留 20 个未收藏/未保护的活动恢复点，0 会跳过清理，超额直接物理删除，未限制已移除队列。这些均需改为第 1.1 节的目标行为。
- **界面与配置缺口**：[设置页](C:/Users/Limbo/Desktop/SaveHub/src/App.tsx:933) 没有两项全局数量设置，[游戏表单](C:/Users/Limbo/Desktop/SaveHub/src/modals/GameForm.tsx:11) 没有对应覆盖/继承设置。当前单个 maxRestorePoints 不能表达两级容量与每游戏覆盖关系。
- **整改**：实现全局 5/15 默认值和单游戏覆盖，端到端校验非负整数，显式区分 0 与继承。两队列按记录修改时间淘汰；找回数量不得超过该游戏活动队列的生效上限，超过时提示并阻止整批操作，上限为 0 时禁止单个和批量找回。找回成功时将修改时间置为当前找回时间，再执行活动队列软移除、已移除队列物理删除。同步中英文说明及所有找回入口的禁用状态；正常自动清理不新增弹窗、确认或额外提醒，也不要求增加固定恢复点入口。
- **兼容**：旧资料库没有新配置字段时使用 5/15 默认值；旧 maxRestorePoints 不能直接沿用为新规则中的 0，因为旧 0 是不清理、新 0 是不保留。旧记录缺少修改时间时，优先迁移已有可用的记录修改时间；没有可用值时以合法创建时间一次性初始化 `updatedAt`，此后始终按修改时间维护和排序，不在每次读取时重置为当前时间。日期损坏按 F06 处理。升级时应明确替换为新双队列默认配置，并在事务恢复及字段迁移结束后按有效上限整理队列，不影响普通手动/导入存档。
- **验收**：覆盖默认值、0/15、5/0、0/0、全局修改、游戏覆盖、恢复继承、无效值拒绝、降低上限、旧库升级及重启持久化；其他游戏的覆盖值不被全局修改覆盖。补齐第 1.1 节找回边界表、超限整批无变更、0 值所有入口禁用、执行前设置变化重新校验、找回时间刷新、满额找回后按修改时间淘汰及相同时间的稳定顺序；使用创建时间与修改时间顺序不同的数据证明排序依据正确。双语提示一致，自动淘汰没有额外提醒。

### F08 · P2 · 游戏管理 E2E 无法指定实际发布包

- **证据**：[game-interactions:39](C:/Users/Limbo/Desktop/SaveHub/scripts/game-interactions.mjs:39) 固定 `electronPath + ['.']`；其他四套使用 `SAVEHUB_TEST_EXECUTABLE`。该脚本的 [报告](C:/Users/Limbo/Desktop/SaveHub/scripts/game-interactions.mjs:249) 也没有记录 executable。
- **影响**：即使运行者设置了发布包路径，这套测试仍验证工作区源码，无法证明包内包含游戏管理功能。这是源码静态确认的缺口；本次没有把它当成包测试。
- **整改**：公共 harness 统一选择可执行文件、启动参数和数据目录；报告记录实际 executable、版本及包内/源码标识。
- **验收**：给定不存在的 `SAVEHUB_TEST_EXECUTABLE` 必须失败而非悄悄运行源码；指定真实包时全部相关测试确实运行在该包上。

### F09 · P2 · E2E 清理错误可覆盖原始失败，CI 失败证据不足

- **证据**：[smoke 清理](C:/Users/Limbo/Desktop/SaveHub/scripts/smoke.mjs:182) 在 finally 直接递归删除资料库。本次第一次 smoke 的最终异常是 `EBUSY ... lockfile`，原始失败没有保存在该日志中，并存在残留 Electron 进程。
- **CI 缺口**：[上传步骤](C:/Users/Limbo/Desktop/SaveHub/.github/workflows/build.yml:45) 未配置失败也执行；前面用例失败会跳过该上传，且没有 trace。历史成功 JSON 也不应当作失败运行的新证据。
- **整改**：先保留原始异常，再处理 close/子进程退出和带重试的清理；清理失败保留 fixture 并给出路径，不覆盖主错误。为每次运行使用独立报告目录和运行标识；失败时上传日志、截图及 trace。
- **验收**：启动失败、断言失败、关闭超时、fixture 文件锁定四类情况均能取得原始原因和可定位的证据，退出码正确，不遗留属于本次测试的应用进程。

## 5. 性能、类型与维护性需要怎样继续优化

### 5.1 缓存应围绕列表摘要，而不是完整 manifest

本次合成数据为 1 个游戏、21 份 manifest，其中额外 20 份各含 2,000 条 file record，并附带约 1 MiB 的图标字符串。仅用于检查列表读取行为，额外 manifest 没有构造对应真实 payload，**不是实际大型资料库吞吐测试**。

| 指标 | 首轮读取 | 暖缓存再次读取 |
|---|---:|---:|
| readFile 次数 | 20 | 0 |
| lstat 次数 | 902 | 902 |
| structuredClone 经过的 records 数 | 40,001 | 40,001 |
| 缓存中保留的 records 数 | 40,001 | 40,001 |
| state JSON 字节数 | 1,056,880 | 1,056,880 |
| 本机单次耗时，仅供定位 | 118.4 ms | 63.6 ms |

首轮有一份模板快照已因准备 fixture 而缓存，因此 readFile 为 20。测试说明缓存确实减少了读文件，但没有消除逐快照路径检查、完整 records 克隆和图标传输；不能将这两个耗时直接外推为真实用户性能。

建议把“列表摘要读取”与“操作前完整校验”分离：列表只保留/返回摘要，写操作仅更新对应游戏摘要；完整 records 按需读取，设置缓存容量/淘汰策略。恢复、覆盖、导出之前仍需重新执行必要的身份、路径和内容校验，不能为了减少列表 I/O 而绕过写入前防护。图标独立存储并以受控资源标识加载，协议访问必须限定游戏身份和实际文件范围。

前端 [SnapshotList](C:/Users/Limbo/Desktop/SaveHub/src/SnapshotList.tsx:43) 当前会全量过滤/排序并为全部行创建 DOM；[AllGames](C:/Users/Limbo/Desktop/SaveHub/src/AllGames.tsx:55) 也全量渲染。后端优化后仍应测量 100/1,000/10,000 份摘要下的切换、搜索和滚动，再决定分页或虚拟列表，避免只优化磁盘却保留渲染瓶颈。

### 5.2 减少全量读取不能削弱一致性

原 #13 的“sourceAfter 仅比较 size + mtimeMs”不宜直接作为等价替换：相同长度改写、时间戳恢复、文件系统时间精度等场景未必被元数据比较发现。可以先实施流式复制同时计算源哈希、复用明确属于同一阶段的校验结果，但应保留足够的目标校验和源变化检测，并以故障注入证明语义未减弱。

下一轮性能验收应记录真实读写字节量、峰值内存、p50/p95、文件数量和总大小，并区分冷/暖缓存、小量大文件/大量小文件；不要用此次小型合成探针替代性能基线。

### 5.3 类型检查与 IPC 要能发现契约错误

当前 checkJs 已有价值，但 `config`、manifest、导入计划等仍广泛使用 any，main 的注册器也接受 `(...args: any[]) => any`。下一步先定义 Library、Game、Manifest、事务日志、导入计划/决策、进度事件及 Result 类型，再统一 IPC 方法名、参数元组和返回值来源。动态生成 preload 方法并不自动生成类型，也不保证 main 实现匹配。

补充编译期契约检查，并用少量边界运行测试验证非法 IPC 参数在修改磁盘前被拒绝。preload 与必要 scripts 进入适当的检查配置；无需为了通过检查把新错误继续断言成 any。

### 5.4 格式化、模块拆分和日志的收尾

- 统一格式工具和最小 lint 规则，CI 执行检查；机械格式化与行为调整分开，便于审阅。
- 将页面、数据刷新/操作 hook 与弹窗编排分离；后端先抽离恢复事务和导入事务，再拆其他职责。继续沿用当前锁和磁盘格式。
- 设置页补“打开日志目录”；运行日志按类型和操作分别写入分类文件，记录操作 ID、游戏/快照 ID、阶段、错误码及恢复结果。按第 1.2 节维持所有分类合计 20 MB 上限，在全部分类中自动删除时间最早的完整记录；测试分类正确性、同一操作跨类型关联、单类未满但总量满额、跨分类最早记录淘汰、恰好满额、连续写入、UTF-8 多字节、单条过大、并发写入和旧轮转文件迁移。日志写入/裁剪失败不得影响已提交的存读档结果。
- 将设置页的已移除游戏列表改为统一入口；新安装流程是否为空库、是否保留自动读取旧 save.sh，应形成明确决策。

### 5.5 E2E 重复代码与无关联/未使用脚本核查（本轮已检查）

核查了全部工程脚本、`package.json` 调用入口、CI、源码/脚本之间的引用和开发/验收文档；未把仅出现在旧验收文档中的名称当作当前使用证据。`scripts/` 实际共有 9 个文件，9 个文件都有 package 命令，SHA-256 也各不相同。结合用例内容检查，**没有发现整个文件冗余且没有调用关系的 E2E 脚本，本轮删除数量为 0**。

| 脚本 | 当前入口 | 独立职责 | 处置 |
|---|---|---|---|
| [smoke.mjs](C:/Users/Limbo/Desktop/SaveHub/scripts/smoke.mjs) | `test:ui`；双平台 CI | 安全基线、图标、基本存读档、语言、主题及窗口布局 | 保留 |
| [interactions.mjs](C:/Users/Limbo/Desktop/SaveHub/scripts/interactions.mjs) | `test:interactions`；双平台 CI | 筛选/排序、跨页状态、批量保护、标签页范围、导出及动效 | 保留 |
| [deletion-interactions.mjs](C:/Users/Limbo/Desktop/SaveHub/scripts/deletion-interactions.mjs) | `test:deletion`；双平台 CI | 回收站/恢复点的批量移除、找回、物理删除和中断重试 | 保留；后续补修改时间排序、找回超限/0 值禁用及双队列自动淘汰用例 |
| [import-interactions.mjs](C:/Users/Limbo/Desktop/SaveHub/scripts/import-interactions.mjs) | `test:import`；双平台 CI | 存档冲突逐项决策、取消、混合执行、多目标覆盖 | 保留 |
| [game-interactions.mjs](C:/Users/Limbo/Desktop/SaveHub/scripts/game-interactions.mjs) | `test:games`；双平台 CI | 游戏卡片/列表、游戏配置及携带存档的两级导入、整游戏删除 | 保留；修复 F08 的实际包入口 |
| [portable-smoke.mjs](C:/Users/Limbo/Desktop/SaveHub/scripts/portable-smoke.mjs) | `test:portable`；Windows CI 直接调用 | 真实 NSIS 便携 EXE 解包、CDP 连接、产物版本和退出 | 保留；它与源码 smoke 的运行对象不同 |
| [dev.mjs](C:/Users/Limbo/Desktop/SaveHub/scripts/dev.mjs) | `dev` | 开发服务器与 Electron 启停 | 保留，属于开发工具 |
| [build-icons.mjs](C:/Users/Limbo/Desktop/SaveHub/scripts/build-icons.mjs) | `build:icons` | 图标渲染、尺寸检查及 PNG/ICO 生成 | 保留，属于资源构建工具 |
| [audit-release.mjs](C:/Users/Limbo/Desktop/SaveHub/scripts/audit-release.mjs) | `audit:release` | ASAR 源码比对和发行摘要检查 | 保留，属于发行审计工具 |

确认存在的重复及后续清理方式：

1. 五套源码 E2E 重复创建 `.test-data` fixture、配置环境变量、启动 Electron、捕获 pageerror、生成报告和关闭/清理。`smoke:44`、`interactions:59`、`deletion-interactions:49`、`import-interactions:45` 的启动调用一致，game-interactions 另有 F08 中的偏差；宜由同一 harness 统一处理。
2. 交互、删除、导入和游戏管理重复 `done()` 计数/输出；多套用例各自实现目录选择器 mock。将这些公共逻辑提取后删除原脚本中的重复实现，业务断言仍留在对应用例中。
3. 主题、读写存档、删除等场景有交集，但基础 smoke、专项故障场景和真实便携包检查验证的是不同范围，不能因名称或部分步骤相同而删除整套测试。
4. 后续若出现无 package/CI/模块/必要手动入口、且覆盖已由其他用例完整承接的脚本，再删除该文件，并同步移除失效命令、CI 步骤和文档引用。删除前后核对独立行为覆盖，避免仅以“执行次数少”判定未使用。

报告引用的临时探针位于 `.test-data/`，与 F01—F06 的复现证据有关，不是可直接清理的无关联工程 E2E。其行为应在修复时转为正式回归用例，历史证据按版本保留。此次仅做脚本引用和重复逻辑核查，没有把“检查完成”记为“公共 harness 已实施”。

## 6. 发布与磁盘兼容性复核

### 6.1 当前源码与现有发行物是不同阶段

实际运行发布审计得到：

```text
Error: "electron\fs-utils.mjs" was not found in this archive
```

因此现有 `release/1.1.4/win-unpacked/resources/app.asar` 至少未包含本次抽出的模块，不能作为本轮整改的发行物。本次没有重写旧包或 SHA256SUMS，也没有重新发布。

建议在修复 P1 问题后按新版本准备产物，执行源码检查、真实解包版/便携版/安装流程验证、包内一致性审计、最终附件摘要，再生成可追踪的验收记录。保留历史发行文件和历史验收，不用重写历史摘要掩盖源码差异。

CI 可分为 PR 的类型/lint/单元/必要 smoke，以及主分支或 tag 的 Windows、macOS Apple Silicon 完整回归与打包；不增加 Intel Mac/x64/universal 任务。tag 任务生成摘要、审计产物并创建 draft Release；发布任务单独授予所需权限。失败证据上传应独立于成功发行物上传。macOS arm64 需要自身的包内审计和运行证据，不能直接复用当前硬编码 Windows ASAR 路径的 audit 脚本。

### 6.2 格式仍兼容，行为兼容尚需补验收

当前仍写入：

- `library.json`：`version: 1`；
- snapshot manifest：`version: 1`；
- 存档命名导出索引：`version: 2`；
- 游戏导出索引/配置：各自 `version: 1`。

缓存为内存结构，没有发现为此强制迁移既有 manifest；旧导出包、完整游戏包跨平台往返等现有单测通过。但“版本号没变”只说明格式未显式升级，**不说明行为完全兼容**：新需求的 5/15 双队列、0 不保留及禁止找回、修改时间排序和找回数量限制必须同步到旧库默认值、全局/游戏设置和说明文档，见 F07；新增修改时间字段需补迁移及导入导出往返验证，当前代码尚未实施这些规则。

后续实施摘要分离、图标落盘或保留策略持久化时，要补只读兼容、故障回退及旧库升级测试；不要在读取旧库时隐式丢弃未知字段或直接改写所有备份。

## 7. 推荐整改顺序与完成标准

| 顺序 | 工作包 | 完成标准 |
|---:|---|---|
| 1 | F01、F02、F03：提交边界、双队列清理、满盘预检 | 已提交内容不会因清理错误回滚；两队列按修改时间淘汰，活动超额移入已移除队列，后者超额静默物理删除；物理清理中断可重试；0 空间不会放行 |
| 2 | F04—F07：损坏隔离、完整 schema、找回限制、保留设置 | 默认 5/15；非负整数与 0 不保留有效；找回超限提示并阻止整批执行，活动上限为 0 时禁止所有找回；找回更新时间后再清理；全局/单游戏覆盖、恢复继承、旧库升级和持久化一致；单条损坏不拖垮其他游戏 |
| 3 | #2、#4、#8、#13：摘要缓存、关键类型、模块边界、I/O | 有可重复的规模基线与资源预算；无 IPC 契约漂移；格式与完整性故障测试保持通过 |
| 4 | #1、#5、#6、#7、#12、#14：错误协议、日志分类与容量、界面拆分及工程规范 | 运行日志按类型和操作分别记录，所有分类总量不超过 20 MB，跨分类自动淘汰最早完整记录；双语失败路径可测；日志可访问；lint/format/typecheck 进入 CI |
| 5 | #21、#22、F08、F09：测试去重和新版本发行 | 公共 harness 替换重复逻辑，独立覆盖保留；只删除确认无关联且未使用的脚本；真实包目标和失败证据可验证；Windows/Apple Silicon 独立验收 |

#17 的真实 macOS 路径验证在 Apple Silicon 上完成；#20 的支持范围已确定，不再安排 Intel Mac 需求评估或构建。原文已建议暂不实施 CAS，本轮也没有足够证据要求改造整个存储格式。

## 8. 本地复核材料与复跑命令

本次辅助材料位于 Git 忽略的测试目录，可用于本机追查；若需长期纳入发布验收，应将选定材料复制到对应新版本的 verification 目录。本报告本身是新增的可版本管理文档。

- [补充探针脚本](C:/Users/Limbo/Desktop/SaveHub/.test-data/review-2026-11-04/probes.mjs)：仅创建独立合成 fixture，注入故障发生在独立 Node 进程内，不修改生产源码或真实资料库。
- [探针结构化结果](C:/Users/Limbo/Desktop/SaveHub/.test-data/review-2026-11-04/probe-results.json)：F01—F06 与缓存测量。
- [单测日志](C:/Users/Limbo/Desktop/SaveHub/.test-data/review-2026-11-04/unit.log)、[发布审计失败日志](C:/Users/Limbo/Desktop/SaveHub/.test-data/review-2026-11-04/release-audit.log)。
- 五套完整界面日志为同目录的 `smoke-full.log`、`interactions-full.log`、`deletion-interactions-full.log`、`import-interactions-full.log`、`game-interactions-full.log`。
- 最新界面 JSON：[基础 UI](C:/Users/Limbo/Desktop/SaveHub/docs/screenshots/verification.json)、[存档交互](C:/Users/Limbo/Desktop/SaveHub/docs/screenshots/interaction-verification.json)、[删除](C:/Users/Limbo/Desktop/SaveHub/docs/screenshots/deletion-verification.json)、[导入](C:/Users/Limbo/Desktop/SaveHub/docs/screenshots/import-verification.json)、[游戏管理](C:/Users/Limbo/Desktop/SaveHub/docs/screenshots/game-management-verification.json)。这些脚本会覆盖固定报告名，未来复跑需注意证据日期。

在项目目录、已安装依赖的前提下，可复跑：

```powershell
Set-Location -LiteralPath 'C:\Users\Limbo\Desktop\SaveHub'
node node_modules/typescript/bin/tsc --noEmit
node --test tests/*.test.mjs
node node_modules/vite/bin/vite.js build
node .test-data/review-2026-11-04/probes.mjs

# 在正常 Windows 桌面权限下运行；保留合成测试资料便于定位失败。
# 本段使用源码，不依赖旧安装包。
$reviewPreviousKeep = $env:SAVEHUB_KEEP_TEST_DATA
$reviewPreviousExecutable = $env:SAVEHUB_TEST_EXECUTABLE
try {
    $env:SAVEHUB_KEEP_TEST_DATA = '1'
    Remove-Item Env:SAVEHUB_TEST_EXECUTABLE -ErrorAction SilentlyContinue
    node scripts/smoke.mjs
    node scripts/interactions.mjs
    node scripts/deletion-interactions.mjs
    node scripts/import-interactions.mjs
    node scripts/game-interactions.mjs
} finally {
    $env:SAVEHUB_KEEP_TEST_DATA = $reviewPreviousKeep
    $env:SAVEHUB_TEST_EXECUTABLE = $reviewPreviousExecutable
}

# 当前历史包会在源码一致性检查中失败；该命令不会自动重新打包。
node scripts/audit-release.mjs
```

复跑时应逐条检查退出码并记录新结果，不能只看最后一条命令。补充探针当前用于暴露已确认的问题；修复后应把相关情景转换为正式回归断言，并更新本报告的状态。
