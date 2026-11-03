import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Archive, ArrowRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3, ExternalLink, Folder, FolderOpen, Gamepad2, HardDrive, History, Info, Languages, LayoutGrid, Library, LoaderCircle, Monitor, Paintbrush, Plus, RotateCcw, Settings2, ShieldCheck, Sparkles, Star, Trash2, Upload, X } from 'lucide-react';
import { GameGlyph, Landscape, Logo } from './art';
import { SnapshotList, defaultView, matchesFilter, type LibraryView, type SnapshotAction } from './SnapshotList';
import { dateLabel, fullDate, formatBytes, gameName, kindLabel, setFormatLanguage, tr } from './format';
import { RestorePoints, type PointSelection } from './RestorePoints';
import { ImportConflicts, ImportResult } from './ImportDialog';
import { animate } from './motion';
import type { AppState, BatchReport, Bridge, Game, GameInput, ImportDecision, ImportPlan, ImportReport, Language, Platform, Progress, Snapshot, Theme } from './types';

const getThemes = (): { id: Theme; name: string; english: string; caption: string; description: string }[] => [
  { id: 'ink', name: tr('水墨', 'Ink'), english: 'INK & PAPER', caption: tr('一墨一世界', 'INK & REALM'), description: tr('宣纸肌理、淡墨远山与一抹朱红，在留白中安放你的冒险。', 'Rice-paper texture, distant ink mountains, and a touch of vermilion—resting your adventures in calm whitespace.') },
  { id: 'tech', name: '科技' === tr('科技', 'Luminous') ? '科技' : 'Luminous', english: 'LUMINOUS', caption: tr('让灵感透光', 'LIGHT & ORDER'), description: tr('冰蓝光线穿过清透界面，精密网格与微光勾勒未来秩序。', 'Ice-blue light passes through translucent panels while precision grids outline a futuristic order.') },
  { id: 'cyber', name: tr('赛博朋克', 'Cyberpunk'), english: 'NEON CITY', caption: tr('接入另一现实', 'NEON REALITY'), description: tr('电光蓝与霓虹粉交织，故障切片与高亮边框点燃夜色。', 'Electric cyan and neon magenta intertwine with glitch accents and glowing borders to ignite the night.') },
  { id: 'glass', name: tr('玻璃拟态', 'Frosted Glass'), english: 'SOFT GLASS', caption: tr('看见光的层次', 'LAYERED LIGHT'), description: tr('朦胧色彩穿过磨砂玻璃，半透明界面在光影中轻盈悬浮。', 'Soft colors diffuse through frosted glass as translucent surfaces float gently in light and shadow.') },
];
const icons = ['ring', 'spire', 'flame', 'gamepad', 'swords', 'gem', 'ghost', 'rocket'];
const getIconNames = (): Record<string, string> => ({
  ring: tr('圆环', 'Ring'), spire: tr('高塔', 'Spire'), flame: tr('火焰', 'Flame'), gamepad: tr('手柄', 'Gamepad'),
  swords: tr('双剑', 'Swords'), gem: tr('宝石', 'Gem'), ghost: tr('幽灵', 'Ghost'), rocket: tr('火箭', 'Rocket'),
});
const colors = ['#8a9270', '#729486', '#a28167', '#738fb1', '#ab80ae', '#be7976'];
const visibleSaves = (game: Game) => game.snapshots.filter(snapshot => matchesFilter(snapshot, 'all'));
type Page = 'library' | 'games' | 'themes' | 'settings';
type ModalState = { type: 'restore-points' } | { type: 'delete'; gameId: string; snapshots: Snapshot[]; permanent: boolean; returnTo?: 'restore-points' } | { type: 'batch-report'; report: BatchReport; permanent?: boolean; returnTo?: 'restore-points' } | { type: 'game'; game?: Game } | { type: 'save'; snapshot?: Snapshot } | { type: 'restore'; snapshot: Snapshot } | { type: 'remove-game'; game: Game } | { type: 'detail'; snapshot: Snapshot } | { type: 'import-conflicts'; plan: ImportPlan } | { type: 'import-report'; report: ImportReport } | { type: 'help' };

export default function App() {
  const api = window.savehub;
  const [state, setState] = useState<AppState | null>(null);
  const [bootError, setBootError] = useState('');
  const [page, setPageState] = useState<Page>('library');
  const [selected, setSelected] = useState(() => localStorage.getItem('savehub-selected') || 'elden-ring');
  const [modal, setModalState] = useState<ModalState | null>(null);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [views, setViews] = useState<Record<string, LibraryView>>({});
  const [pointSelections, setPointSelections] = useState<Record<string, PointSelection>>({});
  const [menu, setMenu] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const nextScroll = useRef<number | null>(null);
  const themeReturn = useRef<{ page: Exclude<Page, 'themes'>; gameId: string; scrollTop: number }>({ page: 'library', gameId: selected, scrollTop: 0 });
  if (state) setFormatLanguage(state.language || 'zh');
  const setModal = (next: ModalState | null) => { void animate(() => setModalState(next)); };
  const setPage = (next: Page) => {
    nextScroll.current = 0;
    void animate(() => { setPageState(next); setMenu(null); });
  };
  const toggleThemePage = () => {
    if (page === 'themes') {
      const previous = themeReturn.current;
      nextScroll.current = previous.scrollTop;
      void animate(() => { setPageState(previous.page); setSelected(previous.gameId); setMenu(null); });
    } else {
      themeReturn.current = { page, gameId: selected, scrollTop: mainRef.current?.scrollTop || 0 };
      setPage('themes');
    }
  };
  useLayoutEffect(() => {
    if (nextScroll.current !== null && mainRef.current) {
      mainRef.current.scrollTop = nextScroll.current;
      nextScroll.current = null;
    }
  }, [page, selected]);

  const refresh = useCallback(async () => {
    if (!api) return;
    const next = await api.state();
    const lang: Language = next.language === 'en' ? 'en' : 'zh';
    setFormatLanguage(lang);
    localStorage.setItem('savehub-language', lang);
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    document.title = lang === 'en' ? 'SaveHub · Preserve Every Adventure' : 'SaveHub · 珍藏每一次冒险';
    await animate(() => { setState(next); document.documentElement.dataset.theme = next.theme; });
    return next;
  }, [api]);
  useEffect(() => {
    refresh().then(next => { if (next?.recoveryMessages.length) setToast({ text: next.recoveryMessages.join('\n') }); }).catch(error => setBootError(error.message));
    return api?.onProgress(setProgress);
  }, [refresh, api]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), toast.error ? 14000 : 6500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { setMenu(null); localStorage.setItem('savehub-selected', selected); }, [selected]);
  useEffect(() => { if (!menu) return; const close = () => setMenu(null); window.addEventListener('click', close); return () => window.removeEventListener('click', close); }, [menu]);

  const perform = async <T,>(label: string, action: () => Promise<T>, success?: string, close = false) => {
    if (busy) return null;
    setBusy(label); setMenu(null);
    try {
      const result = await action();
      await refresh();
      if (success) setToast({ text: success });
      if (close) setModal(null);
      return result;
    } catch (error) { setToast({ text: error instanceof Error ? error.message : tr('操作失败，请重试。', 'Operation failed, please try again.'), error: true }); return null; }
    finally { setBusy(''); setProgress(null); }
  };

  if (!api) return <div className="boot-screen"><Logo/><h1>{tr('用 SaveHub 桌面端开启冒险', 'Start Your Adventure with SaveHub Desktop')}</h1><p>{tr('文件存读档需要 Electron 桌面客户端。', 'Saving and restoring files requires the Electron desktop app.')}</p><code>pnpm dev</code><p>{tr('或打开打包后的 SaveHub 应用。', 'Or launch the packaged SaveHub application.')}</p></div>;
  if (bootError) return <div className="boot-screen"><ShieldCheck size={42}/><h1>{tr('游戏库暂时无法读取', 'Unable to Read Game Library')}</h1><p>{bootError}</p><button className="button primary" onClick={() => window.location.reload()}>{tr('重新加载', 'Reload')}</button></div>;
  if (!state) return <div className="boot-screen"><Logo/><LoaderCircle className="spin"/><p>{tr('正在打开你的存档库…', 'Opening your save library…')}</p></div>;

  const language: Language = state.language === 'en' ? 'en' : 'zh';
  const themes = getThemes();
  const switchLanguage = (nextLang: Language) => {
    if (nextLang === language) return;
    void perform(nextLang === 'en' ? 'Switching language' : '正在切换语言', () => api.setLanguage(nextLang));
  };
  const games = state.games.filter(game => !game.deletedAt);
  const current = games.find(game => game.id === selected) || games[0];
  const allSnapshots = games.flatMap(game => visibleSaves(game));
  const storageBytes = state.games.flatMap(game => [...game.snapshots, ...game.restorePoints]).reduce((total, snapshot) => total + snapshot.bytes, 0);
  const saves = current ? visibleSaves(current) : [];
  const view = views[current?.id] || defaultView;
  const updateView = (changes: Partial<LibraryView>, gameId = current.id) => {
    const update = () => setViews(previous => ({ ...previous, [gameId]: { ...(previous[gameId] || defaultView), ...changes } }));
    setMenu(null);
    if ('filter' in changes || 'sort' in changes) void animate(update); else update();
  };
  const totalFiles = saves.reduce((sum, snapshot) => sum + snapshot.fileCount, 0);
  const chooseGame = (id: string) => { nextScroll.current = 0; void animate(() => { setSelected(id); setPageState('library'); setMenu(null); }); };
  const openSave = () => { if (current?.pathStatus !== 'ready') setModal({ type: 'game', game: current }); else setModal({ type: 'save' }); };
  const executeImport = async (plan: ImportPlan, decisions: ImportDecision[]) => {
    const report = await perform(tr('正在执行导入', 'Importing saves'), () => api.executeImport(plan.id, decisions));
    if (report) setModal({ type: 'import-report', report });
  };
  const runImport = async (useLegacy = false) => {
    if (!current) return;
    const plan = await perform(tr('正在检查导入存档', 'Checking saves to import'), () => api.importSnapshots(current.id, useLegacy));
    if (!plan) return;
    if (plan.items.some(item => item.matches.length)) setModal({ type: 'import-conflicts', plan });
    else await executeImport(plan, []);
  };
  const snapshotAction = (action: SnapshotAction, snapshot: Snapshot) => {
    if (action === 'protect' && snapshot.deletedAt) { setToast({ text: tr('请先从回收站找回存档，再修改保护标记。', 'Recover this save from Trash before changing protection.'), error: true }); return; }
    if (action === 'delete' && snapshot.protected) { setToast({ text: tr('保护存档不可删除，请先取消保护标记。', 'Protected saves cannot be deleted. Unprotect them first.'), error: true }); return; }
    if (action === 'delete') { requestDelete([snapshot], snapshot.kind === 'safety' ? 'restore-points' : undefined); return; }
    if (action === 'detail' || action === 'restore') { setModal({ type: action, snapshot }); return; }
    if (action === 'edit') { setModal({ type: 'save', snapshot }); return; }
    if (action === 'favorite') { void perform(tr('更新收藏标记', 'Updating favorite'), () => api.updateSnapshot(current.id, snapshot.id, { favorite: !snapshot.favorite })); return; }
    if (action === 'protect') { void perform(tr('更新保护标记', 'Updating protection'), () => api.updateSnapshot(current.id, snapshot.id, { protected: !snapshot.protected }), snapshot.protected ? tr('已取消保护标记。', 'Protection removed.') : tr('已标记为保护存档，取消保护前不可删除，记录仍保留在全部存档中。', 'Marked as protected. Cannot be deleted until unprotected; still visible in All Saves.')); return; }
    if (action === 'recover') { void perform(tr('找回存档', 'Recovering save'), () => api.updateSnapshot(current.id, snapshot.id, { deleted: false }), tr('已找回存档，保留原有收藏和保护标记。', 'Save recovered with original favorite and protection flags preserved.')); return; }
    if (action === 'verify') { void perform(tr('正在校验存档', 'Verifying save integrity'), async () => { const result = await api.verifySnapshot(current.id, snapshot.id); setToast({ text: tr(`完整性校验通过，${result.fileCount} 个文件均完好。`, `Integrity check passed: all ${result.fileCount} file(s) are intact.`) }); }); return; }
    if (action === 'export') void perform(tr('正在导出存档', 'Exporting save'), async () => { const result = await api.exportSnapshot(current.id, snapshot.id); if (result) setToast({ text: tr('已导出到 ' + result, 'Exported to ' + result) }); });
  };
  const exportBatch = (selection: string[]) => perform(tr('正在批量导出存档', 'Exporting saves'), async () => {
    const result = await api.exportSnapshots(current.id, selection);
    if (result) setToast({ text: tr(`已导出 ${result.count} 份存档到 ${result.folder}`, `Exported ${result.count} save(s) to ${result.folder}`) });
  });
  function requestDelete(snapshots: Snapshot[], returnTo?: 'restore-points') {
    if (!snapshots.length) return;
    if (snapshots.some(snapshot => snapshot.protected)) { setToast({ text: tr('保护存档不可删除，请先取消保护标记。', 'Protected saves cannot be deleted. Unprotect them first.'), error: true }); return; }
    const permanent = snapshots.every(snapshot => snapshot.deletedAt);
    if (!permanent && snapshots.some(snapshot => snapshot.deletedAt)) { setToast({ text: tr('请分别操作正常记录和已删除记录。', 'Please handle active and deleted records separately.'), error: true }); return; }
    setModal({ type: 'delete', gameId: snapshots[0].gameId, snapshots, permanent, returnTo });
  }
  function closeModal() {
    if (busy) return;
    if (modal?.type === 'import-conflicts') void api!.cancelImport(modal.plan.id).catch(error => setToast({ text: error.message, error: true }));
    setModal(modal && 'returnTo' in modal && modal.returnTo ? { type: modal.returnTo } : null);
  }
  function finishSelection(gameId: string, ids: string[]) {
    const done = new Set(ids);
    setViews(all => ({ ...all, [gameId]: { ...(all[gameId] ?? defaultView), selectedIds: (all[gameId]?.selectedIds ?? []).filter(id => !done.has(id)) } }));
    setPointSelections(all => ({ ...all, [gameId]: { active: (all[gameId]?.active ?? []).filter(id => !done.has(id)), removed: (all[gameId]?.removed ?? []).filter(id => !done.has(id)) } }));
  }
  const recoverBatch = async (gameId: string, ids: string[], returnTo?: 'restore-points') => {
    const report = await perform(tr('正在找回记录', 'Recovering records'), () => api.updateSnapshots(gameId, ids, { deleted: false }));
    if (!report) return;
    finishSelection(gameId, report.updated);
    if (report.failed.length) setModal({ type: 'batch-report', report, returnTo });
    else setToast({ text: tr(`已找回 ${report.updated.length} 份记录，原有标记保持不变。`, `Recovered ${report.updated.length} record(s) with original flags intact.`) });
  };
  const confirmDelete = async (deletion: Extract<ModalState, { type: 'delete' }>) => {
    const ids = deletion.snapshots.map(snapshot => snapshot.id);
    const report = await perform(deletion.permanent ? tr('正在永久删除文件', 'Permanently deleting files') : tr('正在移除记录', 'Moving records'), () => deletion.permanent ? api.deleteSnapshots(deletion.gameId, ids) : api.updateSnapshots(deletion.gameId, ids, { deleted: true }));
    if (!report) return;
    finishSelection(deletion.gameId, report.updated);
    if (report.failed.length) setModal({ type: 'batch-report', report, permanent: deletion.permanent, returnTo: deletion.returnTo });
    else {
      setToast({ text: deletion.permanent ? tr(`已永久删除 ${report.updated.length} 份记录。`, `Permanently deleted ${report.updated.length} record(s).`) : tr(`已移除 ${report.updated.length} 份记录。`, `Moved ${report.updated.length} record(s).`) });
      setModal(deletion.returnTo ? { type: deletion.returnTo } : null);
    }
  };
  const batchProtect = async (selection: string[], protectedTag: boolean) => {
    const gameId = current.id;
    const report = await perform(protectedTag ? tr('正在批量保护', 'Protecting saves') : tr('正在批量取消保护', 'Unprotecting saves'), () => api.updateSnapshots(gameId, selection, { protected: protectedTag }));
    if (!report) return;
    if (report.failed.length) { updateView({ selectedIds: report.failed.map(item => item.id) }, gameId); setModal({ type: 'batch-report', report }); }
    else setToast({ text: tr(`已${protectedTag ? '保护' : '取消保护'} ${report.updated.length} 份存档。`, `${protectedTag ? 'Protected' : 'Unprotected'} ${report.updated.length} save(s).`) });
  };

  return <>
    <div className={`app-shell platform-${state.platform}`} inert={modal ? true : undefined}>
      <div className="titlebar"><span>SaveHub <span className="titlebar-separator">/</span> {tr('把冒险留在这里', 'Preserve Every Adventure')}</span></div>
      <aside className="sidebar">
        <button className="brand" aria-label={tr('SaveHub 首页', 'SaveHub Home')} onClick={() => setPage('library')}><Logo/><span>SaveHub<small>{tr('你的游戏时光机', 'YOUR GAME TIME MACHINE')}</small></span></button>
        <div className="nav-label">{tr('工作空间', 'WORKSPACE')} <span>WORKSPACE</span></div>
        <nav className="main-nav" aria-label={tr('主导航', 'Main navigation')}>
          <button className={page === 'library' ? 'active' : ''} onClick={() => setPage('library')}><Library size={18}/><span>{tr('存档库', 'Save Library')}</span><span className="nav-number">{allSnapshots.length}</span></button>
          <button className={page === 'games' ? 'active' : ''} onClick={() => setPage('games')}><LayoutGrid size={18}/><span>{tr('全部游戏', 'All Games')}</span></button>
        </nav>
        <div className="nav-label games-label">{tr('我的游戏', 'MY GAMES')} <button title={tr('添加游戏', 'Add Game')} aria-label={tr('添加游戏', 'Add Game')} disabled={!!busy} onClick={() => setModal({ type: 'game' })}><Plus size={16}/></button></div>
        <nav className="game-nav" aria-label={tr('游戏列表', 'Game list')}>{games.map(game => <button key={game.id} className={current?.id === game.id && page === 'library' ? 'selected' : ''} onClick={() => chooseGame(game.id)}><span className="game-glyph" style={{ '--game-color': game.color } as React.CSSProperties}><GameGlyph icon={game.icon}/></span><span className="game-nav-name">{gameName(game)}<small>{tr(`${visibleSaves(game).length} 份存档`, `${visibleSaves(game).length} save(s)`)}</small></span>{current?.id === game.id && page === 'library' && <span className="selected-dot"/>}</button>)}</nav>
        <button className="add-game" disabled={!!busy} onClick={() => setModal({ type: 'game' })}><Plus size={15}/>{tr('添加游戏项目', 'Add Game')}</button>
        <div className="sidebar-bottom">
          <div className="local-storage"><span className="storage-heading"><HardDrive size={16}/>{tr('本地资料库', 'Local Vault')}<span className="status-dot"/></span><strong>{formatBytes(storageBytes)}<small>{tr('已存储', 'Stored')}</small></strong><div className="storage-rule"/><p>{tr('每一份存档，都在你的设备上。', 'Every save stays right on your device.')}</p><button onClick={() => perform(tr('打开资料库', 'Opening vault'), () => api.openFolder('vault'))}>{tr('打开文件夹', 'Open Folder')}<ExternalLink size={13}/></button></div>
          <nav className="main-nav"><button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}><Settings2 size={17}/><span>{tr('设置与关于', 'Settings & About')}</span></button></nav>
          <div className="sidebar-footer"><span className="tiny-mark">S / H</span><span>{tr('为下一次冒险，留一扇门。', 'Keep a doorway open for your next adventure.')}</span></div>
        </div>
      </aside>

      <div className="workspace">
        <header className="toolbar"><div className="breadcrumbs"><span>{tr('我的工作空间', 'My Workspace')}</span><ChevronRight size={13}/><strong>{({ library: tr('存档库', 'Save Library'), games: tr('全部游戏', 'All Games'), themes: tr('外观与主题', 'Themes'), settings: tr('设置与关于', 'Settings & About') })[page]}</strong></div><div className="toolbar-right"><span className="local-indicator"><span className="status-dot"/>{tr('本地模式', 'Local Mode')}</span><span className="toolbar-divider"/><button className="language-shortcut" aria-label={tr('切换语言', 'Switch language')} title={tr('切换为 English', 'Switch to 中文')} disabled={!!busy} onClick={() => switchLanguage(language === 'zh' ? 'en' : 'zh')}><Languages size={15}/>{language === 'zh' ? '中文' : 'EN'}</button><button className={`theme-shortcut ${page === 'themes' ? 'is-open' : ''}`} aria-label={tr('切换主题', 'Switch theme')} aria-expanded={page === 'themes'} title={page === 'themes' ? tr('返回上次页面', 'Back to previous page') : tr('选择主题风格', 'Choose theme')} onClick={toggleThemePage}><Paintbrush size={15}/>{themes.find(theme => theme.id === state.theme)?.name}<ChevronDown size={12}/></button><button className="icon-button" title={tr('使用指南', 'User Guide')} aria-label={tr('使用指南', 'User Guide')} onClick={() => setModal({ type: 'help' })}><CircleHelp size={17}/></button></div></header>
        <main className="main-content" ref={mainRef}><div className="route-content" data-page={page}>
          {page === 'library' && current && <>
            <div className="page-heading"><div><div className="eyebrow">YOUR ADVENTURE, PRESERVED.</div><h1>{tr('每一次冒险，都值得珍藏', 'Every Adventure Is Worth Preserving')}<span className="heading-period">{tr('。', '.')}</span></h1><p>{tr('存下此刻的勇气，随时回到热爱的世界。', 'Preserve your courage at this moment and return to the worlds you love anytime.')}</p></div><span className="ink-seal" aria-hidden="true">存<br/>心</span></div>
            <section className="game-hero" aria-label={tr(`${current.name}游戏概览`, `${gameName(current)} overview`)}><Landscape kind={current.icon}/><div className="hero-shade"/><div className="hero-content"><div className="hero-kicker"><span className="small-line"/>{tr('正在管理的游戏', 'ACTIVE GAME')}</div><div className="hero-title"><GameGlyph icon={current.icon} size={30}/><h2>{gameName(current)}</h2></div><p className="game-subtitle">{current.subtitle || 'MY NEXT ADVENTURE'}</p><div className="hero-status"><span className={`status-dot ${current.pathStatus !== 'ready' ? 'warning' : ''}`}/>{current.pathStatus === 'ready' ? tr('存档目录已连接', 'Save directory connected') : current.pathStatus === 'missing' ? tr('存档目录不可用，请检查设置', 'Save directory unavailable, check settings') : tr('等待配置存档目录', 'Save directory not configured')}<span className="hero-status-divider"/> {state.platform === 'darwin' ? 'macOS · Apple Silicon' : 'Windows'}</div><div className="hero-actions"><button className="button primary" disabled={!!busy} onClick={openSave}><Plus size={17}/>{current.pathStatus === 'ready' ? tr('创建新存档', 'New Save') : tr('配置存档路径', 'Configure Save Path')}</button><button className="button subtle" disabled={!!busy} onClick={() => setModal({ type: 'game', game: current })}><Settings2 size={15}/>{tr('游戏设置', 'Game Settings')}</button></div></div><span className="hero-caption">{current.icon === 'ring' ? tr('交界之地 · 未完待续', 'The Lands Between · Unfinished') : current.icon === 'spire' ? tr('高塔之上 · 再次启程', 'Atop the Spire · Ascend Again') : current.icon === 'flame' ? tr('余火未熄 · 故事未完', 'Embers Remain · Story Continues') : tr('下一场冒险 · 由你续写', 'Next Adventure · Written by You')}</span><span className="hero-index">0{games.indexOf(current) + 1} / 0{games.length}</span></section>
            <section className="stats-row" aria-label={tr('存档统计', 'Save statistics')}><Stat icon={<Archive size={18}/>} label={tr('全部存档', 'Total Saves')} value={String(saves.length).padStart(2, '0')} unit={tr('份', 'saves')}/><Stat icon={<ShieldCheck size={18}/>} label={tr('读档保护', 'Restore Safety')} value={tr('已开启', 'Active')} detail={tr('恢复前自动备份', 'Auto-backup before restore')}/><Stat icon={<HardDrive size={18}/>} label={tr('全部存档占用', 'Save Storage')} value={formatBytes(saves.reduce((sum, snapshot) => sum + snapshot.bytes, 0))} detail={tr(`${totalFiles} 个文件`, `${totalFiles} file(s)`)}/><Stat icon={<Clock3 size={18}/>} label={tr('最近存档', 'Latest Save')} value={saves[0] ? dateLabel(saves[0].createdAt) : tr('等待启程', 'Not yet')} detail={saves[0] ? kindLabel(saves[0].kind) : tr('记录第一个游戏时刻', 'Record your first moment')}/></section>
            <SnapshotList game={current} view={view} busy={!!busy} menu={menu} onMenu={setMenu} onViewChange={updateView} onAction={snapshotAction}
              onImport={runImport} onFolder={() => void perform(tr('打开备份文件夹', 'Opening backup folder'), () => api.openFolder('snapshots', current.id))} onCreate={openSave}
              onRestorePoints={() => setModal({ type: 'restore-points' })} onExport={selection => void exportBatch(selection)}
              onDelete={snapshots => requestDelete(snapshots)} onRecover={ids => void recoverBatch(current.id, ids)} onProtect={(selection, protectedTag) => void batchProtect(selection, protectedTag)}/>
            <footer className="page-footer"><span>SAVE YOUR PROGRESS. KEEP YOUR STORIES.</span><span>{tr('每一次归来，都是新的开始。', 'Every return is a new beginning.')}</span></footer>
          </>}
          {page === 'library' && !current && <div className="empty-library"><Landscape/><div><Gamepad2 size={40}/><h1>{tr('为你的冒险，建一个家。', 'Build a Home for Your Adventures.')}</h1><p>{tr('添加第一个游戏，开始管理它的存档与每一次重新出发。', 'Add your first game to start managing its saves and every fresh start.')}</p><button className="button primary" onClick={() => setModal({ type: 'game' })}><Plus size={17}/>{tr('添加游戏', 'Add Game')}</button></div></div>}

          {page === 'games' && <><PageHeading eyebrow="A HOME FOR EVERY WORLD." title={tr('你的世界，都在这里。', 'All Your Worlds, Right Here.')} description={tr('每个游戏独立管理，让不同的冒险各得其所。', 'Each game is managed independently, giving every adventure its own space.')}/><div className="section-heading games-heading"><h2>{tr('游戏项目', 'Games')} <span>{games.length}</span></h2><button className="button primary" disabled={!!busy} onClick={() => setModal({ type: 'game' })}><Plus size={16}/>{tr('添加游戏', 'Add Game')}</button></div><div className="game-grid">{games.map(game => <article className="game-card" key={game.id}><div className="game-card-art"><Landscape kind={game.icon}/><span className="game-card-symbol"><GameGlyph icon={game.icon} size={28}/></span><button className="icon-button" title={tr(`编辑 ${game.name}`, `Edit ${gameName(game)}`)} aria-label={tr(`编辑 ${game.name}`, `Edit ${gameName(game)}`)} disabled={!!busy} onClick={() => setModal({ type: 'game', game })}><Settings2 size={17}/></button></div><div className="game-card-body"><span className="eyebrow">{game.subtitle || 'YOUR OWN WORLD'}</span><h2>{gameName(game)}</h2><p><span className={`status-dot ${game.pathStatus !== 'ready' ? 'warning' : ''}`}/>{game.pathStatus === 'ready' ? tr('存档目录已连接', 'Save directory connected') : tr('需要配置存档路径', 'Save path required')}<span>{tr(`${visibleSaves(game).length} 份存档`, `${visibleSaves(game).length} save(s)`)}</span></p><button className="button secondary" onClick={() => chooseGame(game.id)}>{tr('进入存档库', 'Open Library')}<ArrowRight size={15}/></button></div></article>)}<button className="new-game-card" disabled={!!busy} onClick={() => setModal({ type: 'game' })}><span><Plus size={25}/></span><strong>{tr('下一个世界', 'Next World')}</strong><p>{tr('添加你喜欢的游戏', 'Add a game you love')}</p></button></div></>}

          {page === 'themes' && <><PageHeading eyebrow="A DIFFERENT WAY TO FEEL." title={tr('换个心境，再次出发。', 'A New Mood for Your Next Journey.')} description={tr('四种风格，同一份热爱。选择属于你的存档空间。', 'Four distinct styles, one shared passion. Choose the space that fits your world.')}/><div className="theme-grid">{themes.map(theme => <button key={theme.id} className={`theme-card ${state.theme === theme.id ? 'chosen' : ''}`} disabled={!!busy} onClick={() => perform(tr('切换主题', 'Switching theme'), () => api.setTheme(theme.id))} aria-label={tr(`切换${theme.name}主题`, `Switch to ${theme.name} theme`)} aria-pressed={state.theme === theme.id}><div className={`theme-preview preview-${theme.id}`}><div className="mini-sidebar"><i/><i/><i/><i/></div><div className="mini-workspace"><div className="mini-title"/><div className="mini-hero"><span>{theme.caption}</span><div className="mini-moon"/></div><div className="mini-stats"><i/><i/><i/></div><div className="mini-row"/><div className="mini-row"/></div><span className="preview-label">{theme.english}</span></div><div className="theme-card-copy"><div><h2>{theme.name}</h2><span>{theme.english}</span></div><span className={`theme-check ${state.theme === theme.id ? 'checked' : ''}`}>{state.theme === theme.id && <Check size={14}/>}</span><p>{theme.description}</p></div></button>)}</div><div className="theme-note"><Sparkles size={19}/><div><strong>{tr('外观随心，记录如初', 'Fresh Look, Untouched Saves')}</strong><p>{tr('主题会即时应用并自动保存，下次打开仍是你喜欢的样子。', 'Themes apply instantly and save automatically for the next time you launch.')}</p></div><span>{themes.find(theme => theme.id === state.theme)?.name} · {tr('使用中', 'Active')}</span></div></>}

          {page === 'settings' && <><PageHeading eyebrow="YOUR SAVES. YOUR DEVICE." title={tr('安心存放，从容启程。', 'Stored Safely, Ready Whenever You Are.')} description={tr('一切保存在本地，由你掌握。', 'Everything stays local on your device, under your control.')}/><section className="settings-card"><h2><Languages size={20}/>{tr('界面语言', 'Interface Language')}</h2><p>{tr('切换应用显示语言，设置会自动保存并在下次启动时保持。', 'Switch the display language for the application. Your choice is saved automatically.')}</p><div className="language-options" role="group" aria-label={tr('语言选择', 'Language selection')}><button type="button" className={`button ${language === 'zh' ? 'primary' : 'secondary'} small`} aria-pressed={language === 'zh'} disabled={!!busy} onClick={() => switchLanguage('zh')}>简体中文</button><button type="button" className={`button ${language === 'en' ? 'primary' : 'secondary'} small`} aria-pressed={language === 'en'} disabled={!!busy} onClick={() => switchLanguage('en')}>English</button></div></section><section className="settings-card"><h2><HardDrive size={20}/>{tr('本地资料库', 'Local Vault')}</h2><p>{tr('游戏配置、图标和备份保存在以下位置。卸载应用时不会主动移除资料库。', 'Game profiles, icons, and save backups are stored at the path below. Uninstalling the app does not delete your vault.')}</p><div className="path-display"><Folder size={17}/><code>{state.dataDir}</code><button className="icon-button" title={tr('打开资料库', 'Open Vault')} onClick={() => perform(tr('打开资料库', 'Opening vault'), () => api.openFolder('vault'))}><ExternalLink size={16}/></button></div><div className="settings-metrics"><span>{tr(`${state.games.length} 个游戏项目（含已移除）`, `${state.games.length} game(s) (including removed)`)}</span><span>{tr(`${formatBytes(storageBytes)} 已使用`, `${formatBytes(storageBytes)} used`)}</span><span>{state.platform === 'darwin' ? 'macOS / Apple Silicon' : 'Windows'}</span></div></section><section className="settings-card"><h2><ShieldCheck size={20}/>{tr('每次读档，多一份保障', 'Extra Safety on Every Restore')}</h2><div className="protection-grid"><div><CheckCheck size={22}/><strong>{tr('完整性校验', 'Integrity Verification')}</strong><p>{tr('创建与恢复均校验文件内容，发现异常即停止操作。', 'Every backup and restore verifies SHA-256 checksums and stops immediately if any anomaly is detected.')}</p></div><div><History size={22}/><strong>{tr('读档前自动备份', 'Auto-Backup Before Restore')}</strong><p>{tr('保留恢复前的进度，可在「读档恢复点」中找到。', 'Automatically saves your current progress to Restore Points before replacing any files.')}</p></div><div><RotateCcw size={22}/><strong>{tr('失败回滚', 'Transactional Rollback')}</strong><p>{tr('文件替换失败时回滚，中途退出后会在下次启动恢复。', 'Rolls back automatically if replacement fails, and recovers unfinished transactions on next startup.')}</p></div></div></section><section className="settings-card"><h2><Trash2 size={20}/>{tr('已移除的游戏', 'Removed Games')}</h2><p>{tr('移除项目会保留已有备份，不会删除游戏原文件。', 'Removing a game keeps its existing backups and never touches live game files.')}</p>{state.games.filter(game => game.deletedAt).length ? state.games.filter(game => game.deletedAt).map(game => <div className="removed-game" key={game.id}><GameGlyph icon={game.icon}/><strong>{gameName(game)}</strong><span>{tr(`${game.snapshots.length} 份存档`, `${game.snapshots.length} save(s)`)}</span><button className="button secondary small" disabled={!!busy} onClick={() => perform(tr('恢复游戏项目', 'Restoring game'), () => api.removeGame(game.id, true), tr('游戏项目已找回。', 'Game restored.'))}><RotateCcw size={14}/>{tr('找回项目', 'Restore Game')}</button></div>) : <div className="quiet-empty">{tr('暂时没有已移除的游戏。', 'No removed games.')}</div>}</section><div className="about-line"><Logo small/><strong>SaveHub</strong><span>v{state.version}</span><span>Electron · Windows & macOS</span><button className="text-button" onClick={() => setModal({ type: 'help' })}>{tr('使用指南', 'User Guide')}<ArrowRight size={14}/></button></div></>}
        </div></main>
      </div>
    </div>

    {modal && <Modal title={modalTitle(modal)} onClose={closeModal} busy={!!busy} wide={modal.type === 'game' || modal.type === 'restore-points' || modal.type === 'import-conflicts' || modal.type === 'import-report'}>
      {modal.type === 'game' && <GameForm game={modal.game} platform={state.platform} api={api} busy={!!busy} onCancel={() => setModal(null)} onSave={async values => { const id = await perform(tr('保存游戏设置', 'Saving game settings'), () => api.saveGame(values), tr('游戏设置已保存。', 'Game settings saved.'), true); if (id) chooseGame(id); }} onDelete={modal.game ? () => setModal({ type: 'remove-game', game: modal.game! }) : undefined}/>}
      {modal.type === 'save' && current && <SnapshotForm snapshot={modal.snapshot} busy={!!busy} onCancel={() => setModal(null)} onSave={values => perform(modal.snapshot ? tr('保存存档信息', 'Saving changes') : tr('正在创建存档', 'Creating save'), async () => { if (modal.snapshot) await api.updateSnapshot(current.id, modal.snapshot.id, values); else await api.saveSnapshot(current.id, values); }, modal.snapshot ? tr('存档信息已更新。', 'Save details updated.') : tr('新存档已创建，文件校验通过。', 'New save created and verified.'), true)}/>}
      {modal.type === 'restore' && current && <RestoreConfirm snapshot={modal.snapshot} game={current} platform={state.platform} busy={!!busy} onCancel={() => setModal(null)} onConfirm={() => perform(tr('正在安全恢复存档', 'Restoring save safely'), () => api.restoreSnapshot(current.id, modal.snapshot.id), tr(`已读取「${modal.snapshot.label}」，原进度已保存为读档恢复点。`, `Loaded "${modal.snapshot.label}". Previous progress was saved as a restore point.`), true)}/>}
      {modal.type === 'delete' && <DeleteConfirmation snapshots={modal.snapshots} permanent={modal.permanent} busy={!!busy} onCancel={closeModal} onConfirm={() => void confirmDelete(modal)}/>}
      {modal.type === 'batch-report' && <><p className="dialog-description">{tr(`已完成 ${modal.report.updated.length} 份，未完成 ${modal.report.failed.length} 份。`, `Completed ${modal.report.updated.length}, failed ${modal.report.failed.length}.`)}</p><p className="muted">{modal.permanent ? tr('部分文件可能已被删除；标记为“永久删除未完成”的记录只能继续清理，不能找回。', 'Some files may already be removed; records marked "Pending Deletion" can only be retried for deletion and cannot be recovered.') : tr('未完成的项目保留原状，可根据下列原因处理后重试。', 'Unfinished items remain unchanged. Resolve the issues below and try again.')}</p>{modal.report.failed.map(item => <div className="notice error" key={item.id}><strong>{item.label}</strong><p>{item.error}</p></div>)}<div className="dialog-actions"><button className="button secondary" onClick={closeModal}>{tr('关闭', 'Close')}</button></div></>}
      {modal.type === 'restore-points' && current && <><RestorePoints points={current.restorePoints} selection={pointSelections[current.id] ?? { active: [], removed: [] }} busy={!!busy} canRestore={current.pathStatus === 'ready'} onSelect={(group, ids) => setPointSelections(all => ({ ...all, [current.id]: { ...(all[current.id] ?? { active: [], removed: [] }), [group]: ids } }))} onRestore={snapshot => setModal({ type: 'restore', snapshot })} onExport={snapshot => snapshotAction('export', snapshot)} onDelete={snapshots => requestDelete(snapshots, 'restore-points')} onRecover={ids => void recoverBatch(current.id, ids, 'restore-points')}/><div className="dialog-actions"><button className="button secondary" onClick={() => setModal(null)}>{tr('关闭', 'Close')}</button></div></>}
      {modal.type === 'remove-game' && <><div className="dialog-symbol"><Gamepad2 size={26}/></div><p className="dialog-description">{tr(`移除「${modal.game.name}」这个游戏项目？`, `Remove "${gameName(modal.game)}" from your games?`)}</p><p className="muted">{tr('现有备份会保留，可在「设置与关于 → 已移除的游戏」中找回。游戏原文件不受影响。', 'Existing backups will be kept and can be restored from "Settings & About → Removed Games". Live game files are untouched.')}</p><div className="dialog-actions"><button className="button secondary" disabled={!!busy} onClick={() => setModal(null)}>{tr('取消', 'Cancel')}</button><button className="button danger" disabled={!!busy} onClick={() => perform(tr('移除游戏项目', 'Removing game'), () => api.removeGame(modal.game.id), tr('游戏项目已移除，备份仍然保留。', 'Game removed. Backups are preserved.'), true)}>{tr('移除游戏', 'Remove Game')}</button></div></>}
      {modal.type === 'detail' && <><div className="detail-name"><Archive size={23}/><h3>{modal.snapshot.label}</h3></div><p className="detail-note">{modal.snapshot.note || tr('这份存档还没有添加备注。', 'No notes added for this save.')}</p><dl className="details-grid"><dt>{tr('创建时间', 'Created At')}</dt><dd>{fullDate(modal.snapshot.createdAt)}</dd><dt>{tr('存档来源', 'Source')}</dt><dd>{kindLabel(modal.snapshot.kind)}</dd><dt>{tr('当前标记', 'Flags')}</dt><dd>{[modal.snapshot.favorite && tr('已收藏', 'Favorite'), modal.snapshot.protected && tr('保护', 'Protected'), modal.snapshot.deletedAt && tr('回收站', 'Trash')].filter(Boolean).join(tr('、', ', ')) || tr('无', 'None')}</dd><dt>{tr('文件数量', 'Files')}</dt><dd>{tr(`${modal.snapshot.fileCount} 个 · ${formatBytes(modal.snapshot.bytes)}`, `${modal.snapshot.fileCount} file(s) · ${formatBytes(modal.snapshot.bytes)}`)}</dd><dt>{tr('来源平台', 'Platform')}</dt><dd>{modal.snapshot.platform === 'darwin' ? 'macOS' : 'Windows'}</dd><dt>{tr('备份项目', 'Backup Items')}</dt><dd>{modal.snapshot.entries.map(entry => <code key={entry}>{entry}</code>)}</dd><dt>{tr('唯一标识', 'Snapshot ID')}</dt><dd className="mono small-text">{modal.snapshot.id}</dd></dl>{modal.snapshot.absent?.length > 0 && <div className="notice">{tr(`此恢复记录包含当时不存在的路径：${modal.snapshot.absent.join('、')}。恢复它会让这些路径重新回到不存在的状态。`, `This record includes paths that did not exist when saved: ${modal.snapshot.absent.join(', ')}. Restoring it will remove those paths again.`)}</div>}{modal.snapshot.corrupted && <div className="notice error">{modal.snapshot.error}</div>}<div className="dialog-actions"><button className="button secondary" onClick={() => setModal(null)}>{tr('关闭', 'Close')}</button></div></>}
      {modal.type === 'import-conflicts' && <ImportConflicts key={modal.plan.id} plan={modal.plan} busy={!!busy} onCancel={closeModal} onConfirm={decisions => void executeImport(modal.plan, decisions)}/>}
      {modal.type === 'import-report' && <ImportResult report={modal.report} onClose={() => setModal(null)}/>}
      {modal.type === 'help' && <><div className="help-intro"><Logo/><p>{tr('为每一次尝试，留一条回来的路。', 'Leave a way back for every attempt.')}</p></div><ol className="help-steps"><li><strong>{tr('连接游戏存档', 'Connect Game Saves')}</strong><p>{tr('在游戏设置中选择根目录，填写需要备份的文件或子目录，每行一个相对路径。', 'Select the game save root directory in Game Settings and enter the relative file or folder paths to back up (one per line).')}</p></li><li><strong>{tr('关闭游戏，再创建存档', 'Close the Game Before Saving')}</strong><p>{tr('起个好记的名字，加上备注。应用会复制并校验完整内容。', 'Give your save a memorable name and note. SaveHub copies and verifies every file with SHA-256 checksums.')}</p></li><li><strong>{tr('选择时刻，安全读档', 'Restore Any Moment Safely')}</strong><p>{tr('关闭游戏及会写入存档的云同步后点击读档。当前进度会自动留在「读档恢复点」。', 'Close the game and pause cloud sync before loading a save. Your current progress is backed up to Restore Points first.')}</p></li><li><strong>{tr('带回已有的存档', 'Import Existing Saves')}</strong><p>{tr('使用「导入存档」选择包含 ArchiveFile… 的旧目录、单份旧存档目录，或 SaveHub 导出的存档文件夹。', 'Use "Import Saves" to bring in legacy ArchiveFile folders, individual save directories, or SaveHub export bundles.')}</p></li></ol><div className="notice"><Monitor size={17}/><span>{tr('Windows 与 macOS 路径分别配置。macOS 上的兼容层游戏，请选择实际的 Wine / CrossOver 存档目录。', 'Windows and macOS paths are configured separately. For Wine / CrossOver games on macOS, select the actual container save directory.')}</span></div><div className="dialog-actions"><button className="button primary" onClick={() => setModal(null)}>{tr('开始我的冒险', 'Start My Adventure')}<ArrowRight size={15}/></button></div></>}
    </Modal>}
    {busy && <div className="progress-panel" role="status"><LoaderCircle size={21} className="spin"/><div><strong>{busy}</strong><p>{progress?.detail || tr('正在准备，请稍候…', 'Preparing, please wait…')}</p></div>{progress?.total ? <span>{progress.completed} / {progress.total}</span> : null}<div className="progress-bar"><i style={{ width: progress?.total ? `${Math.max(3, 100 * progress.completed / progress.total)}%` : '35%' }}/></div></div>}
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <Info size={19}/> : <Check size={19}/>}<span>{toast.text}</span><button aria-label={tr('关闭提示', 'Dismiss notification')} onClick={() => setToast(null)}><X size={16}/></button></div>}
  </>;
}

function DeleteConfirmation({ snapshots, permanent, busy, onCancel, onConfirm }: { snapshots: Snapshot[]; permanent: boolean; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const points = snapshots.every(snapshot => snapshot.kind === 'safety');
  const destination = points ? tr('已移除的恢复点', 'Removed Restore Points') : tr('回收站', 'Trash');
  const label = permanent ? tr(`确认永久删除 ${snapshots.length} 份`, `Permanently Delete ${snapshots.length}`) : points ? tr(`确认移除 ${snapshots.length} 份`, `Confirm Remove ${snapshots.length}`) : snapshots.length === 1 ? tr('移入回收站', 'Move to Trash') : tr(`确认删除 ${snapshots.length} 份`, `Confirm Delete ${snapshots.length}`);
  return <><p className="dialog-description">{permanent ? tr(`永久删除以下 ${snapshots.length} 份记录及其真实文件？`, `Permanently delete the following ${snapshots.length} record(s) and their files from disk?`) : tr(`将以下 ${snapshots.length} 份记录移入“${destination}”？`, `Move the following ${snapshots.length} record(s) to "${destination}"?`)}</p>
    {permanent && <div className="notice permanent-delete-warning" role="note"><Trash2 size={19}/><div><strong>{tr('永久删除，无法恢复', 'Permanent deletion cannot be undone')}</strong><p>{tr('文件将从磁盘中实际删除，操作完成后不能再找回。游戏目录中的当前进度不受影响。', 'Files will be physically removed from disk and cannot be recovered. Live game progress is not affected.')}</p></div></div>}
    <FavoriteDeleteNotice snapshots={snapshots} permanent={permanent}/><ul className="batch-confirm-list">{snapshots.map(snapshot => <li key={snapshot.id} className={snapshot.favorite ? 'favorite-delete-item' : undefined}>{snapshot.label}{snapshot.favorite && <span className="favorite-delete-tag"><Star size={12}/>{tr('已收藏', 'Favorite')}</span>}</li>)}</ul>
    {!permanent && <p className="muted">{tr(`文件暂时保留。在“${destination}”中可多选或全选后找回，也可以再次确认后永久删除。`, `Files are kept for now. You can recover them or permanently delete them from "${destination}".`)}</p>}
    <div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={onCancel}>{tr('取消', 'Cancel')}</button><button className="button danger" disabled={busy || snapshots.some(snapshot => snapshot.protected)} onClick={onConfirm}>{label}</button></div></>;
}

function FavoriteDeleteNotice({ snapshots, permanent = false }: { snapshots: Snapshot[]; permanent?: boolean }) {
  const count = snapshots.filter(snapshot => snapshot.favorite).length;
  if (!count) return null;
  return <div className="notice favorite-delete-warning" role="note" aria-label={tr('包含已收藏存档', 'Includes favorite saves')}><Star size={22}/><div><strong>{tr(`注意：本次删除包含 ${count} 份已收藏存档`, `Note: This deletion includes ${count} favorite save(s)`)}</strong><p>{permanent ? tr('这些收藏记录及其文件也会永久删除，无法找回。确认后会继续删除。', 'These favorite records and their files will also be permanently deleted. Confirm to proceed.') : tr('请确认这些收藏记录也需要移除。确认后会继续删除，找回时仍保留收藏标记。', 'Confirm that these favorite saves should also be moved. Their favorite star is kept if recovered.')}</p></div></div>;
}

function Stat({ icon, label, value, unit, detail }: { icon: ReactNode; label: string; value: string; unit?: string; detail?: string }) {
  return <div className="stat"><div className="stat-label">{icon}{label}</div><div className="stat-value">{value}{unit && <span>{unit}</span>}</div>{detail && <small>{detail}</small>}</div>;
}
function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="page-heading standalone"><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>;
}
function modalTitle(modal: ModalState) {
  return ({
    game: modal.type === 'game' && modal.game ? tr('游戏设置', 'Game Settings') : tr('添加游戏项目', 'Add Game'),
    save: modal.type === 'save' && modal.snapshot ? tr('编辑存档信息', 'Edit Save Details') : tr('珍藏这一刻', 'Preserve This Moment'),
    restore: tr('回到这个游戏时刻', 'Return to This Moment'),
    delete: modal.type === 'delete' && modal.permanent ? tr('永久删除存档', 'Delete Saves Permanently') : tr('移除存档', 'Move Saves'),
    'remove-game': tr('移除游戏项目', 'Remove Game'),
    detail: tr('存档详情', 'Save Details'),
    'restore-points': tr('读档恢复点', 'Restore Points'),
    'batch-report': tr('批量操作结果', 'Batch Operation Report'),
    'import-conflicts': tr('处理重复存档', 'Resolve Duplicate Saves'),
    'import-report': tr('导入结果', 'Import Results'),
    help: tr('与 SaveHub 一起出发', 'Getting Started with SaveHub'),
  })[modal.type];
}

function Modal({ title, children, onClose, busy, wide }: { title: string; children: ReactNode; onClose: () => void; busy: boolean; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = ref.current;
    const focus = element?.querySelector<HTMLElement>('input, textarea, button'); focus?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) closeRef.current();
      if (event.key === 'Tab') {
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') || []);
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [busy]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={ref}><div className="modal-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label={tr('关闭对话框', 'Close dialog')} disabled={busy} onClick={onClose}><X size={20}/></button></div><div className="modal-body">{children}</div></div></div>;
}

function GameForm({ game, platform, api, busy, onSave, onCancel, onDelete }: { game?: Game; platform: Platform; api: Bridge; busy: boolean; onSave: (values: GameInput) => Promise<void>; onCancel: () => void; onDelete?: () => void }) {
  const [name, setName] = useState(game?.name || '');
  const [subtitle, setSubtitle] = useState(game?.subtitle || '');
  const [icon, setIcon] = useState(game?.icon || 'gamepad');
  const [color, setColor] = useState(game?.color || colors[0]);
  const [locations, setLocations] = useState(game?.locations || { win32: { root: '', items: [] }, darwin: { root: '', items: [] } });
  const [tab, setTab] = useState(platform);
  const [rawItems, setRawItems] = useState({ win32: (game?.locations.win32.items || []).join('\n'), darwin: (game?.locations.darwin.items || []).join('\n') });
  const [legacyRoot, setLegacyRoot] = useState(game?.legacyRoot || '');
  const [error, setError] = useState('');
  const iconNames = getIconNames();
  const pick = async (kind: 'icon' | 'directory') => {
    try { const value = kind === 'icon' ? await api.pickIcon() : await api.pickDirectory(); if (value) { if (kind === 'icon') setIcon(value); else setLocations({ ...locations, [tab]: { ...locations[tab], root: value } }); } }
    catch (error) { setError((error as Error).message); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); onSave({ id: game?.id, name, subtitle, icon, color, legacyRoot, locations: { win32: { root: locations.win32.root, items: rawItems.win32.split('\n').map(item => item.trim()).filter(Boolean) }, darwin: { root: locations.darwin.root, items: rawItems.darwin.split('\n').map(item => item.trim()).filter(Boolean) } } }); };
  return <form onSubmit={submit}><fieldset disabled={busy}><div className="game-form-intro"><span className="edit-game-icon" style={{ '--game-color': color } as React.CSSProperties}><GameGlyph icon={icon} size={33}/></span><div><p>{tr('每个世界，都有自己的名字。', 'Every world has its own name.')}</p><small>{tr('自定义游戏资料，并连接它的存档位置。', 'Customize game profile and connect its save folder.')}</small></div></div><div className="form-columns"><label className="field">{tr('游戏名称', 'Game Name')} <span>*</span><input autoComplete="off" required maxLength={80} placeholder={tr('例如：艾尔登法环', 'e.g. Elden Ring')} value={name} onChange={event => setName(event.target.value)}/></label><label className="field">{tr('副标题', 'Subtitle')}<input maxLength={80} placeholder={tr('例如：ELDEN RING', 'e.g. ELDEN RING')} value={subtitle} onChange={event => setSubtitle(event.target.value)}/></label></div><div className="icon-picker"><span>{tr('游戏图标', 'Game Icon')}</span><div>{icons.map(value => <button type="button" key={value} className={icon === value ? 'chosen' : ''} aria-label={tr(`${iconNames[value]}图标`, `${iconNames[value]} icon`)} onClick={() => setIcon(value)}><GameGlyph icon={value} size={20}/></button>)}<button type="button" className="upload-icon" title={tr('上传自定义图标', 'Upload custom icon')} onClick={() => pick('icon')}><Upload size={17}/>{tr('上传', 'Upload')}</button></div></div><div className="color-picker"><span>{tr('点缀色', 'Accent Color')}</span>{colors.map(value => <button key={value} type="button" style={{ background: value }} aria-label={tr(`颜色 ${value}`, `Color ${value}`)} aria-pressed={color === value} onClick={() => setColor(value)}>{color === value && <Check size={13}/>}</button>)}</div><div className="form-divider"/><div className="platform-tabs" role="tablist" aria-label={tr('路径平台', 'Platform paths')}><button type="button" role="tab" aria-selected={tab === 'win32'} className={tab === 'win32' ? 'active' : ''} onClick={() => void animate(() => setTab('win32'))}><Monitor size={15}/>Windows {platform === 'win32' && <small>{tr('当前系统', 'Current OS')}</small>}</button><button type="button" role="tab" aria-selected={tab === 'darwin'} className={tab === 'darwin' ? 'active' : ''} onClick={() => void animate(() => setTab('darwin'))}><Monitor size={15}/>macOS <small>Apple Silicon</small></button></div><label className="field">{tr('游戏存档根目录', 'Game Save Root Directory')}<div className="input-with-button"><input aria-label={tr('游戏存档根目录', 'Game Save Root Directory')} placeholder={tab === 'win32' ? tr('C:\\Users\\你的用户名\\AppData\\Roaming\\游戏', 'C:\\Users\\YourName\\AppData\\Roaming\\Game') : tr('/Users/你的用户名/Library/Application Support/游戏', '/Users/YourName/Library/Application Support/Game')} value={locations[tab].root} onChange={event => setLocations({ ...locations, [tab]: { ...locations[tab], root: event.target.value } })}/><button type="button" disabled={tab !== platform} title={tab !== platform ? tr('其他系统的路径请手动填写', 'Enter paths for other platforms manually') : tr('浏览文件夹', 'Browse folder')} onClick={() => pick('directory')}><FolderOpen size={17}/></button></div></label><label className="field">{tr('要备份的文件或目录', 'Files or Folders to Back Up')}<textarea rows={3} spellCheck={false} placeholder={tr('每行一个相对路径，例如：\nsaves\npreferences', 'One relative path per line, e.g.:\nsaves\npreferences')} value={rawItems[tab]} onChange={event => setRawItems({ ...rawItems, [tab]: event.target.value })}/><small>{tr('相对于上方根目录。支持多个文件和目录，也支持空格、中文及多级路径。', 'Relative to the root directory above. Supports multiple files, folders, spaces, Unicode, and nested paths.')}</small></label>{tab === 'darwin' && <div className="notice compact"><Info size={15}/><span>{tr('通过 CrossOver / Wine 运行的游戏，填写其容器内的实际存档路径。', 'For games running via CrossOver / Wine, enter the actual save path inside the bottle/container.')}</span></div>}<details className="advanced-settings"><summary>{tr('旧脚本存档目录（可选）', 'Legacy Script Backup Directory (Optional)')}</summary><label className="field"><input value={legacyRoot} onChange={event => setLegacyRoot(event.target.value)} placeholder={tr('包含 ArchiveFile… 的旧备份目录', 'Legacy backup directory containing ArchiveFile…')}/><small>{tr('只用于发现旧备份。导入时会复制原内容。', 'Used only to discover legacy ArchiveFile backups. Importing copies the original files.')}</small></label></details>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions">{onDelete && <button type="button" className="text-button danger-text delete-game-button" onClick={onDelete}><Trash2 size={15}/>{tr('移除游戏', 'Remove Game')}</button>}<button type="button" className="button secondary" onClick={onCancel}>{tr('取消', 'Cancel')}</button><button type="submit" className="button primary">{busy ? <LoaderCircle className="spin" size={15}/> : <Check size={15}/>}{tr('保存游戏', 'Save Game')}</button></div></fieldset></form>;
}

function SnapshotForm({ snapshot, busy, onSave, onCancel }: { snapshot?: Snapshot; busy: boolean; onSave: (values: { label: string; note: string }) => Promise<unknown>; onCancel: () => void }) {
  const [label, setLabel] = useState(snapshot?.label || `${tr('冒险记录', 'Adventure Log')} · ${dateLabel(new Date().toISOString())}`);
  const [note, setNote] = useState(snapshot?.note || '');
  return <form onSubmit={event => { event.preventDefault(); onSave({ label, note }); }}><fieldset disabled={busy}><p className="form-description">{snapshot ? tr('让每一份进度，都容易辨认。', 'Keep every checkpoint easy to recognize.') : tr('为这个时刻起个名字，以后便能轻松找到它。', 'Name this moment so you can easily find it later.')}</p><label className="field">{tr('存档名称', 'Save Name')}<input required maxLength={100} value={label} onChange={event => setLabel(event.target.value)} placeholder={tr('例如：挑战最终 Boss 之前', 'e.g. Before the Final Boss')}/></label><label className="field">{tr('给未来的自己留句话', 'Note for Your Future Self')} <span className="optional">{tr('可选', 'Optional')}</span><textarea rows={4} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} placeholder={tr('记录周目、角色、地点，或这次冒险的心情…', 'Record playthrough, character, location, or thoughts on this adventure…')}/></label>{!snapshot && <div className="notice"><Info size={17}/><span>{tr('请先关闭游戏，让存档文件保持完整。所有已配置的文件和目录会一起备份。', 'Please close the game first so save files remain consistent. All configured files and folders will be backed up together.')}</span></div>}<div className="dialog-actions"><button type="button" className="button secondary" onClick={onCancel}>{tr('取消', 'Cancel')}</button><button className="button primary" type="submit">{busy ? <LoaderCircle size={16} className="spin"/> : <Archive size={16}/>} {snapshot ? tr('保存修改', 'Save Changes') : tr('创建存档', 'Create Save')}</button></div></fieldset></form>;
}
function RestoreConfirm({ snapshot, game, platform, busy, onConfirm, onCancel }: { snapshot: Snapshot; game: Game; platform: Platform; busy: boolean; onConfirm: () => Promise<unknown>; onCancel: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  return <><div className="restore-card"><div className="dialog-symbol"><History size={27}/></div><h3>{snapshot.label}</h3><p>{fullDate(snapshot.createdAt)} · {formatBytes(snapshot.bytes)}</p></div><div className="restore-flow"><span><Archive size={18}/>{tr('选中的存档', 'Selected Save')}</span><ArrowRight size={17}/><span><GameGlyph icon={game.icon} size={18}/>{gameName(game)}</span></div><div className="path-display compact"><Folder size={15}/><code>{game.locations[platform].root}</code></div><div className="notice"><ShieldCheck size={19}/><span>{tr('应用会先自动保存当前进度到「读档恢复点」，校验成功后再读档；保存失败则停止读档。之后可用恢复点撤销本次读档。', 'SaveHub will automatically back up your current progress to Restore Points and verify it before restoring. If the backup fails, the restore is aborted.')}</span></div><p className="muted small-text">{tr(`将完整替换：${snapshot.entries.join('、')}。目录里新增的文件也会随之移除。`, `Will completely replace: ${snapshot.entries.join(', ')}. Extra files added in those directories will also be removed.`)}</p><label className="confirm-checkbox"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/><span>{tr('我已关闭游戏，并暂停会写入存档的云同步。', 'I have closed the game and paused any cloud sync that writes to save files.')}</span></label><div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={onCancel}>{tr('暂不读档', 'Not Now')}</button><button className="button primary" disabled={!confirmed || busy} onClick={onConfirm}>{busy ? <LoaderCircle size={16} className="spin"/> : <RotateCcw size={16}/>}{tr('确认读档', 'Confirm Load')}</button></div></>;
}
