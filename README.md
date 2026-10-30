# SaveHub

珍藏每一次冒险。一个基于 **Electron + React + TypeScript** 的本地游戏存档管理器，支持 Windows 与 macOS Apple Silicon。

## 开始使用

Windows：打开 `release/1.1.0/win-unpacked/SaveHub.exe`，或使用 `release/1.1.0/` 下的安装包、便携版。整个 `win-unpacked` 文件夹需要一起保留，不能只复制其中的 EXE。先关闭正在运行的旧版，再打开新版；已有资料库可直接使用。

1. 选择游戏，打开「游戏设置」。确认当前系统的**游戏存档根目录**与**要备份的相对路径**。
2. 关闭游戏，点击「创建新存档」，填写名称与备注。
3. 点击某份存档的「读档」，确认游戏及会写入文件的云同步已关闭。应用先备份当前进度，再恢复选中的内容。
4. 要撤销读档，在时光轴右侧的「读档恢复点」中找到 `读档前 · …`，点击恢复即可。

预置游戏可编辑或移除，也可以添加任意游戏。图标支持内置图形与本地 PNG / JPG / WebP / ICO 图片。图片导入后会复制到配置中，不依赖原文件继续存在。

## 参考脚本与对应关系

已阅读这三个目录中的 `save.sh` / `load.sh`：

| 游戏 | 原脚本的游戏根目录（target） | 备份项目（array） |
| --- | --- | --- |
| 杀戮尖塔 | `D:\Steam\steamapps\common\SlayTheSpire` | `betaPreferences`、`preferences`、`saves` |
| 艾尔登法环 | `%USERPROFILE%\AppData\Roaming\EldenRing` | `76561198132913813` |
| 黑暗之魂 II | `%USERPROFILE%\AppData\Roaming\DarkSoulsII` | `011000010a4a6695` |

首次在 Windows 启动时，会尝试读取用户桌面对应目录的 `save.sh`，只解析 `source` / `target` / `array` 的字面量，**不会执行脚本**。没有脚本时使用上述预设，路径、账号目录都可以手动修改。

旧脚本的 `source` 对应原备份目录。应用创建的新存档使用独立资料库和 UUID，不再根据目录数量决定编号，也不会覆盖旧的 `ArchiveFile…`。

「导入旧存档」会复制旧目录内所有 `ArchiveFile…` 子目录，兼容 `ArchiveFile0`、`ArchiveFile10th-DLC-1st-1level` 等自定义后缀。「导入存档」还接受单个旧存档目录、单份 SaveHub 导出目录，或包含 `collection.json` 的批量导出目录。导入结果分别列出成功、重复跳过与失败；原文件保留。

## 功能

- 多游戏独立配置与独立存档库，Windows / macOS 路径分别保存。
- 一次备份多个文件或目录，递归保留空目录、文件内容与修改时间。
- 存档命名、备注、收藏、保护标记、搜索、完整性校验、导入、导出。
- 点击存档名称、创建时间、文件大小表头切换正序或倒序，默认创建时间倒序；名称支持自然数字排序。
- 勾选单份或全选当前列表，批量移入回收站、找回、导出；批量删除前会列出选中的记录。
- 批量导出只选一次目标目录；「导出全部存档」导出当前游戏的普通存档，忽略搜索和当前筛选条件。
- 恢复前自动创建独立的读档恢复点，事务式替换、失败回滚、下次启动恢复未完成事务。
- 存档回收站；移除游戏保留所有备份，可在设置中找回。
- 四种持久化主题：宣纸水墨、通透科技、霓虹赛博朋克、磨砂玻璃。右上角为唯一主题入口；再次点击返回上次页面，保留游戏、筛选、搜索、排序、勾选和滚动位置。
- 路由、筛选、排序、主题与弹窗变化带过渡效果；遵循系统的减少动态效果设置。
- 本地文件处理，不需要账号或服务器。不会自动同步、定时备份或检测游戏进程。

## 存档与标记

每份手动创建或导入的存档只有一个 ID 和一份原始内容。收藏、保护、回收站修改这份记录的标记，切换标记不会生成副本。

| 视图 | 显示范围 |
| --- | --- |
| 全部存档 | 手动或导入的存档，排除保护标记与回收站中的记录；普通收藏仍可显示 |
| 已收藏 | 带收藏标记且不在回收站的记录；可同时有保护标记 |
| 保护存档 | 带保护标记且不在回收站的记录 |
| 回收站 | 已添加回收站标记的记录；找回时保留原有收藏和保护标记 |
| 读档恢复点 | 读档前自动保存的进度，独立展示，不计入游戏存档数量 |

在存档的「更多操作」中添加或取消保护标记。游戏存档数量按记录去重计算，不把收藏、保护的数量相加。保护标签不限制读档或移入回收站。

「全选当前列表」只选择当前搜索和筛选后可见的有效存档；切换筛选或搜索会清空选择，每个游戏独立保留列表状态。「导出所选」也能导出保护或回收站中的记录。「导出全部存档」范围固定为上表的全部存档，不包含保护、回收站和自动恢复点。

批量导出生成一个集合目录，其中每份存档都有独立清单与完整内容，并附 `collection.json`。整个集合校验成功后才对外显示，失败不会留下半份导出结果。重新导入会保留收藏与保护标记，并生成正常可用的导入存档；已导出的回收站记录导入后不再标记为已删除。

1.0.0 的自动保护副本仍在原位置，1.1.0 将它们显示在「读档恢复点」，不复制或迁移文件。新保护标签默认未设置。此前的名称、收藏、回收站和存档内容均可继续使用。

## 存储与恢复规则

默认资料库位于 Electron 的 `userData` 目录，精确路径在「设置与关于」中显示：Windows 通常为 `%APPDATA%\SaveHub`，macOS 通常为 `~/Library/Application Support/SaveHub`。开发模式使用项目内的 `.local-data`。可用 `SAVEHUB_DATA_DIR` 指向单独的资料库进行测试或本地部署；不要让两个进程共用同一资料库。

```text
SaveHub/
  library.json                    游戏资料和主题
  library.json.previous           上一次配置
  vault/<game-id>/
    game.json                     自定义游戏资料
    snapshots/<snapshot-id>/
      manifest.json               路径、时间、备注、标记、SHA-256 校验清单
      payload/                    原始存档内容
  transactions/                   恢复事务日志
```

存档不是压缩包，可以直接检查其文件。读档只替换配置的相对路径，其他游戏文件不受影响；被替换目录内新出现的文件会移除，以保持完整恢复语义。读档恢复点也会记录原本不存在的路径，恢复它时这些路径会重新不存在。

复制先写入暂存目录，再比较源文件、复制文件和校验清单；验证成功后才提交。恢复先验证备份，再生成自动恢复点，再在目标磁盘暂存，通过逐项重命名替换。恢复失败时还原原文件；异常中断后根据事务日志恢复。失败暂存目录和日志保留供诊断。它们可能占用额外空间；尚未实现永久清空回收站或自动清理恢复点。恢复点面板的移除操作同样可找回，不释放原文件。

为了避免越界写入，拒绝绝对的备份项、`..`、父子路径重叠、大小写冲突、Windows 保留名称、符号链接与目录联接。选中的根目录和子路径必须可读写；资料库不能与要备份的内容重叠。目录在磁盘上尚未存在时，请先启动游戏创建存档，或手动建立正确目录。

关闭游戏与云同步十分重要：应用会检测复制和替换前后的变化，但不能阻止其他进程同时写入。系统权限错误、磁盘故障或外部程序持续修改文件仍可能需要人工恢复；应用会保留保护副本与事务记录。

## Windows 与 macOS

使用同一套 Electron 和 Node 文件实现，无 Bash、盘符替换命令或 `rm -rf` 依赖。macOS 的预设路径留空，需要选择实际存档位置；应用兼容 macOS 不代表游戏本身有 macOS 原生版本。通过 Wine / CrossOver 运行的游戏可以选择兼容层中的实际目录。SaveHub 不转换游戏存档格式。

最低系统要求依据当前 Electron 运行时：Windows 10 及以上，macOS 13 Ventura 及以上。Mac 发行目标只配置 **arm64**，不构建 Intel 版本。Windows 当前提供 x64 版本。

本机是 Windows；macOS 的应用启动、文件权限和安装包仍需在 Apple Silicon Mac 上验证。macOS DMG 在 Mac 上构建。发布给其他用户前，需要配置 Apple Developer 签名与公证；本项目未包含证书或公证凭据。Windows 包也未配置代码签名。

## 开发与构建

Git 管理源码、测试脚本、构建配置、pnpm 锁文件、`build/` 中的图标及手写文档。依赖、构建产物、本地存档、测试数据、自动生成的截图与验收 JSON、日志和本机环境配置由 `.gitignore` 排除；忽略规则不会删除现有文件。

`docs/screenshots/` 和发行审计 JSON 是本机或 CI 验证产物，可通过下方测试与审计命令生成。环境变量示例 `.env.example` 及共享 VS Code 配置可以提交。

环境：Node.js 22.12+（建议 24），pnpm 11.25.0。

```sh
pnpm install
pnpm dev                 # Vite + Electron，使用 .local-data
pnpm test                # 临时文件上的真实存储测试
pnpm build               # 类型检查 + 前端生产构建
pnpm test:ui             # Electron 端到端测试、四主题截图
pnpm test:interactions   # 主题返回、批量操作、标记、排序与过渡验证
pnpm pack:win            # Windows 解包版
pnpm dist:win            # Windows 安装版 + 便携版
pnpm dist:mac            # 在 Mac 上构建 arm64 DMG + ZIP
pnpm test:portable       # Windows 便携版的解包、启动与存读档验证
pnpm audit:release       # 核对 Windows 包内代码与发行文件摘要
```

构建完成后 `pnpm start` 可使用 Electron 打开生产界面。所有依赖版本已固定，并提供 `pnpm-lock.yaml`。安装时会获取官方 Electron 运行时；网络不通时可参考 [Electron 安装文档](https://www.electronjs.org/docs/latest/tutorial/installation) 的镜像配置，文件仍使用包内的官方摘要校验。

`.github/workflows/build.yml` 提供 Windows 和 macOS 构建工作流，上传安装包供下载，不会自动发布 Release。该文件仅提供配置，尚未在远端执行。

## 项目结构

```text
electron/storage.mjs       备份、完整恢复、校验、事务回滚、导入导出
electron/presets.mjs       三个游戏的脚本字面量解析与预设
electron/main.mjs          Electron 窗口、原生对话框、IPC 权限边界
electron/preload.cjs       最小化、明确列举的 renderer API
src/App.tsx               游戏库、存档时光轴、编辑表单与主题选择
src/SnapshotList.tsx      标记视图、复选、批量操作与表头排序
src/motion.ts             页面过渡及减少动态效果适配
src/art.tsx               本地 SVG 场景与游戏图形
src/styles.css            布局与交互样式
src/list.css              列表、批量操作、恢复点和过渡样式
src/themes.css            四套完整视觉主题
tests/storage.test.mjs    文件操作与恢复机制测试
scripts/smoke.mjs          独立测试资料库上的 Electron 端到端检查
scripts/interactions.mjs  主题返回、选择排序、批量文件操作与状态语义检查
scripts/portable-smoke.mjs 单文件便携版的实际启动与存读档检查
scripts/audit-release.mjs  包内源码与发行文件摘要核对
docs/screenshots/         测试示例的主题截图和验证记录
```

Electron 启用 context isolation、sandbox，关闭 Node integration，拒绝导航和额外窗口，并校验 IPC 主窗口与 frame 来源，遵循 [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)。渲染层不能直接访问文件系统。主题与插画均随应用打包，无在线字体或图片依赖。

## 验证记录

`tests/storage.test.mjs` 的 28 项测试覆盖真实复制与 SHA-256、完整目录替换、多游戏隔离、恢复点撤销、缺失路径恢复、损坏备份拦截、文件变化拦截、失败回滚、启动恢复、符号链接保护、旧备份去重、导出重导入、回收站、配置持久化及并发拒绝；新增标记不复制、旧版恢复点兼容、批量身份预检、部分失败报告、批量导出范围、集合重导入与损坏导出预检。

`scripts/smoke.mjs` 使用独立的合成游戏文件启动真实 Electron，操作创建存档、搜索收藏、确认读档、验证磁盘内容、回收站、增删游戏与四种主题。截图展示的是测试示例，**不是用户的真实游戏进度**。测试结束会清理本轮测试数据，不读取或覆盖真实游戏存档。

单文件便携版由 NSIS 启动器解包后再启动 Electron；`scripts/portable-smoke.mjs` 通过仅用于测试的本机调试端口连接实际窗口，验证当前版本与界面资源、启动、存档、读档、自动恢复点及退出。它不依赖启动器转发调试器标准输出。具体交付状态见 [1.1.0 验收记录](docs/验收记录-1.1.0.md)；[1.0.0 历史记录](docs/验收记录.md)继续保留。
