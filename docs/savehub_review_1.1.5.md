# SaveHub v1.1.5 全量工程审查与优化建议

- **审查基线**：`v1.1.5`（Git HEAD `ce5e49b`）
- **验证状态**：Node.js 原生测试套件 `node --test tests/*.test.mjs` **142 / 142 全部通过**（注：当前本地工作区尚未执行 `pnpm install` 安装 `node_modules`，TypeScript / ESLint / Playwright 等依赖外部包的脚本需先安装依赖后执行）
- **整体评价**：经历 v1.1.4 → v1.1.5 的一轮重构后，`storage.mjs` 模块化拆分、读档事务回滚与启动自愈（`restore-transaction.mjs` / `recovery.mjs`）、IPC 契约校验（`ipc-schema.mjs`）及摘要缓存等主干架构已成型。但在**写保护锁的边界一致性、分类日志器与高频文件校验的数据结构复杂度、跨语言导出与 UI 细节契约**上，仍存在 17 项需要修复和改进的问题。

---

## 一、P1 · 逻辑缺陷与正确性 Bug（影响安全边界、恢复自愈或测试闭环）

### 1. 只读路径解析与写保护锁耦合（`location()` 误调 `assertGameWritable`）

- **位置**：
  - [storage.mjs#L591-L592](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L591-L592)
  - [storage.mjs#L389-L394](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L389-L394)
  - [main.mjs#L289-L291](file:///Users/limbo/Workspace/Myself/SaveHub/electron/main.mjs#L289-L291)
- **问题分析**：
  `SaveStore.location(game)` 是纯路径解析与只读校验函数，但首行无条件调用了 `this.assertGameWritable(game.id)`。当某个游戏因恢复事务回滚失败被列入 `this.blockedGames`（即 `recoveryBlocked: true`）时，会产生两个连锁 Bug：
  1. **状态误报**：[`state()`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L389-L394) 调用 `this.location(game)` 被抛错捕获，将该游戏强制标记为 `pathStatus = 'missing'`（UI 显示“存档目录不可用，请检查设置”），掩盖了真实目录其实完好、只是存在未恢复事务的事实。
  2. **排查路径被锁死**：用户在 UI 点击“打开游戏目录”手动排查修复时，[`openFolder('game', gameId)`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/main.mjs#L289-L291) 调用 `store.location(game)` 直接抛出 `gameRecoveryBlocked`，连打开资源管理器查看文件都被拒绝。
- **优化建议**：
  将 `this.assertGameWritable(game.id)` 从只读方法 [`location()`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L591-L592) 中移除；仅在 [`createSnapshot`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L868)、[`restoreSnapshot`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/restore-transaction.mjs#L30) 等真正修改数据的写操作入口执行写保护断言。

---

### 2. `blockedGames` 写保护存在绕过漏洞（删除游戏、导入覆盖游戏未拦截）

- **位置**：
  - [game-transfer.mjs#L181-L201](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-transfer.mjs#L181-L201)（`removeGame`）
  - [game-transfer.mjs#L203-L214](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-transfer.mjs#L203-L214)（`purgeGame`）
  - [game-transfer.mjs#L531-L536](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-transfer.mjs#L531-L536)（`reviewGameImport`）
  - [game-transfer.mjs#L687](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-transfer.mjs#L687)（`executeGameImport`）
- **问题分析**：
  当游戏处于 `blockedGames` 写保护状态（即 `vault/<gameId>/.restore-staging` 下仍有待人工介入的现场或隔离数据）时：
  - [`upsertGame`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-transfer.mjs#L98) 和快照增删改查都调用了 `store.assertGameWritable(id)`；
  - 但 [`removeGame`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-transfer.mjs#L181-L201)（包括勾选 `deleteRecords: true` 调用 [`purgeGame`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-transfer.mjs#L203-L214) 直接 `rm(gameDir)` 物理删除整个游戏 vault 目录）和 [`executeGameImport`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-transfer.mjs#L687)（通过 `overwrite` 模式覆盖已有游戏的 `locations` 与元数据）**均漏掉了 `store.assertGameWritable` 检查**。
  - 这导致用户在游戏恢复失败、现场尚在 `.restore-staging` 中等待抢救时，可以通过删除游戏（勾选删除记录）把 `.restore-staging` 现场彻底删光，或通过导入游戏篡改该游戏的 `locations.root`。
- **优化建议**：
  在 [`removeGame`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-transfer.mjs#L181)、[`purgeGame`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-transfer.mjs#L203)、[`reviewGameImport`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-transfer.mjs#L531)（当存在 `existing` 且选择覆盖时）及 [`executeGameImport`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-transfer.mjs#L687) 入口补齐 `store.assertGameWritable(targetId)`。

---

### 3. 进度面板（`ProgressPanel`）遗漏 `restoring` 与 `deleting` 阶段映射

- **位置**：
  - [ProgressPanel.tsx#L8-L14](file:///Users/limbo/Workspace/Myself/SaveHub/src/components/ProgressPanel.tsx#L8-L14)
  - [restore-transaction.mjs#L104](file:///Users/limbo/Workspace/Myself/SaveHub/electron/restore-transaction.mjs#L104)
  - [storage.mjs#L985](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L985)
  - [contracts.ts#L67](file:///Users/limbo/Workspace/Myself/SaveHub/shared/contracts.ts#L67)
  - [zh.json#L207-L213](file:///Users/limbo/Workspace/Myself/SaveHub/shared/locales/zh.json#L207-L213) / [en.json#L207-L213](file:///Users/limbo/Workspace/Myself/SaveHub/shared/locales/en.json#L207-L213)
- **问题分析**：
  后端在读档阶段发出 `phase: 'restoring'`（[restore-transaction.mjs#L104](file:///Users/limbo/Workspace/Myself/SaveHub/electron/restore-transaction.mjs#L104)），在删除存档时发出 `phase: 'deleting'`（[storage.mjs#L985](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L985)）。但前端 [`ProgressPanel.tsx`](file:///Users/limbo/Workspace/Myself/SaveHub/src/components/ProgressPanel.tsx#L8-L14) 的 `phases` 字典仅定义了 `checking | copying | importing | exporting | pruning`。
  由于 [`Progress.phase`](file:///Users/limbo/Workspace/Myself/SaveHub/shared/contracts.ts#L67) 被声明为宽泛的 `string`，TypeScript 编译期未报错，导致运行时读档替换与删除存档的进度弹窗标题均回退为 `t('app.preparingProgress')`（“正在准备，请稍候…”）。
- **优化建议**：
  1. 将 [`contracts.ts`](file:///Users/limbo/Workspace/Myself/SaveHub/shared/contracts.ts#L67) 中的 `Progress['phase']` 收紧为字面量联合类型：`'checking' | 'copying' | 'restoring' | 'deleting' | 'importing' | 'exporting' | 'pruning'`；
  2. 在 `zh.json`、`en.json` 的 `progress` 节点与 [`ProgressPanel.tsx`](file:///Users/limbo/Workspace/Myself/SaveHub/src/components/ProgressPanel.tsx#L8-L14) 中用 `Record<Progress['phase'], string>` 补齐 `restoring` 与 `deleting` 文案。

---

### 4. Windows 便携版冒烟脚本（`portable-smoke.mjs`）存在过时断言，运行必败

- **位置**：
  - [portable-smoke.mjs#L118-L121](file:///Users/limbo/Workspace/Myself/SaveHub/scripts/portable-smoke.mjs#L118-L121)
- **问题分析**：
  提交 `1bdb6ff` 移除了读档确认弹窗中的勾选复选框（“确认读档”按钮初始即为启用状态），但 [`portable-smoke.mjs`](file:///Users/limbo/Workspace/Myself/SaveHub/scripts/portable-smoke.mjs#L119) 第 119 行仍写着：
  ```js
  await expect(dialog.getByRole('button', { name: '确认读档', exact: true })).toBeDisabled();
  await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(0);
  await dialog.getByRole('button', { name: '确认读档', exact: true }).click();
  ```

  既然没有 checkbox，按钮怎么可能先 `toBeDisabled()` 下一行又直接 `.click()`？在 Windows 环境执行 `pnpm test:portable` 时第 119 行必然断言失败（对比 [`desktop.spec.ts#L455`](file:///Users/limbo/Workspace/Myself/SaveHub/tests/e2e/desktop.spec.ts#L455) 已改为 `.toBeEnabled()`）。
- **优化建议**：
  将 [`portable-smoke.mjs#L119`](file:///Users/limbo/Workspace/Myself/SaveHub/scripts/portable-smoke.mjs#L119) 的 `.toBeDisabled()` 修正为 `.toBeEnabled()`。

---

### 5. `withinOnDisk` 在首个路径参数不存在时退化为大小写不敏感比较，破坏大小写敏感 APFS 语义

- **位置**：
  - [fs-utils.mjs#L110-L121](file:///Users/limbo/Workspace/Myself/SaveHub/electron/fs-utils.mjs#L110-L121)
  - [storage.mjs#L604-L609](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L604-L609)
- **问题分析**：
  [`withinOnDisk(root, target)`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/fs-utils.mjs#L110-L121) 旨在通过 `dev/ino` 精确判断 `target` 是否位于 `root` 内部。但当 `root` 自身尚不存在时（例如在 [`location()`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L609) 中调用 `withinOnDisk(target, this.dataDir)`，此时 `target` 是游戏存档根下尚未创建的备份子项），`statMaybe(root)` 返回 `null`，函数直接退化为 `within(root, target, platform)`。
  而 [`within()`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/fs-utils.mjs#L98-L108) 在 `darwin` 下无条件将整个路径 `.toLowerCase()`，导致：
  1. 在 macOS 大小写敏感 APFS 卷上，当子项尚未创建时，大小写不同的路径会被误判为包含关系；
  2. 当 `root` 包含 macOS 系统符号链接别名（如 `/var/...` vs `/private/var/...`）且末端目录尚未创建时，纯字符串比较会失效。
- **优化建议**：
  在 [`withinOnDisk(root, target)`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/fs-utils.mjs#L110-L121) 中，若 `root` 尚不存在，也应同 `target` 一样向上回溯找到最深层已存在的祖先目录，通过 `dev/ino` 加上精确的剩余相对路径分段比对，而不是一旦 `root` 末端不存在就整条路径退化为 `.toLowerCase()` 字符串比较。

---

## 二、P1 · 数据结构与性能瓶颈（I/O 写放大与冗余系统调用）

### 6. 分类日志器（`classified-logger.mjs`）存在严重的内存常驻与最高 100,000 倍磁盘写放大

- **位置**：
  - [classified-logger.mjs#L54-L85](file:///Users/limbo/Workspace/Myself/SaveHub/electron/classified-logger.mjs#L54-L85)
  - [classified-logger.mjs#L143-L170](file:///Users/limbo/Workspace/Myself/SaveHub/electron/classified-logger.mjs#L143-L170)
  - [classified-logger.mjs#L217-L225](file:///Users/limbo/Workspace/Myself/SaveHub/electron/classified-logger.mjs#L217-L225)
  - [log-settings.mjs#L3](file:///Users/limbo/Workspace/Myself/SaveHub/shared/log-settings.mjs#L3)
- **问题分析**：
  这是典型的**数据结构选择不当导致把简单问题复杂化**的案例：
  1. **全量日志文本常驻内存**：`this.records` 将所有日志文件的每一行原始 JSON 字符串（`line`）长期保存在 Node 主进程内存中。默认上限 20 MB，而 [`MAX_LOG_LIMIT_MB`](file:///Users/limbo/Workspace/Myself/SaveHub/shared/log-settings.mjs#L3) 甚至设为 `Math.floor(Number.MAX_SAFE_INTEGER / BYTES_PER_MB)`（约 85 亿 MB），未设合理上界。
  2. **每次写日志都对全量数组排序**：在 [`write()`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/classified-logger.mjs#L220-L224) 中，每写入一条日志，调用 [`trim()`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/classified-logger.mjs#L146) 对数万条记录执行 `this.records.sort(...)`（含 `String.prototype.localeCompare`）。
  3. **稳态下 100,000 倍磁盘写放大**：一旦日志总大小达到 20 MB 上限进入稳态，**此后每追加 1 条 200 字节的新日志**：
     - 先执行 `fs.appendFile(filePath, line)`；
     - 紧接着 `trim()` 淘汰最老的 1 条记录，标记其所属文件需要重写；
     - 立即调用 [`rewrite(file)`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/classified-logger.mjs#L131-L141)，将该分类日志文件（如 `system.jsonl`，可能高达 15~20 MB）在内存中全量 `join('')` 拼接、写入 `.tmp` 并 `rename` 覆盖！如果最老记录和最新记录在同一个文件，刚做的 `appendFile` 完全白写，随后还要重写整个 20 MB 文件。
- **优化建议**：
  1. **消除稳态逐条重写（引入高低水位线 / 分段轮转）**：达到 100% 容量上限时，一次性裁剪至 80%~85% 水位线（或采用按固定大小分段的滚动文件 `system.1.jsonl` / `system.2.jsonl` 直接 `unlink` 旧段），将重写频率降低 1,000 倍以上；
  2. **消除内存驻留与全量排序**：内存中仅保留轻量元数据索引（或每个文件的字节大小与首尾时间戳），新写入记录直接 `push` 到队尾即可保持有序，仅在触发水位线裁剪时按需流式截断文件；
  3. **收紧配置上限**：将 [`MAX_LOG_LIMIT_MB`](file:///Users/limbo/Workspace/Myself/SaveHub/shared/log-settings.mjs#L3) 限制在合理值（如 `1024` MB）。

---

### 7. `snapshots()` 列表缓存 1 秒即过期 + `readSnapshot` 在查缓存前重复执行 3 轮全路径 `assertNoLinks`

- **位置**：
  - [storage.mjs#L320](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L320)
  - [storage.mjs#L757-L775](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L757-L775)
  - [storage.mjs#L382-L429](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L382-L429)
- **问题分析**：
  1. [`snapshots()`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L320) 中的 `${gameId}/list` 缓存写死了 `Date.now() - cached.time < 1000`（1 秒过期）。[`benchmark.mjs`](file:///Users/limbo/Workspace/Myself/SaveHub/scripts/benchmark.mjs#L118-L120) 在紧凑 `for` 循环中连续调用 10 次 `state()` 仅耗时 40ms，掩盖了真实交互中**用户两次点击间隔几乎必然大于 1 秒**的事实。
  2. 一旦超过 1 秒，每次调用 [`state()`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L382-L429) 都会遍历**所有游戏**（含未选中游戏与已移入回收站的游戏），对每个游戏调用 `snapshots()` → `readdir` → 对每份快照调用 [`readSnapshot(gameId, id, true)`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L757-L775)。
  3. 而在 [`readSnapshot`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L757-L775) 中，**在查询 `this.manifestCache.get(cacheKey)` 之前**，对每一份快照都要无条件执行 3 次 `assertNoLinks`（`folder`、`marker`、`file`，每次从磁盘根目录 `/` 逐级 `lstat` 到目标文件，约 8~10 次系统调用 × 3）外加 2 次 `statBigIntMaybe`！
  4. 结果：当库中有 1,000 份快照时，用户间隔 1 秒以上点一下收藏、改名或切换主题，主进程仍要瞬间发起 **25,000+ 次 `lstat` 系统调用**。此外，[`state()`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L386-L429) 还会对已软删除（`game.deletedAt`）的游戏执行无意义的 `location(game)` 和 `fs.readdir(game.legacyRoot)`。
- **优化建议**：
  1. 在 [`snapshots()`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L316) 入口对父目录 `vault/<gameId>/snapshots` 仅做 **1 次** `assertNoLinks(directory)`；子项 [`readSnapshot`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L757) 传入 `{ trustedParent: true }`，仅需 `lstat` 快照子目录本身与 `manifest.json`，消除从 `/` 到 `snapshots` 父目录的数万次重复 `lstat`；
  2. 当父目录 `directorySignature(directory)`（`ino:mtimeNs:ctimeNs`）未变且快照的 `manifest.json` 缓存已命中时，延长或基于事件失效列表缓存，而非硬编码 1 秒过期；
  3. 在 [`state()`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L386) 中对 `game.deletedAt` 的已删除游戏跳过 `location(game)` 与 `legacyRoot` 扫描。

---

### 8. `copyRecords` 在文件循环内重复从根目录执行 `assertNoLinks` 与 `mkdir`，小文件备份性能劣化

- **位置**：
  - [fs-utils.mjs#L372-L387](file:///Users/limbo/Workspace/Myself/SaveHub/electron/fs-utils.mjs#L372-L387)
- **问题分析**：
  - 在 [`copyRecords`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/fs-utils.mjs#L372-L384) 中，第 373 行已经遍历 `directories` 创建了目录，但在第 377 行的 `for (const record of files)` 循环内，对**每一个文件**又重复调用了：
    1. `await fs.mkdir(path.dirname(dest), { recursive: true })`
    2. `await assertNoLinks(origin)`（从磁盘根目录 `/` 逐级 `lstat` 到当前文件）
  - 当备份包含 1,000 个小文件（总计仅 4 MB）时，这会产生上万次冗余的父目录 `lstat` 和 `mkdir` 调用，导致 `benchmark.mjs` 中创建仅 4 MB 的快照耗时高达 **2.15 秒**。
  - 同时，[`copyRecords`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/fs-utils.mjs#L353) 未接收 `lang` 参数，第 387、419 行抛出的 `new AppError(..., undefined)` 无法跟随用户语言。
- **优化建议**：
  1. 在 `copyRecords` 入口对 `source` 和 `target` 根目录各做一次 `assertNoLinks`；
  2. 循环内用 `Set` 记录已校验/已创建的相对父目录，文件本体由第 383 行的 `fs.lstat(origin)` 校验 `!current.isSymbolicLink()` 即可，无需每个文件都从 `/` 根目录重跑整条路径的 `assertNoLinks`；
  3. 为 `copyRecords` 补齐 `lang` 参数透传。

---

### 9. `restoreSnapshot` 读档事务存在 7 轮全量文件读取与重复扫描

- **位置**：
  - [restore-transaction.mjs#L30-L115](file:///Users/limbo/Workspace/Myself/SaveHub/electron/restore-transaction.mjs#L30-L115)
  - [storage.mjs#L628-L711](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L628-L711)
- **问题分析**：
  单次读档替换（`restoreSnapshot`）目前对磁盘数据执行了多达 **7 轮全量字节读取与 SHA-256 计算**：
  1. `verify(target)`：全量读目标快照算哈希；
  2. `inventory(root, { hash: false })`：扫描当前游戏存档目录；
  3. `capture()` 内部：再次执行一模一样的 `inventory(root, { hash: false })`，随后 `copyRecords` 读盘算哈希、`inventory(stage)` 读盘算哈希、`inventory(root)` 读盘算哈希；
  4. `copyRecords(snapshot -> stage/next)`：再次全量读快照算哈希；
  5. `inventory(stage/next)`：全量读 `stage/next` 算哈希；
  6. `inventory(root)`：在 `capture` 刚算完且无人修改的情况下，再次全量读当前游戏目录算哈希；
  7. 同卷 `fs.rename` 切换目录后，第 108 行再次 `inventory(root)` 全量读盘算哈希。
     对于几百 MB 的大型存档（如博德之门 3、星空），一次读档会产生数 GB 的冗余读取。
- **优化建议**：
  1. 将第 42 行的 `currentSize` 直接传给 `capture()` 复用，并把 `capture()` 校验通过的源目录 `before` 指纹返回给 `restoreSnapshot` 复用，直接省去第 3 轮预扫描和第 6 轮全量哈希读取；
  2. 对于同卷 `fs.rename` 的目录切换，可通过比对文件树的轻量元数据签名（`relPath + dev + ino + size + mtimeNs + ctimeNs`）确认目录项未被篡改，无需在同卷 `rename` 前后重复读取数百 MB 文件内容计算 SHA-256。

---

### 10. 自定义游戏图标（最高 3MB Base64）仍内联在 `library.json` 中，且每次 `state()` 重复计算 SHA-256

- **位置**：
  - [game-icons.mjs#L6-L23](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-icons.mjs#L6-L23)
  - [game-transfer.mjs#L83](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-transfer.mjs#L83)
  - [storage.mjs#L301-L304](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L301-L304)
- **问题分析**：
  虽然 IPC 传输已改为 `savehub-icon://` 协议，但底层存储仍有两处缺陷：
  1. [`publicIcon(game)`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-icons.mjs#L18-L23) 在**每次**调用 `state()` 以及每次渲染进程请求图标 [`iconResponse()`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-icons.mjs#L25-L34) 时，都会对最高 3MB 的 `game.icon` Data URL 字符串重新计算一次 SHA-256；
  2. 最高 3MB/个的 Base64 字符串依然内联保存在 `library.json` 中。若有 10 个游戏配置了自定义图标，`library.json` 将膨胀至 20~30 MB，每次用户切换深浅色主题、语言或修改任何设置调用 `saveConfig()`，都要将数十 MB 的 JSON 序列化并全量写入 `library.json.tmp` 和 `library.json.previous`。
- **优化建议**：
  将自定义图标独立存储为 `vault/<gameId>/icon.<ext>`（或至少在 `game` 配置对象中预存 `iconHash`），彻底将数 MB 的二进制 Base64 从高频读写的 `library.json` 中剥离。

---

## 三、P2 · 产品体验、前端状态与国际化缺陷

### 11. 导出目录名、兜底文件名与游戏模板名称仍硬编码中文

- **位置**：
  - [fs-utils.mjs#L530](file:///Users/limbo/Workspace/Myself/SaveHub/electron/fs-utils.mjs#L530)：`name = name.replace(/[. ]+$/g, '') || '未命名存档';`
  - [snapshot-export.mjs#L157](file:///Users/limbo/Workspace/Myself/SaveHub/electron/snapshot-export.mjs#L157)：`uniqueExportName(\`${exportName(game.name)}-存档导出\`, existing)`
  - [game-transfer.mjs#L225](file:///Users/limbo/Workspace/Myself/SaveHub/electron/game-transfer.mjs#L225)：`uniqueExportName(\`${...}-游戏导出\`, names)`
  - [game-templates.json#L1-L26](file:///Users/limbo/Workspace/Myself/SaveHub/shared/game-templates.json#L1-L26) 与 [GameForm.tsx#L108-L120](file:///Users/limbo/Workspace/Myself/SaveHub/src/modals/GameForm.tsx#L108-L120)
- **问题分析**：
  当用户将界面语言切换为英文（`en`）时：
  1. 导出存档或导出游戏生成的文件夹名称依然硬编码带中文后缀 `-存档导出`、`-游戏导出`，空名称兜底也是 `'未命名存档'`；
  2. 在新建游戏弹窗（[`GameForm.tsx`](file:///Users/limbo/Workspace/Myself/SaveHub/src/modals/GameForm.tsx#L112)）中，下拉框展示的是英文模板名（`gameName(item)`），但选中后执行 `setName(template.name)` 填入输入框的却是 [`game-templates.json`](file:///Users/limbo/Workspace/Myself/SaveHub/shared/game-templates.json) 中硬编码的中文名（如 `"艾尔登法环"`）。
- **优化建议**：
  1. 导出目录后缀与空名称兜底通过 `store.t()` 读取当前语言词典；
  2. [`GameForm.tsx#L112`](file:///Users/limbo/Workspace/Myself/SaveHub/src/modals/GameForm.tsx#L112) 在填入默认游戏名时使用 `gameName(template)` 而非原始 `template.name`。

---

### 12. 导入恢复点（`kind: 'safety'`）与保留上限 `0` 冲突时的“静默蒸发”问题

- **位置**：
  - [snapshot-import.mjs#L364-L367](file:///Users/limbo/Workspace/Myself/SaveHub/electron/snapshot-import.mjs#L364-L367)
  - [snapshot-import.mjs#L488-L497](file:///Users/limbo/Workspace/Myself/SaveHub/electron/snapshot-import.mjs#L488-L497)
- **问题分析**：
  如果用户将某游戏的恢复点保留上限设为 `0`（或小于本次导入的恢复点数量），随后导入了包含恢复点（`kind: 'safety'`）的备份：
  - [`executeImportPlan`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/snapshot-import.mjs#L364-L367) 会先将恢复点写入磁盘，并计入 `createdCount`；
  - 紧接着在第 492 行调用 `store.pruneRestorePoints(game.id)`，将这些刚刚导入的恢复点**静默物理删除**；
  - 最终前端弹窗依然提示“导入完成：新增 N 份存档，可在时光轴中查看”，但用户去时光轴和恢复点列表里根本找不到刚才导入的数据。
- **优化建议**：
  在 [`executeImportPlan`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/snapshot-import.mjs#L492) 统计 `pruneRestorePoints` 实际清理的条数并在 `ImportResult` 中展示提示，或在导入预览阶段检测到包含 `safety` 快照且当前恢复点上限不足时给出明确警告。

---

### 13. `Modal.tsx` 初始焦点落点错误（命中关闭按钮）与 Focus Trap 边界逃逸

- **位置**：
  - [Modal.tsx#L25](file:///Users/limbo/Workspace/Myself/SaveHub/src/modals/Modal.tsx#L25)
  - [Modal.tsx#L34-L48](file:///Users/limbo/Workspace/Myself/SaveHub/src/modals/Modal.tsx#L34-L48)
- **问题分析**：
  1. [`Modal.tsx#L25`](file:///Users/limbo/Workspace/Myself/SaveHub/src/modals/Modal.tsx#L25) 使用 `element?.querySelector<HTMLElement>('input, textarea, button')` 获取初始焦点。由于 `.modal-heading` 中的关闭按钮 `<button>` 在 DOM 树中永远位于 `.modal-body` 之前，打开任何带输入框的表单弹窗（如新建快照、添加游戏）时，**焦点永远落在右上角的 `X` 关闭按钮上，而非第一个输入框**；
  2. 第 42~47 行的 `Tab` 键拦截仅判断了 `document.activeElement === first` 或 `last`。如果用户用鼠标点击了弹窗内非控件空白处（此时 `activeElement` 为 `document.body`），按 `Shift + Tab` 会直接将焦点切出弹窗之外。
- **优化建议**：
  1. 初始焦点优先匹配 `.modal-body` 内的 `[data-autofocus], input:not([disabled]), textarea:not([disabled]), select:not([disabled])`，找不到时再回退到首个可聚焦按钮；
  2. 在 `Tab` 键监听中增加 `if (!ref.current?.contains(document.activeElement)) { event.preventDefault(); first.focus(); return; }`。

---

### 14. 分页列表“全选”语义不清及删除游戏后勾选状态残留

- **位置**：
  - [SnapshotList.tsx#L115-L118](file:///Users/limbo/Workspace/Myself/SaveHub/src/SnapshotList.tsx#L115-L118)、[L412-L420](file:///Users/limbo/Workspace/Myself/SaveHub/src/SnapshotList.tsx#L412-L420)
  - [AllGames.tsx#L67](file:///Users/limbo/Workspace/Myself/SaveHub/src/AllGames.tsx#L67)、[L146-L155](file:///Users/limbo/Workspace/Myself/SaveHub/src/AllGames.tsx#L146-L155)
  - [App.tsx#L819-L826](file:///Users/limbo/Workspace/Myself/SaveHub/src/App.tsx#L819-L826)
- **问题分析**：
  1. 当快照或游戏数量超过 100 条触发分页时，点击当前页顶部的“全选”复选框会一次性选中**所有分页**中的全部条目（包括第 2 页以后未渲染的条目），但界面没有任何“已跨页选中全部 N 项”的提示，批量删除时极易误删其他页的数据；
  2. 在 [`App.tsx#L819-L826`](file:///Users/limbo/Workspace/Myself/SaveHub/src/App.tsx#L819-L826) 删除单个已勾选的游戏后，未从 `gamesView.selectedIds` 中移除该游戏 ID；若用户在设置中恢复该游戏，它会莫名处于已勾选状态。
- **优化建议**：
  1. 在 `confirmRemoveGame` 成功后同步过滤 `gamesView.selectedIds`；
  2. 分页场景下表头复选框仅全选当前页（或全选所有页时在操作栏醒目提示“已跨页选中全部 N 项”）。

---

## 四、P3 · 工程化、类型安全与代码整洁度

### 15. `tsconfig.json` 未覆盖绝大多数 `scripts/*.mjs` 与 `tests/*.test.mjs`，且未开启 `noUncheckedIndexedAccess`

- **位置**：
  - [tsconfig.json#L18-L29](file:///Users/limbo/Workspace/Myself/SaveHub/tsconfig.json#L18-L29)
  - [App.tsx#L172-L173](file:///Users/limbo/Workspace/Myself/SaveHub/src/App.tsx#L172-L173)
- **问题分析**：
  1. `scripts/` 目录下共有 17 个脚本，但 [`tsconfig.json`](file:///Users/limbo/Workspace/Myself/SaveHub/tsconfig.json#L18-L29) 的 `include` 仅列入了 `e2e-harness.mjs` 和 `generate-preload.mjs`，其余 15 个脚本与 `tests/*.test.mjs` 均处于类型检查盲区；
  2. 未开启 `"noUncheckedIndexedAccess": true`，导致 [`App.tsx#L172`](file:///Users/limbo/Workspace/Myself/SaveHub/src/App.tsx#L172) 中 `const current = games.find(...) || games[0]` 在 `games` 为空数组时仍被推断为非空 `Game`，多处 `current.id` 失去编译器空安全保护。
- **优化建议**：
  将 `scripts/**/*.mjs` 与 `tests/**/*.mjs` 纳入 `tsconfig.json` 检查范围，并开启 `noUncheckedIndexedAccess: true`。

---

### 16. `shared/ipc-schema.mjs` 运行时校验粒度粗糙，且与 `shared/contracts.ts` 双轨手写维护

- **位置**：
  - [ipc-schema.mjs#L23-L30](file:///Users/limbo/Workspace/Myself/SaveHub/shared/ipc-schema.mjs#L23-L30)
  - [ipc-schema.mjs#L50](file:///Users/limbo/Workspace/Myself/SaveHub/shared/ipc-schema.mjs#L50)
  - [ipc-schema.mjs#L67-L70](file:///Users/limbo/Workspace/Myself/SaveHub/shared/ipc-schema.mjs#L67-L70)
  - [contracts.ts#L6-L31](file:///Users/limbo/Workspace/Myself/SaveHub/ tests/contracts.ts#L6-L31)
- **问题分析**：
  1. [`ipc-schema.mjs`](file:///Users/limbo/Workspace/Myself/SaveHub/shared/ipc-schema.mjs#L50) 中 `saveGame` 的校验器仅仅是 `['object']`，未校验必填字段；`saveSnapshot`、`updateSnapshot`、`updateSnapshots` 共用同一个宽泛的 `details` 校验器；
  2. [`tests/contracts.ts`](file:///Users/limbo/Workspace/Myself/SaveHub/tests/contracts.ts#L6-L31) 只校验了方法名（`keyof Bridge`）一致，未校验每个 channel 的参数个数和类型与 `Bridge` 签名一致。
- **优化建议**：
  按接口拆分精确的 schema 校验器（`saveGameInput`、`saveSnapshotInput`、`updateSnapshotInput`），并在 `tests/contracts.ts` 中补齐参数元组长度与类型的编译期断言。

---

### 17. 多语言词典存在 15+ 处死键（Dead i18n keys）及 `storage.mjs` 中保留了 16 个纯内部透传方法

- **位置**：
  - [zh.json](file:///Users/limbo/Workspace/Myself/SaveHub/shared/locales/zh.json) / [en.json](file:///Users/limbo/Workspace/Myself/SaveHub/shared/locales/en.json)
  - [storage.mjs#L1017-L1176](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L1017-L1176)
- **问题分析**：
  1. `zh.json` 与 `en.json` 中残留了大量已废弃功能的死键，例如：`modals.removeGame.*`（已被 `modals.deleteGame` 替代）、`settings.restoreGameProject`、`settings.noRemovedGames`、`settings.removedAt`、`settings.restoreProject`、`messages.removingGameProject`、`messages.restoringGameProject`、`messages.gameProjectRestored` 等；
  2. [`storage.mjs#L1017-L1176`](file:///Users/limbo/Workspace/Myself/SaveHub/electron/storage.mjs#L1017-L1176) 在拆分子模块后，仍在 `SaveStore` 类上保留了 16 个仅在子模块内部调用的私有辅助方法包装（如 `exportIndexCandidates`、`namedExportCandidates`、`writeExport`、`importReplacementPaths`、`readImportedSnapshotManifest` 等），增加了主类的认知噪音。
- **优化建议**：
  清理 `zh.json` / `en.json` 中无引用的死键（可编写单测校验词典键引用率），并将 `SaveStore` 上非外部契约的内部辅助方法收敛回各自的子模块内直接调用。

---

## 五、改进路线图（建议执行顺序）

| 阶段                                    |    优先级    | 核心动作                                                                                                                                                                                                                                                                            | 涉及文件                                                                                                                                                     |
| :-------------------------------------- | :----------: | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase 1：正确性与安全边界修复** | **P1** | 1. 剥离 `location()` 中的 `assertGameWritable`2. 在 `removeGame` / `purgeGame` / `executeGameImport` 补齐 `assertGameWritable`3. 补齐 `ProgressPanel` 的 `restoring` 与 `deleting` 阶段映射及类型4. 修复 `portable-smoke.mjs` 断言与 `withinOnDisk` 边界      | `electron/storage.mjselectron/game-transfer.mjs``electron/fs-utils.mjssrc/components/ProgressPanel.tsx``shared/contracts.tsscripts/portable-smoke.mjs` |
| **Phase 2：I/O 与数据结构优化**   | **P1** | 1. 重构 `classified-logger.mjs`（高低水位线裁剪、消除全量排序与逐条重写）2. 优化 `snapshots()` / `readSnapshot` 与 `copyRecords` 的冗余 `assertNoLinks`3. 精简 `restoreSnapshot` 重复的 `inventory` 全量哈希扫描4. 将游戏自定义图标从 `library.json` 剥离或预存哈希 | `electron/classified-logger.mjselectron/storage.mjs``electron/fs-utils.mjselectron/restore-transaction.mjs``electron/game-icons.mjs`                   |
| **Phase 3：国际化与交互细节打磨** | **P2** | 1. 修复导出文件夹名、兜底名与模板选择的中文硬编码2. 优化恢复点上限为 `0` 时的导入反馈3. 修复 `Modal.tsx` 初始焦点与 Focus Trap、分页全选与删除游戏勾选残留                                                                                                                      | `electron/snapshot-export.mjselectron/game-transfer.mjs``electron/snapshot-import.mjssrc/modals/GameForm.tsx``src/modals/Modal.tsxsrc/App.tsx`         |
| **Phase 4：工程化与死代码清理**   | **P3** | 1. 扩展 `tsconfig.json` 覆盖全部 `scripts` 与 `tests`2. 收紧 `ipc-schema.mjs` 字段级校验3. 清理 `zh.json` / `en.json` 死键与 `SaveStore` 内部透传包装                                                                                                                 | `tsconfig.jsonshared/ipc-schema.mjs``shared/locales/*.jsonelectron/storage.mjs`                                                                          |
