# SaveHub

[简体中文](README.md) | English

Cherish every adventure. A local game save manager built with **Electron + React + TypeScript**, supporting Windows and macOS Apple Silicon.

## Getting Started

Windows: Open `release/1.1.4/win-unpacked/SaveHub.exe`, or use the installer / portable executable under `release/1.1.4/`. Keep the entire `win-unpacked` folder intact—do not copy only the EXE file inside it. Close any running older version before launching the new version; existing data libraries work out of the box.

1. Select a game and open **Game Settings**. Confirm the **Game Save Root Directory** for your current OS and the **Relative Paths to Back Up**.
2. Close the game, click **New Save**, and enter a name and optional notes.
3. Click **Restore** on a save and confirm that both the game and any cloud sync services that write to save files are closed. SaveHub first automatically backs up and verifies your current progress before restoring the selected save; if the automatic backup fails, the restore stops immediately.
4. To undo a restore, find `Before Restore · …` (`读档前 · …`) under **Restore Points** on the right side of the timeline and click **Restore**.

Preset games can be edited or removed, and you can add any custom game. Icons support built-in emblems as well as local PNG / JPG / WebP / ICO images. Imported images are copied into the configuration directory so they do not depend on the original file remaining in place.

## All Games

**All Games** is the first workspace menu and default home, combining the former overview and management pages. Switch between the original card and list styles without losing search or selection; theme round trips preserve them too. The preferred style is remembered. Both views support add, edit, delete, restore, import and single / selected / all game exports.

- Deleting a game retains its settings and save records by default. **Permanently delete all save records for this game** physically removes the game settings, entire game vault directory and all records, including protected, favorite and trashed saves and restore points. The game disappears from the recoverable list. Live game files are unaffected.
- Export defaults to game settings, including names, icons, colors and Windows / macOS paths. **Include save records** also exports all records with their original states, timestamps, notes and integrity information.
- Import an entire game export bundle or an individual game folder. Duplicate identity or name matches offer per-item and bulk overwrite, skip and keep-both choices. Overwrite replaces settings while retaining existing saves; skipping a game also skips its bundled saves.
- Bundled saves have a separate conflict review using the existing overwrite restrictions and replacement rollback. No game settings or saves are written until final confirmation. Canceling either step leaves the library unchanged. Check local paths after importing.

See [game management format and verification](docs/游戏管理.md) for details. These changes are in source and `dist/`; existing `release/1.1.4/` installers require rebuilding to include them.

## Reference Scripts & Mapping

SaveHub was designed with compatibility for legacy `save.sh` / `load.sh` backup scripts from these three games:

| Game | Original Script Root Directory (`target`) | Backup Items (`array`) |
| --- | --- | --- |
| Slay the Spire | `D:\Steam\steamapps\common\SlayTheSpire` | `betaPreferences`, `preferences`, `saves` |
| Elden Ring | `%USERPROFILE%\AppData\Roaming\EldenRing` | `Steam Account ID` (`Steam账户ID`) |
| Dark Souls II | `%USERPROFILE%\AppData\Roaming\DarkSoulsII` | `Steam Account ID` (`Steam账户ID`) |

On first launch on Windows, SaveHub attempts to read `save.sh` from matching folders on the user's Desktop, parsing only literal values for `source` / `target` / `array`—**it never executes the script**. When no script is found, the root directory presets above are used; Elden Ring and Dark Souls II do not prefill an account folder, so you should enter your own `Steam Account ID` (`Steam账户ID`) directory in **Game Settings**. All paths and account directories can be manually edited.

The `source` variable in legacy scripts corresponds to the legacy backup folder. New saves created by SaveHub use an isolated vault and UUIDs rather than numbering folders by count, and will never overwrite legacy `ArchiveFile…` directories.

**Import Legacy Saves** copies all `ArchiveFile…` subdirectories inside a legacy backup folder, supporting custom suffixes such as `ArchiveFile0` or `ArchiveFile10th-DLC-1st-1level`. **Import Saves** also accepts a single legacy save folder, a single named export folder, or a batch export root folder, as well as legacy `manifest.json` / `collection.json` exports. When duplicates are detected, all duplicate items are listed in a single dialog where each item can independently be set to **Overwrite**, **Skip**, or **Keep Both** (or batch-configured and then adjusted individually) before clicking **Execute Import**. Nothing in the batch is written before confirmation, and cancelling aborts the entire batch import.

Within the same game, re-importing the same source directory is recognized as a duplicate even if its contents have been updated; different source directories are never merged solely because their file contents match. The default conflict action is **Skip**. **Overwrite** first copies and verifies the incoming files, then replaces the selected existing record while preserving its ID, creation time, and favorite mark; if multiple existing records share the same source, you can choose which target record to overwrite. Protected saves, Recycle Bin records, and Restore Points cannot be overwritten—you can choose **Skip** or **Keep Both** instead. **Keep Both** generates an independent ID and appends ` (2)`, ` (3)`, etc. to the name. If an overwrite fails, the original record is restored, and interrupted transactions are recovered on next launch. The import summary lists newly imported, overwritten, kept-both, skipped, and failed items separately; source files being imported are always left untouched.

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

| View | Scope |
| --- | --- |
| All Saves | All non-deleted manual or imported saves, including Favorited and Protected records; excludes Recycle Bin and Restore Points |
| Favorites | Records marked as Favorite and not in the Recycle Bin; may also be marked as Protected |
| Protected | Records marked as Protected and not in the Recycle Bin |
| Recycle Bin | Deleted manual or imported records; can be recovered with original badges intact, or permanently deleted after confirmation |
| Restore Points | Progress automatically backed up right before a restore; displayed separately and not counted in All Saves; can be restored to the game or removed |
| Removed Restore Points | Records removed from Restore Points; can be recovered back to the Restore Points list, or permanently deleted after confirmation |

You can add or remove the protection mark from a save's **More Actions** menu. Sidebar counts, game cards, timeline metrics, and All Saves statistics all reflect the **All Saves** scope. Toggling Favorite or Protected never changes a record's ID, directory path, or total count; the same record can appear in All Saves, Favorites, and Protected simultaneously. The Protected mark blocks soft deletion and permanent deletion, while still allowing restore and export; Favorite is used solely for marking and filtering and does not block deletion.

Saves in the Recycle Bin cannot have their protection mark modified: the toolbar hides the **Protect Selected / Unprotect Selected** and **Protect All / Unprotect All** buttons, and the protection toggle in the per-item menu is disabled. Recover the save first before changing its protection mark. Legacy records that were already marked as Protected inside the Recycle Bin in older versions must also be recovered first before removing protection. Any batch protection request that includes a Recycle Bin record is rejected before modifying any record.

**Select All in Current List** selects only valid saves currently visible after search and filter; switching tabs or changing the search query clears the current selection, and each game maintains its own independent list state. The batch protection "Selected" button processes only checked items, whereas the "All" button processes every save in the current tab regardless of the search query. For example, in **Favorites** it modifies protection only for favorited records; in **Protected** you can unprotect all records in that tab at once, after which they leave the Protected tab. Single-item favorite toggling remains available via the star button on each row.

In tabs other than the Recycle Bin, both protection buttons adapt dynamically based on the state of records within their respective scopes:

| Scope State | Selected Button | All Button | Click Action |
| --- | --- | --- | --- |
| All Protected | Unprotect Selected | Unprotect All | Remove protection from all in scope |
| All Unprotected | Protect Selected | Protect All | Add protection to all in scope |
| Mixed Protected & Unprotected | Protect Selected | Protect All | Add protection to all in scope |
| No Records | Protect Selected (Disabled) | Protect All (Disabled) | No action |

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

Automatic safety backups from v1.0.0 remain in their original location and have been displayed under **Restore Points** since v1.1.0 without copying or migrating files. v1.1.2 kept manual **Protected** saves separate from automatic **Restore Points** and shifted deletion protection from Favorites to Protected. v1.1.3 unified **All Saves** to include Favorited and Protected records and added batch permanent deletion and recovery. v1.1.4 required recovering Recycle Bin records before changing protection marks and added the dedicated outer folder for all exports. Existing badges and save payloads require no migration.

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

When creating a backup, files are first copied to a staging directory and verified against the source files, copied files, and SHA-256 manifest before being committed. When restoring, SaveHub first verifies the backup integrity, creates an automatic Restore Point of your current live files, stages the restore on the target disk, and swaps each item via atomic renames. If a restore fails, original files are rolled back automatically; if the process is unexpectedly terminated, unfinished transactions are recovered on the next startup using the transaction journal. Failed staging directories and journals are retained for diagnostics and may occupy disk space. Normal deletion only updates record metadata without freeing disk space; disk space is freed only when you execute **Delete Permanently** in the Recycle Bin or Removed Restore Points. SaveHub never auto-deletes Restore Points.

Before permanent deletion, SaveHub preflight-checks the entire batch for record identity, deletion state, protection flags, and path safety. Each record persists a `purging` state before file removal begins; if a file is locked by another process or the app is interrupted, reopening SaveHub marks the record as **Incomplete Purge**, allowing you to run permanent deletion again to finish cleanup. Records that have started purging may be incomplete and cannot be recovered, edited, protected, or exported; batch operations report succeeded and failed items separately.

To prevent out-of-bounds writes, SaveHub rejects absolute backup item paths, `..` traversal segments, overlapping parent/child paths, case collisions, Windows reserved device names, symbolic links, and directory junctions. Selected root directories and relative paths must be readable and writable, and the SaveHub data library cannot overlap with the game files being backed up. If a save directory does not yet exist on disk, launch the game once to generate initial save files or create the directory manually first.

Closing the game and cloud sync before backing up or restoring is essential: SaveHub detects file changes before and after copy/swap operations, but cannot block external processes from writing concurrently. OS permission errors, disk hardware failures, or external programs continuously mutating files may still require manual intervention; SaveHub preserves safety backups and transaction logs to assist recovery.

## Windows & macOS

SaveHub uses a unified Electron and Node.js filesystem implementation with zero dependency on Bash, drive-letter string hacks, or `rm -rf`. macOS preset paths are left blank by default so you can choose the actual save folder on your Mac; macOS app compatibility does not imply that a game itself has a native macOS port. For games running via Wine or CrossOver, simply select the corresponding directory inside your compatibility bottle. SaveHub does not convert save file binary formats across platforms.

Minimum OS requirements follow the current Electron runtime: Windows 10 or later, and macOS 13 Ventura or later. macOS release targets are configured for **arm64** (Apple Silicon) only; Intel Mac builds are not produced. Windows builds currently target x64.

On 2026-11-03, source tests, all four GUI test suites, and `pnpm dist:mac` packaging were verified on an Apple Silicon Mac (macOS 26.6), and the packaged `.app` passed the baseline GUI test suite. The macOS bundle uses ad-hoc signing (`build.mac.identity: "-"`), which prevents macOS from reporting the downloaded bundle as "damaged"; when opening on another Mac for the first time, allow it in **System Settings → Privacy & Security**. Before distributing to external users, configure Apple Developer ID signing and notarization (and remove `identity: "-"`); this repository does not include signing certificates or notarization credentials. Windows builds are also unsigned by default.

## Development & Build

For complete maintainer instructions, see the [Development, Build, Run & Release Guide](docs/开发与发布指南.en.md) ([中文版](docs/开发与发布指南.md)), which covers environment setup, all project commands, production preview, packaged binary verification, SHA-256 release auditing, Windows / macOS packaging, CI workflows, remote releases, and crash/interruption recovery.

As of 2026-11-02, the source tree includes current-tab batch export, protection scope adjustments, per-item duplicate import resolution, hidden protection buttons in the Recycle Bin, and the unified SaveHub Logo, which have not yet been repackaged into the historical `1.1.4` installer artifacts. The guide distinguishes between current source verification and historical release package verification; the next release should be packaged and audited under a new version directory.

The SaveHub Logo features an S-shaped save trajectory with checkpoint nodes in deep teal, light cream, and crimson. The app sidebar, splash screen, Settings & About page, browser tab, and desktop icon all share the same unified design; the source SVG, 1024px PNG, and multi-resolution Windows ICO reside in `build/`. See [Logo Asset Guide](build/README.md) for regeneration details.

Git tracks source code, test scripts, build configurations, the pnpm lockfile, icon assets in `build/`, and hand-written documentation. Dependencies, build outputs, local save vaults, test data, auto-generated screenshots and verification JSON reports, logs, and machine-local environment files are excluded via `.gitignore` (ignoring rules never delete existing local files).

`docs/screenshots/` and release audit JSON files are local or CI verification artifacts that can be regenerated using the test and audit commands below. `.env.example` and shared VS Code configurations may be committed.

Environment: Node.js 22.12+ (Node.js 24 recommended), pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm dev                 # Vite + Electron using .local-data
pnpm test                # Real filesystem storage tests on temporary directories
pnpm build               # TypeScript typecheck + Vite frontend production build
pnpm build:icons         # Regenerate PNG and Windows ICO after editing Logo SVG
pnpm test:ui             # Electron E2E smoke test & 4-theme screenshots
pnpm test:interactions   # Theme return, batch actions, badges, sorting & transitions
pnpm test:deletion       # Batch recover, permanent delete & interrupted purge retry
pnpm test:import         # Per-item duplicate import resolution, mixed batch, cancel & 4 themes
pnpm pack:win            # Windows unpacked directory build
pnpm dist:win            # Windows NSIS installer + single-file portable executable
pnpm pack:mac            # macOS arm64 unpacked bundle (.app)
pnpm dist:mac            # Build arm64 DMG + ZIP on macOS
pnpm test:portable       # Unpack, launch & save/restore verification for Windows portable EXE
pnpm audit:release       # Verify packaged Windows ASAR contents & release SHA-256 digests
```

After building, `pnpm start` opens the production UI inside Electron. All dependency versions are pinned with `pnpm-lock.yaml`. Installing dependencies downloads the official Electron runtime; if network access is restricted, refer to the mirror configuration in the [Electron Installation Guide](https://www.electronjs.org/docs/latest/tutorial/installation) (downloaded archives are still verified against the official checksums bundled in the package).

`.github/workflows/build.yml` provides a GitHub Actions workflow for Windows and macOS builds that uploads build artifacts for download without automatically publishing a GitHub Release.

## Project Structure

```text
electron/storage.mjs       Backup, full restore, SHA-256 verification, transaction rollback, import/export
electron/presets.mjs       Literal parser for legacy scripts & default game presets
electron/main.mjs          Electron window lifecycle, native dialogs & IPC security boundaries
electron/i18n.mjs          Main-process & storage-layer i18n dictionaries and key resolver
electron/preload.cjs       Minimal, explicitly enumerated renderer bridge API
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
tests/storage.test.mjs     Filesystem operations & transactional recovery unit/integration tests
tests/import.test.mjs      Mixed import, overwrite rollback & real child-process crash recovery tests
scripts/smoke.mjs          Electron E2E smoke check on an isolated test vault
scripts/interactions.mjs   Theme return, selection sorting, batch file operations & state semantics
scripts/deletion-interactions.mjs Real recovery, permanent deletion & retry for Recycle Bin / Restore Points
scripts/import-interactions.mjs Duplicate import resolution, cancellation & 4-theme UI verification
scripts/portable-smoke.mjs Real launch & save/restore verification for the single-file portable EXE
scripts/audit-release.mjs  Packaged ASAR source comparison & SHA-256 release digest audit
docs/screenshots/          Test theme screenshots & JSON verification reports
```

Electron runs with `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`, blocks arbitrary navigation and pop-up windows, and validates the sender window and frame on every IPC call in accordance with the [Electron Security Guidelines](https://www.electronjs.org/docs/latest/tutorial/security). The renderer process has no direct filesystem access. All themes and SVG illustrations are bundled locally with zero external font or image network requests.

## Verification Records

`tests/storage.test.mjs` covers real file copying and SHA-256 verification, full directory replacement, multi-game isolation, Restore Point rollback, missing-path restoration, corrupted backup rejection, concurrent file modification detection, failure rollback, startup transaction recovery, symlink/junction protection, legacy backup deduplication, export and re-import, Recycle Bin workflows, configuration persistence (including theme and UI language), and concurrent mutation rejection. Additional tests verify physical file removal after permanent deletion, full-batch preflight and protection blocking, interrupted purge recovery and retry across restarts, batch Restore Point recovery, favorite deletion allowance and badge preservation, protected deletion blocking, batch protection scopes and partial failure handling, pre-restore automatic backup ordering and failure abort, named folder export, name collision numbering and illegal character sanitization, failed export cleanup, and legacy export format compatibility. On Windows, temporary staging directory commits retry up to 4 times (waiting up to 500ms total) on transient file locks; persistent permission errors still fail safely without overwriting existing committed directories.

`scripts/smoke.mjs` launches a real Electron instance against synthetic game files in an isolated directory to test creating saves, searching, favoriting, confirming restores, verifying disk contents, Recycle Bin operations, adding/removing games, switching between all four themes, and toggling between Chinese and English UI languages. Screenshots depict synthetic test data—**never a user's real game progress**. Test data is cleaned up automatically when the run finishes, and real game saves are never read or modified.

Verification of the duplicate import workflow on 2026-11-02: all 73 storage tests passed, including mixed conflict choices, cancellation, failed overwrite rollback, recovery from two real child-process termination points, and post-commit cleanup retries. Production build and strict TypeScript checks passed; baseline UI (11 checks), interactions (16 checks), deletion suite (6 checks), and import suite (6 checks) all passed with 0 renderer errors. The import suite also verified minimum-window layout across all four themes, preservation of custom overwrite targets during batch quick-set, and zero disk writes prior to confirmation. Reports are saved to `docs/screenshots/import-verification.json` with screenshots `import-conflicts-*.png` and `import-results.png`.

On the same day, the Recycle Bin toolbar and Logo updates passed production build, strict TypeScript checks, and three Electron GUI regression suites: baseline UI (12 checks), interactions (16 checks), and deletion suite (6 checks) with 0 renderer errors. Confirmed that both protection buttons are hidden in the Recycle Bin while working normally in other tabs, the new Logo renders cleanly across all four themes, and the multi-resolution Windows ICO loads properly via native OS image APIs.

The single-file Windows portable executable is unpacked by an NSIS launcher before starting Electron; `scripts/portable-smoke.mjs` connects to the actual window via a test-only localhost debugging port to verify the version, UI assets, startup, backup, restore, automatic Restore Point creation, and clean exit without relying on stdout forwarding from the launcher. For detailed delivery records, see [1.1.4 Acceptance Record](docs/验收记录-1.1.4.md); historical records for [1.1.3](docs/验收记录-1.1.3.md), [1.1.2](docs/验收记录-1.1.2.md), [1.1.1](docs/验收记录-1.1.1.md), [1.1.0](docs/验收记录-1.1.0.md), and [1.0.0](docs/验收记录.md) are preserved.

