# SaveHub

[简体中文](README.md) | English

Cherish every adventure. A local game save manager built with **Electron + React + TypeScript**, supporting Windows and macOS Apple Silicon.

## Getting Started

Windows: Open `release/1.1.5/win-unpacked/SaveHub.exe`, or use the installer / portable executable under `release/1.1.5/`. Keep the entire `win-unpacked` folder intact—do not copy only the EXE file inside it. Close any running older version before launching the new version; existing data libraries work out of the box.

1. On first launch the library is empty. Add a game using an optional template or a blank project, then open **Game Settings**. Confirm the **Game Save Root Directory** for your current OS and the **Relative Paths to Back Up**.
2. Close the game, click **New Save**, and enter a name and optional notes.
3. Click **Restore** on a save and confirm that both the game and any cloud sync services that write to save files are closed. The dialog displays a larger red reminder; no checkbox is required before clicking **Confirm Restore**. SaveHub first automatically backs up and verifies your current progress before restoring the selected save; if the automatic backup fails, the restore stops immediately.
4. To undo a restore, find `Before Restore · …` (`读档前 · …`) under **Restore Points** on the right side of the timeline and click **Restore**.

Games added from templates can be edited or removed, and you can add any custom game. Icons support built-in emblems as well as local PNG / JPG / WebP / ICO images. Imported images are copied into the configuration directory so they do not depend on the original file remaining in place.

## All Games

**All Games** is the first workspace menu and default home, combining the former overview and management pages. Switch between the original card and list styles without losing search or selection; theme round trips preserve them too. The preferred style is remembered. Both views support add, edit, delete, restore, import and single / selected / all game exports.

- Deleting a game retains its settings and save records by default. **Permanently delete all save records for this game** physically removes the game settings, entire game vault directory and all records, including protected, favorite and trashed saves and restore points. The game disappears from the recoverable list. Live game files are unaffected.
- Export defaults to game settings, including names, icons, colors and Windows / macOS paths. **Include save records** also exports all records with their original states, timestamps, notes and integrity information.
- Import an entire game export bundle or an individual game folder. Duplicate identity or name matches offer per-item and bulk overwrite, skip and keep-both choices. Overwrite replaces settings while retaining existing saves; skipping a game also skips its bundled saves.
- Bundled saves have a separate conflict review using the existing overwrite restrictions and replacement rollback. No game settings or saves are written until final confirmation. Canceling either step leaves the library unchanged. Check local paths after importing.

See [game management format and verification](docs/游戏管理.md) for details. For the current 1.1.5 implementation and verified package boundaries, see [remediation results](docs/savehub_remediation_result.md).

## Optional Templates and Legacy Imports

New libraries start empty. Optional templates provide Elden Ring, Slay the Spire and Dark Souls II names, icons and common save entries. Select the actual local save folder and account subdirectory yourself. SaveHub does not read Desktop shell scripts or inject an author-specific Steam path.

The `source` variable in legacy scripts corresponds to the legacy backup folder. New saves created by SaveHub use an isolated vault and UUIDs rather than numbering folders by count, and will never overwrite legacy `ArchiveFile…` directories.

**Import Legacy Saves** copies all `ArchiveFile…` subdirectories inside a legacy backup folder, supporting custom suffixes such as `ArchiveFile0` or `ArchiveFile10th-DLC-1st-1level`. **Import Saves** also accepts a single legacy save folder, a single named export folder, or a batch export root folder, as well as legacy `manifest.json` / `collection.json` exports. When duplicates are detected, all duplicate items are listed in a single dialog where each item can independently be set to **Overwrite**, **Skip**, or **Keep Both** (or batch-configured and then adjusted individually) before clicking **Execute Import**. Nothing in the batch is written before confirmation, and cancelling aborts the entire batch import.

Within the same game, re-importing the same source directory is recognized as a duplicate even if its contents have been updated; different source directories are never merged solely because their file contents match. The default conflict action is **Skip**. **Overwrite** first copies and verifies the incoming files, then replaces the selected existing record while preserving its ID, creation time, favorite mark, and category state, and refreshing its modification time. If multiple existing records share the same source, you can choose the target. Protected local records only allow **Skip** or **Keep Both**. Unprotected Favorites, Recycle Bin records, Restore Points, and Removed Restore Points allow all three actions; choosing Overwrite displays the local state badges and a reminder below the options. Damaged records and unfinished permanent deletions still require resolving the underlying problem. **Keep Both** generates an independent ID and appends ` (2)`, ` (3)`, etc. to the name. Failed replacements restore the original, and interrupted transactions recover on next launch. Results list newly imported, overwritten, kept-both, skipped, and failed items separately; import source files remain untouched.

Imports and exports show a progress bar, percentage, current stage, and the record or file being processed. Batch progress includes verification, copying, and final maintenance; large file copies update by bytes transferred.

## Features

- Independent configurations and save vaults per game, storing Windows and macOS paths separately.
- Back up multiple files or directories at once, recursively preserving empty directories, file contents, and modification times.
- Save naming, notes, favorites, protection marks, search, SHA-256 integrity verification, import, and export.
- Click column headers (Save Name, Created Time, Size) to toggle ascending or descending order (defaults to Created Time descending); names use natural numeric sorting.
- Select individual saves or select all in the current list for batch protect, unprotect, move to Recycle Bin, recover, or export; protection actions provide separate buttons for "Selected" and "All".
- Favorite is purely a star badge and allows deletion. Single and batch deletion confirmations prominently highlight how many favorited records are included, and the batch list tags each with "Favorited"; upon confirmation, they move to the Recycle Bin normally with their favorite mark preserved.
- Protected saves cannot be deleted; if a selection contains any protected save, the entire batch deletion is blocked until protection is removed. Protecting and unprotecting never duplicate files.
- **All Saves** includes all non-deleted manual and imported records, including Favorited and Protected saves; both are filter badges that neither move records nor create copies. Recycle Bin records and Restore Points are excluded from All Saves.
- Batch export prompts for a destination folder only once; **Export All** exports every record in the current tab regardless of search keywords. In the Favorites, Protected, and Recycle Bin tabs, it exports only the records belonging to that respective tab.
- Automatically creates an independent **Restore Point** before every restore, using transactional replacement, failure rollback, and unfinished transaction recovery on next startup.
- Restore Points support multi-select and select-all removal; Recycle Bin and Removed Restore Points support multi-select and select-all recovery or permanent deletion. Permanent deletion requires a second confirmation and physically removes files from disk permanently.
- Default game deletion retains settings and backups for restoration from All Games → Deleted Games or Settings. Including saves permanently deletes the settings and entire game vault directory.
- Four persistent visual themes: **Xuan Paper & Ink**, **Crystal Tech**, **Neon Cyberpunk**, and **Frosted Glass**. The top-right theme button is the unified entry point; clicking it again returns to your previous page while preserving the active game, filter tab, search query, sort order, selection, and scroll position.
- Bilingual interface switching between **Simplified Chinese (`简体中文`)** and **English**, defaulting to Chinese; switchable anytime from the top-right toolbar button or in **Settings & About**, persisted across launches.
- Smooth transitions across route changes, filters, sorting, themes, and modals, respecting the OS `prefers-reduced-motion` setting.
- 100% local file operations—no account or server required. Never auto-syncs, runs background scheduled backups, or hooks into game processes.

## Saves & Badges

Every manually created or imported save has a single ID and a single copy of its payload. Favorite, Protected, and Recycle Bin states only update metadata flags on that record without duplicating files.

| View                   | Scope                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| All Saves              | All non-deleted manual or imported saves, including Favorited and Protected records; excludes Recycle Bin and Restore Points                       |
| Favorites              | Records marked as Favorite and not in the Recycle Bin; may also be marked as Protected                                                             |
| Protected              | Records marked as Protected and not in the Recycle Bin                                                                                             |
| Recycle Bin            | Deleted manual or imported records; can be recovered with original badges intact, or permanently deleted after confirmation                        |
| Restore Points         | Progress automatically backed up right before a restore; displayed separately and not counted in All Saves; can be restored to the game or removed |
| Removed Restore Points | Records removed from Restore Points; can be recovered back to the Restore Points list, or permanently deleted after confirmation                   |

You can add or remove the protection mark from a save's **More Actions** menu. Sidebar counts, game cards, timeline metrics, and All Saves statistics all reflect the **All Saves** scope. Toggling Favorite or Protected never changes a record's ID, directory path, or total count; the same record can appear in All Saves, Favorites, and Protected simultaneously. The Protected mark blocks soft deletion and permanent deletion, while still allowing restore and export; Favorite is used solely for marking and filtering and does not block deletion.

Saves in the Recycle Bin cannot have their protection mark modified: the toolbar hides the **Protect Selected / Unprotect Selected** and **Protect All / Unprotect All** buttons, and the protection toggle in the per-item menu is disabled. Recover the save first before changing its protection mark. Legacy records that were already marked as Protected inside the Recycle Bin in older versions must also be recovered first before removing protection. Any batch protection request that includes a Recycle Bin record is rejected before modifying any record.

**Select All in Current List** selects only valid saves currently visible after search and filter; switching tabs or changing the search query clears the current selection, and each game maintains its own independent list state. The batch protection "Selected" button processes only checked items, whereas the "All" button processes every save in the current tab regardless of the search query. For example, in **Favorites** it modifies protection only for favorited records; in **Protected** you can unprotect all records in that tab at once, after which they leave the Protected tab. Single-item favorite toggling remains available via the star button on each row.

In tabs other than the Recycle Bin, both protection buttons adapt dynamically based on the state of records within their respective scopes:

| Scope State                   | Selected Button             | All Button             | Click Action                        |
| ----------------------------- | --------------------------- | ---------------------- | ----------------------------------- |
| All Protected                 | Unprotect Selected          | Unprotect All          | Remove protection from all in scope |
| All Unprotected               | Protect Selected            | Protect All            | Add protection to all in scope      |
| Mixed Protected & Unprotected | Protect Selected            | Protect All            | Add protection to all in scope      |
| No Records                    | Protect Selected (Disabled) | Protect All (Disabled) | No action                           |

Protect actions use a green shield-check icon, while Unprotect actions use an amber shield-off icon, with distinct text, border, and background colors tailored for all four themes.

**Export Selected** can also export complete records from Protected or the Recycle Bin. **Export All** always exports the full scope of the current tab, including records hidden by a search filter, and is disabled when the current tab has no records. Even if there are no active saves, you can export all records in the Recycle Bin when viewing the Recycle Bin tab. Restore Points continue to be exported via their own dedicated button.

Deleting a regular save moves it to the **Recycle Bin**; removing a Restore Point moves it to **Removed Restore Points**. This step only updates metadata flags while leaving files on disk. Both deleted lists support multi-select and select-all followed by **Recover Selected** or **Delete Permanently**. The active Restore Points list also supports multi-select and select-all removal. **Recover** only restores the record to the active list in SaveHub without writing to the game directory; only **Restore** on a save or a Restore Point replaces your live game files.

The permanent deletion confirmation dialog lists every record to be deleted and explicitly warns that it **cannot be undone**. Favorited items are prominently badged without blocking deletion; if any Protected item is included, you must first recover it, remove protection, and move it back to the Recycle Bin before deleting permanently. Once permanent deletion succeeds, the backup directory, payload files, and manifest are physically removed from disk and cannot be recovered in the app (your live game save files remain untouched).

All exports (single save, selected saves, all saves in current tab, and Restore Points) create a new outer folder named `<Game Name>-SaveExport` (`游戏名-存档导出` in Chinese mode) inside the chosen destination directory. Inside it are subfolders named after each save along with the `.savehub-exports` metadata directory, and each named subfolder contains the raw game save files directly:

```text
Selected Export Directory/
  <Game Name>-SaveExport/
    A/                       Actual files & folders of Save A
    B/                       Actual files & folders of Save B
    C/                       Actual files & folders of Save C
    .savehub-exports/         Names, badges, notes & SHA-256 manifests for re-importing
```

Each export generates an independent outer folder, automatically appending ` (2)`, ` (3)`, etc. if a folder of the same name already exists; duplicate save names within the same batch are also numbered automatically without overwriting existing files. Illegal filename characters are sanitized for folder names while preserving the original game name and save names in the manifest. All contents are copied and verified in staging before being committed to the named output directory; if an export fails normally, the partial output from that run is cleaned up while preserving any pre-existing files. Moving or sharing the entire outer folder preserves original names, notes, favorites, and protection marks—simply select the outer folder (or any individual named save folder inside it) when importing. Legacy exports without an outer folder and `manifest.json` / `collection.json` exports remain fully importable. Exported Recycle Bin records are imported as normal active saves rather than deleted records.

Imported Restore Points retain their restore point category and removed state. Overwriting preserves the local target's category and state.

Automatic safety backups from v1.0.0 remain in their original location and have been displayed under **Restore Points** since v1.1.0 without copying or migrating files. v1.1.2 kept manual **Protected** saves separate from automatic **Restore Points** and shifted deletion protection from Favorites to Protected. v1.1.3 unified **All Saves** to include Favorited and Protected records and added batch permanent deletion and recovery. v1.1.4 required recovering Recycle Bin records before changing protection marks and added the dedicated outer folder for all exports. v1.1.5 introduced dual-queue 5/15 restore point retention with stable timestamp expiration, 20 MiB classified rolling logs, restore transactions with crash containment, disk space preflight checks, and unified game workspace management. Existing badges and save payloads require no migration.

## Storage & Recovery Rules

By default, the data library lives in Electron's `userData` directory (exact path shown in **Settings & About**): typically `%APPDATA%\SaveHub` on Windows and `~/Library/Application Support/SaveHub` on macOS. Development mode uses `.local-data` inside the project root. You can set `SAVEHUB_DATA_DIR` to point to a custom library directory for testing or local deployment; never let two processes share the same data library simultaneously.

```text
SaveHub/
  library.json                    Game configurations, theme & UI language
  library.json.previous           Previous configuration backup
  vault/<game-id>/
    game.json                     Custom game profile metadata
    snapshots/<snapshot-id>/
      manifest.json               Paths, timestamps, notes, flags & SHA-256 checksum manifest
      payload/                    Raw save files and directories
  transactions/                   Restore transaction journals
  import-transactions/            Import-overwrite transaction journals (cleaned up upon completion)
```

Backups are stored as plain files and directories rather than compressed archives, so you can inspect them directly at any time. Restoring a save replaces only the configured relative paths while leaving all other files in the game directory untouched; any newly created files inside the replaced target paths are removed to guarantee exact point-in-time restoration semantics. Restore Points also record configured paths that did not exist before the restore, ensuring those paths are removed again if you roll back using that Restore Point.

When creating a backup, files are first copied to a staging directory and verified against the source files, copied files, and SHA-256 manifest before being committed. When restoring, SaveHub first verifies the backup integrity, creates an automatic Restore Point of your current live files, stages the restore on the target disk, and swaps each item via atomic renames. If a restore fails, original files are rolled back automatically; if the process is unexpectedly terminated, unfinished transactions are recovered on the next startup using the transaction journal. Failed staging directories and journals are retained for diagnostics and may occupy disk space. Normal deletion only updates record metadata without freeing disk space; disk space is freed only when you execute **Delete Permanently** in the Recycle Bin or Removed Restore Points. Restore Points follow the automatic retention rules below.

Before permanent deletion, SaveHub preflight-checks the entire batch for record identity, deletion state, protection flags, and path safety. Each record persists a `purging` state before file removal begins; if a file is locked by another process or the app is interrupted, reopening SaveHub marks the record as **Incomplete Purge**, allowing you to run permanent deletion again to finish cleanup. Records that have started purging may be incomplete and cannot be recovered, edited, protected, or exported; batch operations report succeeded and failed items separately.

To prevent out-of-bounds writes, SaveHub rejects absolute backup item paths, `..` traversal segments, overlapping parent/child paths, case collisions, Windows reserved device names, symbolic links, and directory junctions. Selected root directories and relative paths must be readable and writable, and the SaveHub data library cannot overlap with the game files being backed up. If a save directory does not yet exist on disk, launch the game once to generate initial save files or create the directory manually first.

Closing the game and cloud sync before backing up or restoring is essential: SaveHub detects file changes before and after copy/swap operations, but cannot block external processes from writing concurrently. OS permission errors, disk hardware failures, or external programs continuously mutating files may still require manual intervention; SaveHub preserves safety backups and transaction logs to assist recovery.

## Windows & macOS

SaveHub uses a unified Electron and Node.js filesystem implementation with zero dependency on Bash, drive-letter string hacks, or `rm -rf`. macOS preset paths are left blank by default so you can choose the actual save folder on your Mac; macOS app compatibility does not imply that a game itself has a native macOS port. For games running via Wine or CrossOver, simply select the corresponding directory inside your compatibility bottle. SaveHub does not convert save file binary formats across platforms.

Minimum OS requirements follow the current Electron runtime: Windows 10 or later, and macOS 13 Ventura or later. macOS release targets are configured for **arm64** (Apple Silicon) only; Intel Mac builds are not produced. Windows builds currently target x64.

Historical verification (not evidence for this 1.1.5 build): on 2026-11-03, source tests, all four GUI test suites, and `pnpm dist:mac` packaging were verified on an Apple Silicon Mac (macOS 26.6), and the packaged `.app` passed the baseline GUI test suite. The macOS bundle uses ad-hoc signing (`build.mac.identity: "-"`), which prevents macOS from reporting the downloaded bundle as "damaged"; when opening on another Mac for the first time, allow it in **System Settings → Privacy & Security**. Before distributing to external users, configure Apple Developer ID signing and notarization (and remove `identity: "-"`); this repository does not include signing certificates or notarization credentials. Windows builds are also unsigned by default.

## Restore Point Retention and Logs

- Defaults are **5 active Restore Points / 15 Removed Restore Points** per game. Settings applies both global limits; Game Settings can override each limit independently or inherit the global value. Values must be nonnegative safe integers. **0 retains no records**.
- Both queues evict the oldest record **modification time (updatedAt)**. Active overflow moves to Removed Restore Points; removed overflow is physically deleted without additional prompts. Favorites and protection marks do not exempt restore points from these limits. Ordinary saves are unaffected.
- For active limit N, recovering K records requires **N > 0 and 1 ≤ K ≤ N**. Oversized batches are rejected in full. With N=0, both single and batch recovery are disabled. A valid recovery refreshes modification time, preserves creation time, then applies both queue limits even if the active queue was already full.
- Transaction safety copies survive until commit or successful rollback, including 0/0 settings. Legacy libraries adopt 5/15; a missing updatedAt uses the valid creation time. Old maxRestorePoints=0 does not mean unlimited retention anymore. Review limits before upgrading an existing library.
- Imports finish the entire batch before applying both queue limits, including when a limit is 0. Combined game imports finish all games and bundled saves before pruning. Successful import counts describe completed imports; fewer records may remain after retention.
- Runtime logs share a configurable total capacity in **Settings & About → Log retention**, defaulting to **20 MB (20,971,520 bytes)**. Nonnegative whole numbers are accepted; oldest complete records are trimmed globally when the limit is exceeded or reduced. **0 clears existing application logs and stops retaining new logs**, including after restart. Transaction recovery files are excluded. Settings also provides a button to open the log directory.

## Development & Build

For complete maintainer instructions, see the [Development, Build, Run & Release Guide](docs/开发与发布指南.en.md) ([中文版](docs/开发与发布指南.md)), which covers environment setup, all project commands, production preview, packaged binary verification, SHA-256 release auditing, Windows / macOS packaging, CI workflows, remote releases, and crash/interruption recovery.

See [1.1.5 remediation results](docs/savehub_remediation_result.md) for current source and actual Windows package evidence. Historical 1.1.4 artifacts remain unchanged. This round still requires native macOS Apple Silicon verification.

The SaveHub Logo features an S-shaped save trajectory with checkpoint nodes in deep teal, light cream, and crimson. The app sidebar, splash screen, Settings & About page, browser tab, and desktop icon all share the same unified design; the source SVG, 1024px PNG, and multi-resolution Windows ICO reside in `build/`. See [Logo Asset Guide](build/README.md) for regeneration details.

Git tracks source code, test scripts, build configurations, the pnpm lockfile, icon assets in `build/`, and hand-written documentation. Dependencies, build outputs, local save vaults, test data, auto-generated screenshots and verification JSON reports, logs, and machine-local environment files are excluded via `.gitignore` (ignoring rules never delete existing local files).

Current reports, screenshots and traces are written under `test-results/`; `docs/screenshots/` preserves historical evidence. Release audit JSON files are generated locally or in CI. `.env.example` and shared VS Code configurations may be committed.

Environment: Node.js 22.12+ (Node.js 24 recommended), pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm dev                 # Vite + Electron using .local-data
pnpm lint
pnpm format:check
pnpm check:contracts
pnpm test:e2e           # Playwright runner, per-run reports and traces
node scripts/test-package.mjs # Runs the actual packaged application
node scripts/benchmark.mjs    # Summary-cache and real-payload measurements
node scripts/benchmark-ui.mjs # UI measurements with 100 / 1,000 / 10,000 summaries
pnpm checksums
pnpm test                # Real filesystem storage tests on temporary directories
pnpm build               # TypeScript typecheck + Vite frontend production build
pnpm build:icons         # Regenerate PNG and Windows ICO after editing Logo SVG
pnpm test:ui             # Electron E2E smoke test & 4-theme screenshots
pnpm test:interactions   # Theme return, batch actions, badges, sorting & transitions
pnpm test:deletion       # Batch recover, permanent delete & interrupted purge retry
pnpm test:import         # Per-item duplicate import resolution, mixed batch, cancel & 4 themes
pnpm test:games          # All Games drag reorder, card/list toggle, 2-stage import/export & permanent delete
pnpm test:retention      # Dual-queue restore point retention, oversized batch rejection & zero-limit disabling
pnpm test:optimizations  # Overwrite state badges, log capacity, transfer progress and restore reminders
pnpm pack:win            # Windows unpacked directory build
pnpm dist:win            # Windows NSIS installer + single-file portable executable
pnpm pack:mac            # macOS arm64 unpacked bundle (.app)
pnpm dist:mac            # Build arm64 DMG + ZIP on macOS
pnpm test:portable       # Unpack, launch & save/restore verification for Windows portable EXE
pnpm audit:release       # Verify the current platform ASAR and release digests
```

After building, `pnpm start` opens the production UI inside Electron. All dependency versions are pinned with `pnpm-lock.yaml`. Installing dependencies downloads the official Electron runtime; if network access is restricted, refer to the mirror configuration in the [Electron Installation Guide](https://www.electronjs.org/docs/latest/tutorial/installation) (downloaded archives are still verified against the official checksums bundled in the package).

`.github/workflows/build.yml` runs focused Windows checks for PRs, and full Windows x64 / macOS arm64 source and package verification for main branches and tags. Tags create an audited draft Release; publication remains manual. Remote CI has not been executed in this verification round.

## Project Structure

```text
electron/storage.mjs       Backup, full restore, SHA-256 verification, transaction rollback, import/export
electron/presets.mjs       Explicit legacy literal parser & test fixture helpers
electron/main.mjs          Electron window lifecycle, native dialogs & IPC security boundaries
electron/i18n.mjs          Main-process & storage-layer i18n dictionaries and key resolver
electron/preload.cjs       Minimal, explicitly enumerated renderer bridge API
electron/retention.mjs     Two-queue retention and batch recovery validation
electron/restore-transaction.mjs Restore commit, rollback and startup recovery
electron/classified-logger.mjs Configurable classified runtime logs (20 MB by default)
shared/                   Shared IPC contracts, locales and optional templates
src/pages/, src/hooks/    Extracted pages and application data hook
src/i18n/                  Frontend i18n module (language registry, ZH/EN locale dictionaries & typed keys)
src/App.tsx                Game library, save timeline, edit forms, theme & language switching
src/format.ts              Localized date, preset game name & byte size formatting
src/SnapshotList.tsx       Badge filter views, selection, batch actions & column sorting
src/RestorePoints.tsx      Restore Points & Removed Restore Points selection, recovery & deletion
src/ImportDialog.tsx       Per-item duplicate import resolution, batch quick-set & import summary
src/motion.ts              View transitions & reduced-motion adaptation
src/art.tsx                Local SVG illustrations & game emblems
src/styles.css             Layout, form & modal styling
src/list.css               Save list, batch action bar, restore points & transition styling
src/themes.css             Four complete visual themes
tests/contracts.ts         Compile-time cross-process IPC contract & type checks
tests/storage.test.mjs     Filesystem operations & transactional recovery unit/integration tests
tests/games.test.mjs       Game reordering, import/export, conflict resolution & full vault purge tests
tests/import.test.mjs      Mixed import, overwrite rollback & real child-process crash recovery tests
tests/optimization.test.mjs Overwrite state matrix, post-import retention pruning, progress & log capacity tests
tests/remediation.test.mjs Corrupt transaction isolation, recovery boundary table, IPC schema & disk budget tests
tests/e2e/desktop.spec.ts  Playwright desktop E2E runner entry point
scripts/smoke.mjs          Electron E2E smoke check on an isolated test vault
scripts/interactions.mjs   Theme return, selection sorting, batch file operations & state semantics
scripts/deletion-interactions.mjs Real recovery, permanent deletion & retry for Recycle Bin / Restore Points
scripts/import-interactions.mjs Duplicate import resolution, cancellation & 4-theme UI verification
scripts/game-interactions.mjs All Games drag reorder, view switching, 2-stage import/export & permanent delete
scripts/retention-interactions.mjs Dual-queue retention, batch recovery limits & fresh empty library checks
scripts/optimization-interactions.mjs Local state badges, progress bar, log capacity & restore warning checks
scripts/portable-smoke.mjs Real launch & save/restore verification for the single-file portable EXE
scripts/test-package.mjs   Packaged application E2E regression entry point for the current platform
scripts/test-apfs.mjs      Apple Silicon case-sensitive & case-insensitive APFS disk image verification
scripts/test-installer.ps1 Windows NSIS installation, installed-app regression & uninstall verification
scripts/benchmark.mjs      Summary-cache & real-payload I/O performance benchmark
scripts/benchmark-ui.mjs   UI performance benchmark with 100 / 1,000 / 10,000 summaries
scripts/audit-release.mjs  Packaged ASAR source comparison & SHA-256 release digest audit
scripts/e2e-harness.mjs   E2E launch, target identity, trace, report and cleanup
test-results/             Per-run reports, screenshots and trace archives
```

Electron runs with `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`, blocks arbitrary navigation and pop-up windows, and validates the sender window and frame on every IPC call in accordance with the [Electron Security Guidelines](https://www.electronjs.org/docs/latest/tutorial/security). The renderer process has no direct filesystem access. All themes and SVG illustrations are bundled locally with zero external font or image network requests.

## Verification Records

`tests/storage.test.mjs` covers real file copying and SHA-256 verification, full directory replacement, multi-game isolation, Restore Point rollback, missing-path restoration, corrupted backup rejection, concurrent file modification detection, failure rollback, startup transaction recovery, symlink/junction protection, legacy backup deduplication, export and re-import, Recycle Bin workflows, configuration persistence (including theme and UI language), and concurrent mutation rejection. Additional tests verify physical file removal after permanent deletion, full-batch preflight and protection blocking, interrupted purge recovery and retry across restarts, batch Restore Point recovery, favorite deletion allowance and badge preservation, protected deletion blocking, batch protection scopes and partial failure handling, pre-restore automatic backup ordering and failure abort, named folder export, name collision numbering and illegal character sanitization, failed export cleanup, and legacy export format compatibility. On Windows, temporary staging directory commits retry up to 4 times (waiting up to 500ms total) on transient file locks; persistent permission errors still fail safely without overwriting existing committed directories.

`scripts/smoke.mjs` launches a real Electron instance against synthetic game files in an isolated directory to test creating saves, searching, favoriting, confirming restores, verifying disk contents, Recycle Bin operations, adding/removing games, switching between all four themes, and toggling between Chinese and English UI languages. Screenshots depict synthetic test data—**never a user's real game progress**. Test data is cleaned up automatically when the run finishes, and real game saves are never read or modified.

Verification of the duplicate import workflow on 2026-11-02: all 73 storage tests passed, including mixed conflict choices, cancellation, failed overwrite rollback, recovery from two real child-process termination points, and post-commit cleanup retries. Production build and strict TypeScript checks passed; baseline UI (11 checks), interactions (16 checks), deletion suite (6 checks), and import suite (6 checks) all passed with 0 renderer errors. The import suite also verified minimum-window layout across all four themes, preservation of custom overwrite targets during batch quick-set, and zero disk writes prior to confirmation. Reports are saved to `docs/screenshots/import-verification.json` with screenshots `import-conflicts-*.png` and `import-results.png`.

On the same day, the Recycle Bin toolbar and Logo updates passed production build, strict TypeScript checks, and three Electron GUI regression suites: baseline UI (12 checks), interactions (16 checks), and deletion suite (6 checks) with 0 renderer errors. Confirmed that both protection buttons are hidden in the Recycle Bin while working normally in other tabs, the new Logo renders cleanly across all four themes, and the multi-resolution Windows ICO loads properly via native OS image APIs.

The single-file Windows portable executable is unpacked by an NSIS launcher before starting Electron; `scripts/portable-smoke.mjs` connects to the actual window via a test-only localhost debugging port to verify the version, UI assets, startup, backup, restore, automatic Restore Point creation, and clean exit without relying on stdout forwarding from the launcher. For current delivery evidence, see [1.1.5 Acceptance Record](docs/验收记录-1.1.5.md) and [1.1.5 remediation results](docs/savehub_remediation_result.md); [1.1.4 Acceptance Record](docs/验收记录-1.1.4.md); historical records for [1.1.3](docs/验收记录-1.1.3.md), [1.1.2](docs/验收记录-1.1.2.md), [1.1.1](docs/验收记录-1.1.1.md), [1.1.0](docs/验收记录-1.1.0.md), and [1.0.0](docs/验收记录.md) are preserved.
