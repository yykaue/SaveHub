import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Archive, ArrowRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3, ExternalLink, Folder, FolderOpen, Gamepad2, HardDrive, History, Info, LayoutGrid, Library, LoaderCircle, Monitor, Paintbrush, Plus, RotateCcw, Settings2, ShieldCheck, Sparkles, Star, Trash2, Upload, X } from 'lucide-react';
import { GameGlyph, Landscape, Logo } from './art';
import { SnapshotList, defaultView, matchesFilter, type LibraryView, type SnapshotAction } from './SnapshotList';
import { dateLabel, fullDate, formatBytes, kinds } from './format';
import { RestorePoints, type PointSelection } from './RestorePoints';
import { ImportConflicts, ImportResult } from './ImportDialog';
import { animate } from './motion';
import type { AppState, BatchReport, Bridge, Game, GameInput, ImportDecision, ImportPlan, ImportReport, Platform, Progress, Snapshot, Theme } from './types';

const themes: { id: Theme; name: string; english: string; caption: string; description: string }[] = [
  { id: 'ink', name: '水墨', english: 'INK & PAPER', caption: '一墨一世界', description: '宣纸肌理、淡墨远山与一抹朱红，在留白中安放你的冒险。' },
  { id: 'tech', name: '科技', english: 'LUMINOUS', caption: '让灵感透光', description: '冰蓝光线穿过清透界面，精密网格与微光勾勒未来秩序。' },
  { id: 'cyber', name: '赛博朋克', english: 'NEON CITY', caption: '接入另一现实', description: '电光蓝与霓虹粉交织，故障切片与高亮边框点燃夜色。' },
  { id: 'glass', name: '玻璃拟态', english: 'SOFT GLASS', caption: '看见光的层次', description: '朦胧色彩穿过磨砂玻璃，半透明界面在光影中轻盈悬浮。' },
];
const icons = ['ring', 'spire', 'flame', 'gamepad', 'swords', 'gem', 'ghost', 'rocket'];
const iconNames: Record<string, string> = { ring: '圆环', spire: '高塔', flame: '火焰', gamepad: '手柄', swords: '双剑', gem: '宝石', ghost: '幽灵', rocket: '火箭' };
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
    } catch (error) { setToast({ text: error instanceof Error ? error.message : '操作失败，请重试。', error: true }); return null; }
    finally { setBusy(''); setProgress(null); }
  };

  if (!api) return <div className="boot-screen"><Logo/><h1>用 SaveHub 桌面端开启冒险</h1><p>文件存读档需要 Electron 桌面客户端。</p><code>pnpm dev</code><p>或打开打包后的 SaveHub 应用。</p></div>;
  if (bootError) return <div className="boot-screen"><ShieldCheck size={42}/><h1>游戏库暂时无法读取</h1><p>{bootError}</p><button className="button primary" onClick={() => window.location.reload()}>重新加载</button></div>;
  if (!state) return <div className="boot-screen"><Logo/><LoaderCircle className="spin"/><p>正在打开你的存档库…</p></div>;

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
    const report = await perform('正在执行导入', () => api.executeImport(plan.id, decisions));
    if (report) setModal({ type: 'import-report', report });
  };
  const runImport = async (useLegacy = false) => {
    if (!current) return;
    const plan = await perform('正在检查导入存档', () => api.importSnapshots(current.id, useLegacy));
    if (!plan) return;
    if (plan.items.some(item => item.matches.length)) setModal({ type: 'import-conflicts', plan });
    else await executeImport(plan, []);
  };
  const snapshotAction = (action: SnapshotAction, snapshot: Snapshot) => {
    if (action === 'protect' && snapshot.deletedAt) { setToast({ text: '请先从回收站找回存档，再修改保护标记。', error: true }); return; }
    if (action === 'delete' && snapshot.protected) { setToast({ text: '保护存档不可删除，请先取消保护标记。', error: true }); return; }
    if (action === 'delete') { requestDelete([snapshot], snapshot.kind === 'safety' ? 'restore-points' : undefined); return; }
    if (action === 'detail' || action === 'restore') { setModal({ type: action, snapshot }); return; }
    if (action === 'edit') { setModal({ type: 'save', snapshot }); return; }
    if (action === 'favorite') { void perform('更新收藏标记', () => api.updateSnapshot(current.id, snapshot.id, { favorite: !snapshot.favorite })); return; }
    if (action === 'protect') { void perform('更新保护标记', () => api.updateSnapshot(current.id, snapshot.id, { protected: !snapshot.protected }), snapshot.protected ? '已取消保护标记。' : '已标记为保护存档，取消保护前不可删除，记录仍保留在全部存档中。'); return; }
    if (action === 'recover') { void perform('找回存档', () => api.updateSnapshot(current.id, snapshot.id, { deleted: false }), '已找回存档，保留原有收藏和保护标记。'); return; }
    if (action === 'verify') { void perform('正在校验存档', async () => { const result = await api.verifySnapshot(current.id, snapshot.id); setToast({ text: '完整性校验通过，' + result.fileCount + ' 个文件均完好。' }); }); return; }
    if (action === 'export') void perform('正在导出存档', async () => { const result = await api.exportSnapshot(current.id, snapshot.id); if (result) setToast({ text: '已导出到 ' + result }); });
  };
  const exportBatch = (selection: string[]) => perform('正在批量导出存档', async () => {
    const result = await api.exportSnapshots(current.id, selection);
    if (result) setToast({ text: '已导出 ' + result.count + ' 份存档到 ' + result.folder });
  });
  function requestDelete(snapshots: Snapshot[], returnTo?: 'restore-points') {
    if (!snapshots.length) return;
    if (snapshots.some(snapshot => snapshot.protected)) { setToast({ text: '保护存档不可删除，请先取消保护标记。', error: true }); return; }
    const permanent = snapshots.every(snapshot => snapshot.deletedAt);
    if (!permanent && snapshots.some(snapshot => snapshot.deletedAt)) { setToast({ text: '请分别操作正常记录和已删除记录。', error: true }); return; }
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
    const report = await perform('正在找回记录', () => api.updateSnapshots(gameId, ids, { deleted: false }));
    if (!report) return;
    finishSelection(gameId, report.updated);
    if (report.failed.length) setModal({ type: 'batch-report', report, returnTo });
    else setToast({ text: '已找回 ' + report.updated.length + ' 份记录，原有标记保持不变。' });
  }
  const confirmDelete = async (deletion: Extract<ModalState, { type: 'delete' }>) => {
    const ids = deletion.snapshots.map(snapshot => snapshot.id);
    const report = await perform(deletion.permanent ? '正在永久删除文件' : '正在移除记录', () => deletion.permanent ? api.deleteSnapshots(deletion.gameId, ids) : api.updateSnapshots(deletion.gameId, ids, { deleted: true }));
    if (!report) return;
    finishSelection(deletion.gameId, report.updated);
    if (report.failed.length) setModal({ type: 'batch-report', report, permanent: deletion.permanent, returnTo: deletion.returnTo });
    else {
      setToast({ text: (deletion.permanent ? '已永久删除 ' : '已移除 ') + report.updated.length + ' 份记录。' });
      setModal(deletion.returnTo ? { type: deletion.returnTo } : null);
    }
  }
  const batchProtect = async (selection: string[], protectedTag: boolean) => {
    const gameId = current.id;
    const report = await perform(protectedTag ? '正在批量保护' : '正在批量取消保护', () => api.updateSnapshots(gameId, selection, { protected: protectedTag }));
    if (!report) return;
    if (report.failed.length) { updateView({ selectedIds: report.failed.map(item => item.id) }, gameId); setModal({ type: 'batch-report', report }); }
    else setToast({ text: `已${protectedTag ? '保护' : '取消保护'} ${report.updated.length} 份存档。` });
  };

  return <>
    <div className={`app-shell platform-${state.platform}`} inert={modal ? true : undefined}>
      <div className="titlebar"><span>SaveHub <span className="titlebar-separator">/</span> 把冒险留在这里</span></div>
      <aside className="sidebar">
        <button className="brand" aria-label="SaveHub 首页" onClick={() => setPage('library')}><Logo/><span>SaveHub<small>你的游戏时光机</small></span></button>
        <div className="nav-label">工作空间 <span>WORKSPACE</span></div>
        <nav className="main-nav" aria-label="主导航">
          <button className={page === 'library' ? 'active' : ''} onClick={() => setPage('library')}><Library size={18}/><span>存档库</span><span className="nav-number">{allSnapshots.length}</span></button>
          <button className={page === 'games' ? 'active' : ''} onClick={() => setPage('games')}><LayoutGrid size={18}/><span>全部游戏</span></button>
        </nav>
        <div className="nav-label games-label">我的游戏 <button title="添加游戏" aria-label="添加游戏" disabled={!!busy} onClick={() => setModal({ type: 'game' })}><Plus size={16}/></button></div>
        <nav className="game-nav" aria-label="游戏列表">{games.map(game => <button key={game.id} className={current?.id === game.id && page === 'library' ? 'selected' : ''} onClick={() => chooseGame(game.id)}><span className="game-glyph" style={{ '--game-color': game.color } as React.CSSProperties}><GameGlyph icon={game.icon}/></span><span className="game-nav-name">{game.name}<small>{visibleSaves(game).length} 份存档</small></span>{current?.id === game.id && page === 'library' && <span className="selected-dot"/>}</button>)}</nav>
        <button className="add-game" disabled={!!busy} onClick={() => setModal({ type: 'game' })}><Plus size={15}/>添加游戏项目</button>
        <div className="sidebar-bottom">
          <div className="local-storage"><span className="storage-heading"><HardDrive size={16}/>本地资料库<span className="status-dot"/></span><strong>{formatBytes(storageBytes)}<small>已存储</small></strong><div className="storage-rule"/><p>每一份存档，都在你的设备上。</p><button onClick={() => perform('打开资料库', () => api.openFolder('vault'))}>打开文件夹<ExternalLink size={13}/></button></div>
          <nav className="main-nav"><button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}><Settings2 size={17}/><span>设置与关于</span></button></nav>
          <div className="sidebar-footer"><span className="tiny-mark">S / H</span><span>为下一次冒险，留一扇门。</span></div>
        </div>
      </aside>

      <div className="workspace">
        <header className="toolbar"><div className="breadcrumbs"><span>我的工作空间</span><ChevronRight size={13}/><strong>{({ library: '存档库', games: '全部游戏', themes: '外观与主题', settings: '设置与关于' })[page]}</strong></div><div className="toolbar-right"><span className="local-indicator"><span className="status-dot"/>本地模式</span><span className="toolbar-divider"/><button className={`theme-shortcut ${page === 'themes' ? 'is-open' : ''}`} aria-label="切换主题" aria-expanded={page === 'themes'} title={page === 'themes' ? '返回上次页面' : '选择主题风格'} onClick={toggleThemePage}><Paintbrush size={15}/>{themes.find(theme => theme.id === state.theme)?.name}<ChevronDown size={12}/></button><button className="icon-button" title="使用指南" aria-label="使用指南" onClick={() => setModal({ type: 'help' })}><CircleHelp size={17}/></button></div></header>
        <main className="main-content" ref={mainRef}><div className="route-content" data-page={page}>
          {page === 'library' && current && <>
            <div className="page-heading"><div><div className="eyebrow">YOUR ADVENTURE, PRESERVED.</div><h1>每一次冒险，都值得珍藏<span className="heading-period">。</span></h1><p>存下此刻的勇气，随时回到热爱的世界。</p></div><span className="ink-seal" aria-hidden="true">存<br/>心</span></div>
            <section className="game-hero" aria-label={`${current.name}游戏概览`}><Landscape kind={current.icon}/><div className="hero-shade"/><div className="hero-content"><div className="hero-kicker"><span className="small-line"/>正在管理的游戏</div><div className="hero-title"><GameGlyph icon={current.icon} size={30}/><h2>{current.name}</h2></div><p className="game-subtitle">{current.subtitle || 'MY NEXT ADVENTURE'}</p><div className="hero-status"><span className={`status-dot ${current.pathStatus !== 'ready' ? 'warning' : ''}`}/>{current.pathStatus === 'ready' ? '存档目录已连接' : current.pathStatus === 'missing' ? '存档目录不可用，请检查设置' : '等待配置存档目录'}<span className="hero-status-divider"/> {state.platform === 'darwin' ? 'macOS · Apple Silicon' : 'Windows'}</div><div className="hero-actions"><button className="button primary" disabled={!!busy} onClick={openSave}><Plus size={17}/>{current.pathStatus === 'ready' ? '创建新存档' : '配置存档路径'}</button><button className="button subtle" disabled={!!busy} onClick={() => setModal({ type: 'game', game: current })}><Settings2 size={15}/>游戏设置</button></div></div><span className="hero-caption">{current.icon === 'ring' ? '交界之地 · 未完待续' : current.icon === 'spire' ? '高塔之上 · 再次启程' : current.icon === 'flame' ? '余火未熄 · 故事未完' : '下一场冒险 · 由你续写'}</span><span className="hero-index">0{games.indexOf(current) + 1} / 0{games.length}</span></section>
            <section className="stats-row" aria-label="存档统计"><Stat icon={<Archive size={18}/>} label="全部存档" value={String(saves.length).padStart(2, '0')} unit="份"/><Stat icon={<ShieldCheck size={18}/>} label="读档保护" value="已开启" detail="恢复前自动备份"/><Stat icon={<HardDrive size={18}/>} label="全部存档占用" value={formatBytes(saves.reduce((sum, snapshot) => sum + snapshot.bytes, 0))} detail={`${totalFiles} 个文件`}/><Stat icon={<Clock3 size={18}/>} label="最近存档" value={saves[0] ? dateLabel(saves[0].createdAt) : '等待启程'} detail={saves[0] ? kinds[saves[0].kind] : '记录第一个游戏时刻'}/></section>
            <SnapshotList game={current} view={view} busy={!!busy} menu={menu} onMenu={setMenu} onViewChange={updateView} onAction={snapshotAction}
              onImport={runImport} onFolder={() => void perform('打开备份文件夹', () => api.openFolder('snapshots', current.id))} onCreate={openSave}
              onRestorePoints={() => setModal({ type: 'restore-points' })} onExport={selection => void exportBatch(selection)}
              onDelete={snapshots => requestDelete(snapshots)} onRecover={ids => void recoverBatch(current.id, ids)} onProtect={(selection, protectedTag) => void batchProtect(selection, protectedTag)}/>
            <footer className="page-footer"><span>SAVE YOUR PROGRESS. KEEP YOUR STORIES.</span><span>每一次归来，都是新的开始。</span></footer>
          </>}
          {page === 'library' && !current && <div className="empty-library"><Landscape/><div><Gamepad2 size={40}/><h1>为你的冒险，建一个家。</h1><p>添加第一个游戏，开始管理它的存档与每一次重新出发。</p><button className="button primary" onClick={() => setModal({ type: 'game' })}><Plus size={17}/>添加游戏</button></div></div>}

          {page === 'games' && <><PageHeading eyebrow="A HOME FOR EVERY WORLD." title="你的世界，都在这里。" description="每个游戏独立管理，让不同的冒险各得其所。"/><div className="section-heading games-heading"><h2>游戏项目 <span>{games.length}</span></h2><button className="button primary" disabled={!!busy} onClick={() => setModal({ type: 'game' })}><Plus size={16}/>添加游戏</button></div><div className="game-grid">{games.map(game => <article className="game-card" key={game.id}><div className="game-card-art"><Landscape kind={game.icon}/><span className="game-card-symbol"><GameGlyph icon={game.icon} size={28}/></span><button className="icon-button" title={`编辑 ${game.name}`} aria-label={`编辑 ${game.name}`} disabled={!!busy} onClick={() => setModal({ type: 'game', game })}><Settings2 size={17}/></button></div><div className="game-card-body"><span className="eyebrow">{game.subtitle || 'YOUR OWN WORLD'}</span><h2>{game.name}</h2><p><span className={`status-dot ${game.pathStatus !== 'ready' ? 'warning' : ''}`}/>{game.pathStatus === 'ready' ? '存档目录已连接' : '需要配置存档路径'}<span>{visibleSaves(game).length} 份存档</span></p><button className="button secondary" onClick={() => chooseGame(game.id)}>进入存档库<ArrowRight size={15}/></button></div></article>)}<button className="new-game-card" disabled={!!busy} onClick={() => setModal({ type: 'game' })}><span><Plus size={25}/></span><strong>下一个世界</strong><p>添加你喜欢的游戏</p></button></div></>}

          {page === 'themes' && <><PageHeading eyebrow="A DIFFERENT WAY TO FEEL." title="换个心境，再次出发。" description="四种风格，同一份热爱。选择属于你的存档空间。"/><div className="theme-grid">{themes.map(theme => <button key={theme.id} className={`theme-card ${state.theme === theme.id ? 'chosen' : ''}`} disabled={!!busy} onClick={() => perform('切换主题', () => api.setTheme(theme.id))} aria-label={`切换${theme.name}主题`} aria-pressed={state.theme === theme.id}><div className={`theme-preview preview-${theme.id}`}><div className="mini-sidebar"><i/><i/><i/><i/></div><div className="mini-workspace"><div className="mini-title"/><div className="mini-hero"><span>{theme.caption}</span><div className="mini-moon"/></div><div className="mini-stats"><i/><i/><i/></div><div className="mini-row"/><div className="mini-row"/></div><span className="preview-label">{theme.english}</span></div><div className="theme-card-copy"><div><h2>{theme.name}</h2><span>{theme.english}</span></div><span className={`theme-check ${state.theme === theme.id ? 'checked' : ''}`}>{state.theme === theme.id && <Check size={14}/>}</span><p>{theme.description}</p></div></button>)}</div><div className="theme-note"><Sparkles size={19}/><div><strong>外观随心，记录如初</strong><p>主题会即时应用并自动保存，下次打开仍是你喜欢的样子。</p></div><span>{themes.find(theme => theme.id === state.theme)?.name} · 使用中</span></div></>}

          {page === 'settings' && <><PageHeading eyebrow="YOUR SAVES. YOUR DEVICE." title="安心存放，从容启程。" description="一切保存在本地，由你掌握。"/><section className="settings-card"><h2><HardDrive size={20}/>本地资料库</h2><p>游戏配置、图标和备份保存在以下位置。卸载应用时不会主动移除资料库。</p><div className="path-display"><Folder size={17}/><code>{state.dataDir}</code><button className="icon-button" title="打开资料库" onClick={() => perform('打开资料库', () => api.openFolder('vault'))}><ExternalLink size={16}/></button></div><div className="settings-metrics"><span>{state.games.length} 个游戏项目（含已移除）</span><span>{formatBytes(storageBytes)} 已使用</span><span>{state.platform === 'darwin' ? 'macOS / Apple Silicon' : 'Windows'}</span></div></section><section className="settings-card"><h2><ShieldCheck size={20}/>每次读档，多一份保障</h2><div className="protection-grid"><div><CheckCheck size={22}/><strong>完整性校验</strong><p>创建与恢复均校验文件内容，发现异常即停止操作。</p></div><div><History size={22}/><strong>读档前自动备份</strong><p>保留恢复前的进度，可在「读档恢复点」中找到。</p></div><div><RotateCcw size={22}/><strong>失败回滚</strong><p>文件替换失败时回滚，中途退出后会在下次启动恢复。</p></div></div></section><section className="settings-card"><h2><Trash2 size={20}/>已移除的游戏</h2><p>移除项目会保留已有备份，不会删除游戏原文件。</p>{state.games.filter(game => game.deletedAt).length ? state.games.filter(game => game.deletedAt).map(game => <div className="removed-game" key={game.id}><GameGlyph icon={game.icon}/><strong>{game.name}</strong><span>{game.snapshots.length} 份存档</span><button className="button secondary small" disabled={!!busy} onClick={() => perform('恢复游戏项目', () => api.removeGame(game.id, true), '游戏项目已找回。')}><RotateCcw size={14}/>找回项目</button></div>) : <div className="quiet-empty">暂时没有已移除的游戏。</div>}</section><div className="about-line"><Logo small/><strong>SaveHub</strong><span>v{state.version}</span><span>Electron · Windows & macOS</span><button className="text-button" onClick={() => setModal({ type: 'help' })}>使用指南<ArrowRight size={14}/></button></div></>}
        </div></main>
      </div>
    </div>

    {modal && <Modal title={modalTitle(modal)} onClose={closeModal} busy={!!busy} wide={modal.type === 'game' || modal.type === 'restore-points' || modal.type === 'import-conflicts' || modal.type === 'import-report'}>
      {modal.type === 'game' && <GameForm game={modal.game} platform={state.platform} api={api} busy={!!busy} onCancel={() => setModal(null)} onSave={async values => { const id = await perform('保存游戏设置', () => api.saveGame(values), '游戏设置已保存。', true); if (id) chooseGame(id); }} onDelete={modal.game ? () => setModal({ type: 'remove-game', game: modal.game! }) : undefined}/ >}
      {modal.type === 'save' && current && <SnapshotForm snapshot={modal.snapshot} busy={!!busy} onCancel={() => setModal(null)} onSave={values => perform(modal.snapshot ? '保存存档信息' : '正在创建存档', async () => { if (modal.snapshot) await api.updateSnapshot(current.id, modal.snapshot.id, values); else await api.saveSnapshot(current.id, values); }, modal.snapshot ? '存档信息已更新。' : '新存档已创建，文件校验通过。', true)}/ >}
      {modal.type === 'restore' && current && <RestoreConfirm snapshot={modal.snapshot} game={current} platform={state.platform} busy={!!busy} onCancel={() => setModal(null)} onConfirm={() => perform('正在安全恢复存档', () => api.restoreSnapshot(current.id, modal.snapshot.id), `已读取「${modal.snapshot.label}」，原进度已保存为读档恢复点。`, true)}/ >}
      {modal.type === 'delete' && <DeleteConfirmation snapshots={modal.snapshots} permanent={modal.permanent} busy={!!busy} onCancel={closeModal} onConfirm={() => void confirmDelete(modal)}/>}
      {modal.type === 'batch-report' && <><p className="dialog-description">已完成 {modal.report.updated.length} 份，未完成 {modal.report.failed.length} 份。</p><p className="muted">{modal.permanent ? '部分文件可能已被删除；标记为“永久删除未完成”的记录只能继续清理，不能找回。' : '未完成的项目保留原状，可根据下列原因处理后重试。'}</p>{modal.report.failed.map(item => <div className="notice error" key={item.id}><strong>{item.label}</strong><p>{item.error}</p></div>)}<div className="dialog-actions"><button className="button secondary" onClick={closeModal}>关闭</button></div></>}
      {modal.type === 'restore-points' && current && <><RestorePoints points={current.restorePoints} selection={pointSelections[current.id] ?? { active: [], removed: [] }} busy={!!busy} canRestore={current.pathStatus === 'ready'} onSelect={(group, ids) => setPointSelections(all => ({ ...all, [current.id]: { ...(all[current.id] ?? { active: [], removed: [] }), [group]: ids } }))} onRestore={snapshot => setModal({ type: 'restore', snapshot })} onExport={snapshot => snapshotAction('export', snapshot)} onDelete={snapshots => requestDelete(snapshots, 'restore-points')} onRecover={ids => void recoverBatch(current.id, ids, 'restore-points')}/><div className="dialog-actions"><button className="button secondary" onClick={() => setModal(null)}>关闭</button></div></>}
      {modal.type === 'remove-game' && <><div className="dialog-symbol"><Gamepad2 size={26}/></div><p className="dialog-description">移除「{modal.game.name}」这个游戏项目？</p><p className="muted">现有备份会保留，可在「设置与关于 → 已移除的游戏」中找回。游戏原文件不受影响。</p><div className="dialog-actions"><button className="button secondary" disabled={!!busy} onClick={() => setModal(null)}>取消</button><button className="button danger" disabled={!!busy} onClick={() => perform('移除游戏项目', () => api.removeGame(modal.game.id), '游戏项目已移除，备份仍然保留。', true)}>移除游戏</button></div></>}
      {modal.type === 'detail' && <><div className="detail-name"><Archive size={23}/><h3>{modal.snapshot.label}</h3></div><p className="detail-note">{modal.snapshot.note || '这份存档还没有添加备注。'}</p><dl className="details-grid"><dt>创建时间</dt><dd>{fullDate(modal.snapshot.createdAt)}</dd><dt>存档来源</dt><dd>{kinds[modal.snapshot.kind]}</dd><dt>当前标记</dt><dd>{[modal.snapshot.favorite && '已收藏', modal.snapshot.protected && '保护', modal.snapshot.deletedAt && '回收站'].filter(Boolean).join('、') || '无'}</dd><dt>文件数量</dt><dd>{modal.snapshot.fileCount} 个 · {formatBytes(modal.snapshot.bytes)}</dd><dt>来源平台</dt><dd>{modal.snapshot.platform === 'darwin' ? 'macOS' : 'Windows'}</dd><dt>备份项目</dt><dd>{modal.snapshot.entries.map(entry => <code key={entry}>{entry}</code>)}</dd><dt>唯一标识</dt><dd className="mono small-text">{modal.snapshot.id}</dd></dl>{modal.snapshot.absent?.length > 0 && <div className="notice">此恢复记录包含当时不存在的路径：{modal.snapshot.absent.join('、')}。恢复它会让这些路径重新回到不存在的状态。</div>}{modal.snapshot.corrupted && <div className="notice error">{modal.snapshot.error}</div>}<div className="dialog-actions"><button className="button secondary" onClick={() => setModal(null)}>关闭</button></div></>}
      {modal.type === 'import-conflicts' && <ImportConflicts key={modal.plan.id} plan={modal.plan} busy={!!busy} onCancel={closeModal} onConfirm={decisions => void executeImport(modal.plan, decisions)}/>}
      {modal.type === 'import-report' && <ImportResult report={modal.report} onClose={() => setModal(null)}/>}
      {modal.type === 'help' && <><div className="help-intro"><Logo/><p>为每一次尝试，留一条回来的路。</p></div><ol className="help-steps"><li><strong>连接游戏存档</strong><p>在游戏设置中选择根目录，填写需要备份的文件或子目录，每行一个相对路径。</p></li><li><strong>关闭游戏，再创建存档</strong><p>起个好记的名字，加上备注。应用会复制并校验完整内容。</p></li><li><strong>选择时刻，安全读档</strong><p>关闭游戏及会写入存档的云同步后点击读档。当前进度会自动留在「读档恢复点」。</p></li><li><strong>带回已有的存档</strong><p>使用「导入存档」选择包含 ArchiveFile… 的旧目录、单份旧存档目录，或 SaveHub 导出的存档文件夹。</p></li></ol><div className="notice"><Monitor size={17}/><span>Windows 与 macOS 路径分别配置。macOS 上的兼容层游戏，请选择实际的 Wine / CrossOver 存档目录。</span></div><div className="dialog-actions"><button className="button primary" onClick={() => setModal(null)}>开始我的冒险<ArrowRight size={15}/></button></div></>}
    </Modal>}
    {busy && <div className="progress-panel" role="status"><LoaderCircle size={21} className="spin"/><div><strong>{busy}</strong><p>{progress?.detail || '正在准备，请稍候…'}</p></div>{progress?.total ? <span>{progress.completed} / {progress.total}</span> : null}<div className="progress-bar"><i style={{ width: progress?.total ? `${Math.max(3, 100 * progress.completed / progress.total)}%` : '35%' }}/></div></div>}
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <Info size={19}/> : <Check size={19}/>}<span>{toast.text}</span><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={16}/></button></div>}
  </>;
}

function DeleteConfirmation({ snapshots, permanent, busy, onCancel, onConfirm }: { snapshots: Snapshot[]; permanent: boolean; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const points = snapshots.every(snapshot => snapshot.kind === 'safety');
  const destination = points ? '已移除的恢复点' : '回收站';
  const label = permanent ? '确认永久删除 ' + snapshots.length + ' 份' : points ? '确认移除 ' + snapshots.length + ' 份' : snapshots.length === 1 ? '移入回收站' : '确认删除 ' + snapshots.length + ' 份';
  return <><p className="dialog-description">{permanent ? '永久删除以下 ' + snapshots.length + ' 份记录及其真实文件？' : '将以下 ' + snapshots.length + ' 份记录移入“' + destination + '”？'}</p>
    {permanent && <div className="notice permanent-delete-warning" role="note"><Trash2 size={19}/><div><strong>永久删除，无法恢复</strong><p>文件将从磁盘中实际删除，操作完成后不能再找回。游戏目录中的当前进度不受影响。</p></div></div>}
    <FavoriteDeleteNotice snapshots={snapshots} permanent={permanent}/><ul className="batch-confirm-list">{snapshots.map(snapshot => <li key={snapshot.id} className={snapshot.favorite ? 'favorite-delete-item' : undefined}>{snapshot.label}{snapshot.favorite && <span className="favorite-delete-tag"><Star size={12}/>已收藏</span>}</li>)}</ul>
    {!permanent && <p className="muted">文件暂时保留。在“{destination}”中可多选或全选后找回，也可以再次确认后永久删除。</p>}
    <div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={onCancel}>取消</button><button className="button danger" disabled={busy || snapshots.some(snapshot => snapshot.protected)} onClick={onConfirm}>{label}</button></div></>;
}

function FavoriteDeleteNotice({ snapshots, permanent = false }: { snapshots: Snapshot[]; permanent?: boolean }) {
  const count = snapshots.filter(snapshot => snapshot.favorite).length;
  if (!count) return null;
  return <div className="notice favorite-delete-warning" role="note" aria-label="包含已收藏存档"><Star size={22}/><div><strong>注意：本次删除包含 {count} 份已收藏存档</strong><p>{permanent ? '这些收藏记录及其文件也会永久删除，无法找回。确认后会继续删除。' : '请确认这些收藏记录也需要移除。确认后会继续删除，找回时仍保留收藏标记。'}</p></div></div>;
}

function Stat({ icon, label, value, unit, detail }: { icon: ReactNode; label: string; value: string; unit?: string; detail?: string }) {
  return <div className="stat"><div className="stat-label">{icon}{label}</div><div className="stat-value">{value}{unit && <span>{unit}</span>}</div>{detail && <small>{detail}</small>}</div>;
}
function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="page-heading standalone"><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>;
}
function modalTitle(modal: ModalState) {
  return ({ game: modal.type === 'game' && modal.game ? '游戏设置' : '添加游戏项目', save: modal.type === 'save' && modal.snapshot ? '编辑存档信息' : '珍藏这一刻', restore: '回到这个游戏时刻', delete: modal.type === 'delete' && modal.permanent ? '永久删除存档' : '移除存档', 'remove-game': '移除游戏项目', detail: '存档详情', 'restore-points': '读档恢复点', 'batch-report': '批量操作结果', 'import-conflicts': '处理重复存档', 'import-report': '导入结果', help: '与 SaveHub 一起出发' })[modal.type];
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
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={ref}><div className="modal-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label="关闭对话框" disabled={busy} onClick={onClose}><X size={20}/></button></div><div className="modal-body">{children}</div></div></div>;
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
  const pick = async (kind: 'icon' | 'directory') => {
    try { const value = kind === 'icon' ? await api.pickIcon() : await api.pickDirectory(); if (value) { if (kind === 'icon') setIcon(value); else setLocations({ ...locations, [tab]: { ...locations[tab], root: value } }); } }
    catch (error) { setError((error as Error).message); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); onSave({ id: game?.id, name, subtitle, icon, color, legacyRoot, locations: { win32: { root: locations.win32.root, items: rawItems.win32.split('\n').map(item => item.trim()).filter(Boolean) }, darwin: { root: locations.darwin.root, items: rawItems.darwin.split('\n').map(item => item.trim()).filter(Boolean) } } }); };
  return <form onSubmit={submit}><fieldset disabled={busy}><div className="game-form-intro"><span className="edit-game-icon" style={{ '--game-color': color } as React.CSSProperties}><GameGlyph icon={icon} size={33}/></span><div><p>每个世界，都有自己的名字。</p><small>自定义游戏资料，并连接它的存档位置。</small></div></div><div className="form-columns"><label className="field">游戏名称 <span>*</span><input autoComplete="off" required maxLength={80} placeholder="例如：艾尔登法环" value={name} onChange={event => setName(event.target.value)}/></label><label className="field">副标题<input maxLength={80} placeholder="例如：ELDEN RING" value={subtitle} onChange={event => setSubtitle(event.target.value)}/></label></div><div className="icon-picker"><span>游戏图标</span><div>{icons.map(value => <button type="button" key={value} className={icon === value ? 'chosen' : ''} aria-label={`${iconNames[value]}图标`} onClick={() => setIcon(value)}><GameGlyph icon={value} size={20}/></button>)}<button type="button" className="upload-icon" title="上传自定义图标" onClick={() => pick('icon')}><Upload size={17}/>上传</button></div></div><div className="color-picker"><span>点缀色</span>{colors.map(value => <button key={value} type="button" style={{ background: value }} aria-label={`颜色 ${value}`} aria-pressed={color === value} onClick={() => setColor(value)}>{color === value && <Check size={13}/>}</button>)}</div><div className="form-divider"/><div className="platform-tabs" role="tablist" aria-label="路径平台"><button type="button" role="tab" aria-selected={tab === 'win32'} className={tab === 'win32' ? 'active' : ''} onClick={() => void animate(() => setTab('win32'))}><Monitor size={15}/>Windows {platform === 'win32' && <small>当前系统</small>}</button><button type="button" role="tab" aria-selected={tab === 'darwin'} className={tab === 'darwin' ? 'active' : ''} onClick={() => void animate(() => setTab('darwin'))}><Monitor size={15}/>macOS <small>Apple Silicon</small></button></div><label className="field">游戏存档根目录<div className="input-with-button"><input aria-label="游戏存档根目录" placeholder={tab === 'win32' ? 'C:\\Users\\你的用户名\\AppData\\Roaming\\游戏' : '/Users/你的用户名/Library/Application Support/游戏'} value={locations[tab].root} onChange={event => setLocations({ ...locations, [tab]: { ...locations[tab], root: event.target.value } })}/><button type="button" disabled={tab !== platform} title={tab !== platform ? '其他系统的路径请手动填写' : '浏览文件夹'} onClick={() => pick('directory')}><FolderOpen size={17}/></button></div></label><label className="field">要备份的文件或目录<textarea rows={3} spellCheck={false} placeholder={'每行一个相对路径，例如：\nsaves\npreferences'} value={rawItems[tab]} onChange={event => setRawItems({ ...rawItems, [tab]: event.target.value })}/><small>相对于上方根目录。支持多个文件和目录，也支持空格、中文及多级路径。</small></label>{tab === 'darwin' && <div className="notice compact"><Info size={15}/><span>通过 CrossOver / Wine 运行的游戏，填写其容器内的实际存档路径。</span></div>}<details className="advanced-settings"><summary>旧脚本存档目录（可选）</summary><label className="field"><input value={legacyRoot} onChange={event => setLegacyRoot(event.target.value)} placeholder="包含 ArchiveFile… 的旧备份目录"/><small>只用于发现旧备份。导入时会复制原内容。</small></label></details>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions">{onDelete && <button type="button" className="text-button danger-text delete-game-button" onClick={onDelete}><Trash2 size={15}/>移除游戏</button>}<button type="button" className="button secondary" onClick={onCancel}>取消</button><button type="submit" className="button primary">{busy ? <LoaderCircle className="spin" size={15}/> : <Check size={15}/>}保存游戏</button></div></fieldset></form>;
}

function SnapshotForm({ snapshot, busy, onSave, onCancel }: { snapshot?: Snapshot; busy: boolean; onSave: (values: { label: string; note: string }) => Promise<unknown>; onCancel: () => void }) {
  const [label, setLabel] = useState(snapshot?.label || `冒险记录 · ${dateLabel(new Date().toISOString())}`);
  const [note, setNote] = useState(snapshot?.note || '');
  return <form onSubmit={event => { event.preventDefault(); onSave({ label, note }); }}><fieldset disabled={busy}><p className="form-description">{snapshot ? '让每一份进度，都容易辨认。' : '为这个时刻起个名字，以后便能轻松找到它。'}</p><label className="field">存档名称<input required maxLength={100} value={label} onChange={event => setLabel(event.target.value)} placeholder="例如：挑战最终 Boss 之前"/></label><label className="field">给未来的自己留句话 <span className="optional">可选</span><textarea rows={4} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} placeholder="记录周目、角色、地点，或这次冒险的心情…"/></label>{!snapshot && <div className="notice"><Info size={17}/><span>请先关闭游戏，让存档文件保持完整。所有已配置的文件和目录会一起备份。</span></div>}<div className="dialog-actions"><button type="button" className="button secondary" onClick={onCancel}>取消</button><button className="button primary" type="submit">{busy ? <LoaderCircle size={16} className="spin"/> : <Archive size={16}/>} {snapshot ? '保存修改' : '创建存档'}</button></div></fieldset></form>;
}
function RestoreConfirm({ snapshot, game, platform, busy, onConfirm, onCancel }: { snapshot: Snapshot; game: Game; platform: Platform; busy: boolean; onConfirm: () => Promise<unknown>; onCancel: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  return <><div className="restore-card"><div className="dialog-symbol"><History size={27}/></div><h3>{snapshot.label}</h3><p>{fullDate(snapshot.createdAt)} · {formatBytes(snapshot.bytes)}</p></div><div className="restore-flow"><span><Archive size={18}/>选中的存档</span><ArrowRight size={17}/><span><GameGlyph icon={game.icon} size={18}/>{game.name}</span></div><div className="path-display compact"><Folder size={15}/><code>{game.locations[platform].root}</code></div><div className="notice"><ShieldCheck size={19}/><span>应用会先自动保存当前进度到「读档恢复点」，校验成功后再读档；保存失败则停止读档。之后可用恢复点撤销本次读档。</span></div><p className="muted small-text">将完整替换：{snapshot.entries.join('、')}。目录里新增的文件也会随之移除。</p><label className="confirm-checkbox"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/><span>我已关闭游戏，并暂停会写入存档的云同步。</span></label><div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={onCancel}>暂不读档</button><button className="button primary" disabled={!confirmed || busy} onClick={onConfirm}>{busy ? <LoaderCircle size={16} className="spin"/> : <RotateCcw size={16}/>}确认读档</button></div></>;
}
