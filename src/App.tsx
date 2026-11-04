import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  Archive,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  ExternalLink,
  Folder,
  Gamepad2,
  HardDrive,
  History,
  Info,
  Languages,
  LayoutGrid,
  Library,
  LoaderCircle,
  Monitor,
  Paintbrush,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { GameGlyph, Landscape, Logo } from './art';
import { SnapshotList, defaultView, matchesFilter, type LibraryView, type SnapshotAction } from './SnapshotList';
import { dateLabel, fullDate, formatBytes, gameName, kindLabel } from './format';
import {
  SUPPORTED_LANGUAGES,
  getLanguage,
  getLanguageMeta,
  getNextLanguage,
  normalizeLanguage,
  setLanguage,
  subscribeLanguage,
  t,
} from './i18n';
import { RestorePoints, type PointSelection } from './RestorePoints';
import { ImportConflicts, ImportResult } from './ImportDialog';
import { AllGames, type GamesView } from './AllGames';
import {
  GameDeleteConfirmation,
  GameExportConfirmation,
  GameImportChoices,
  GameImportReviewDialog,
  GameImportResults,
} from './GameManagement';
import { DeleteConfirmation } from './modals/DeleteConfirmation';
import { GameForm } from './modals/GameForm';
import { Modal } from './modals/Modal';
import { RestoreConfirm } from './modals/RestoreConfirm';
import { SnapshotForm } from './modals/SnapshotForm';
import { animate } from './motion';
import type {
  AppState,
  BatchReport,
  Game,
  GameImportPlan,
  GameImportReview,
  GameImportReport,
  GameSnapshotDecision,
  ImportDecision,
  ImportPlan,
  ImportReport,
  Language,
  Progress,
  Snapshot,
  Theme,
} from './types';

const getThemes = (): { id: Theme; name: string; english: string; caption: string; description: string }[] => [
  { id: 'ink', name: t('themes.inkName'), english: 'INK & PAPER', caption: t('themes.inkCaption'), description: t('themes.inkDesc') },
  { id: 'tech', name: t('themes.techName'), english: 'LUMINOUS', caption: t('themes.techCaption'), description: t('themes.techDesc') },
  { id: 'cyber', name: t('themes.cyberName'), english: 'NEON CITY', caption: t('themes.cyberCaption'), description: t('themes.cyberDesc') },
  { id: 'glass', name: t('themes.glassName'), english: 'SOFT GLASS', caption: t('themes.glassCaption'), description: t('themes.glassDesc') },
];

const visibleSaves = (game: Game) => game.snapshots.filter(snapshot => matchesFilter(snapshot, 'all'));

type Page = 'library' | 'games' | 'themes' | 'settings';
type ModalState =
  | { type: 'restore-points' }
  | { type: 'delete'; gameId: string; snapshots: Snapshot[]; permanent: boolean; returnTo?: 'restore-points' }
  | { type: 'batch-report'; report: BatchReport; permanent?: boolean; returnTo?: 'restore-points' }
  | { type: 'game'; game?: Game }
  | { type: 'save'; snapshot?: Snapshot }
  | { type: 'restore'; snapshot: Snapshot }
  | { type: 'remove-game'; game: Game }
  | { type: 'export-games'; games: Game[] }
  | { type: 'game-import'; plan: GameImportPlan }
  | { type: 'game-import-review'; review: GameImportReview }
  | { type: 'game-import-report'; report: GameImportReport }
  | { type: 'detail'; snapshot: Snapshot }
  | { type: 'import-conflicts'; plan: ImportPlan }
  | { type: 'import-report'; report: ImportReport }
  | { type: 'help' };

export default function App() {
  const api = window.savehub;
  useSyncExternalStore(subscribeLanguage, getLanguage);
  const [state, setState] = useState<AppState | null>(null);
  const [bootError, setBootError] = useState('');
  const [page, setPageState] = useState<Page>('games');
  const [gamesView, setGamesView] = useState<GamesView>(() => ({
    layout: localStorage.getItem('savehub-games-layout') === 'list' ? 'list' : 'cards',
    query: '',
    removed: false,
    selectedIds: [],
  }));
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
  const themeReturn = useRef<{ page: Exclude<Page, 'themes'>; gameId: string; scrollTop: number }>({
    page: 'games',
    gameId: selected,
    scrollTop: 0,
  });

  const setModal = (next: ModalState | null) => {
    void animate(() => setModalState(next));
  };

  const setPage = (next: Page) => {
    nextScroll.current = 0;
    void animate(() => {
      setPageState(next);
      setMenu(null);
    });
  };

  const toggleThemePage = () => {
    if (page === 'themes') {
      const previous = themeReturn.current;
      nextScroll.current = previous.scrollTop;
      void animate(() => {
        setPageState(previous.page);
        setSelected(previous.gameId);
        setMenu(null);
      });
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
    const lang = normalizeLanguage(next.language);
    setLanguage(lang);
    localStorage.setItem('savehub-language', lang);
    document.documentElement.lang = getLanguageMeta(lang).htmlLang;
    document.title = t('app.documentTitle', undefined, lang);
    await animate(() => {
      setState(next);
      document.documentElement.dataset.theme = next.theme;
    });
    return next;
  }, [api]);

  useEffect(() => {
    refresh()
      .then(next => {
        if (next?.recoveryMessages.length) setToast({ text: next.recoveryMessages.join('\n') });
      })
      .catch(error => setBootError(error.message));
    return api?.onProgress(setProgress);
  }, [refresh, api]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.error ? 14000 : 6500);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    setMenu(null);
    localStorage.setItem('savehub-selected', selected);
  }, [selected]);

  useEffect(() => {
    localStorage.setItem('savehub-games-layout', gamesView.layout);
  }, [gamesView.layout]);

  useEffect(() => {
    if (state && !state.games.some(game => game.id === selected && !game.deletedAt)) {
      setSelected(state.games.find(game => !game.deletedAt)?.id || '');
    }
  }, [state, selected]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  const perform = async <T,>(label: string, action: () => Promise<T>, success?: string, close = false) => {
    if (busy) return null;
    setBusy(label);
    setMenu(null);
    try {
      const result = await action();
      await refresh();
      if (success) setToast({ text: success });
      if (close) setModal(null);
      return result;
    } catch (error) {
      await refresh().catch(() => {});
      setToast({ text: error instanceof Error ? error.message : t('messages.operationFailed'), error: true });
      return null;
    } finally {
      setBusy('');
      setProgress(null);
    }
  };

  if (!api) {
    return (
      <div className="boot-screen">
        <Logo />
        <h1>{t('app.bootNoDesktopTitle')}</h1>
        <p>{t('app.bootNoDesktopDesc')}</p>
        <code>pnpm dev</code>
        <p>{t('app.bootNoDesktopHint')}</p>
      </div>
    );
  }
  if (bootError) {
    return (
      <div className="boot-screen">
        <ShieldCheck size={42} />
        <h1>{t('app.bootErrorTitle')}</h1>
        <p>{bootError}</p>
        <button className="button primary" onClick={() => window.location.reload()}>
          {t('app.reload')}
        </button>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="boot-screen">
        <Logo />
        <LoaderCircle className="spin" />
        <p>{t('app.bootLoading')}</p>
      </div>
    );
  }

  const language = normalizeLanguage(state.language);
  const currentLangMeta = getLanguageMeta(language);
  const nextLangMeta = getNextLanguage(language);
  const themes = getThemes();

  const switchLanguage = (nextLang: Language) => {
    if (nextLang === language) return;
    void perform(t('messages.switchingLanguage', undefined, nextLang), () => api.setLanguage(nextLang));
  };

  const games = state.games.filter(game => !game.deletedAt);
  const current = games.find(game => game.id === selected) || games[0];
  const allSnapshots = games.flatMap(game => visibleSaves(game));
  const storageBytes = state.games
    .flatMap(game => [...game.snapshots, ...game.restorePoints])
    .reduce((total, snapshot) => total + snapshot.bytes, 0);
  const saves = current ? visibleSaves(current) : [];
  const view = views[current?.id] || defaultView;

  const updateView = (changes: Partial<LibraryView>, gameId = current.id) => {
    const update = () =>
      setViews(previous => ({ ...previous, [gameId]: { ...(previous[gameId] || defaultView), ...changes } }));
    setMenu(null);
    if ('filter' in changes || 'sort' in changes) void animate(update);
    else update();
  };

  const totalFiles = saves.reduce((sum, snapshot) => sum + snapshot.fileCount, 0);
  const chooseGame = (id: string) => {
    nextScroll.current = 0;
    void animate(() => {
      setSelected(id);
      setPageState('library');
      setMenu(null);
    });
  };
  const openSave = () => {
    if (current?.pathStatus !== 'ready') setModal({ type: 'game', game: current });
    else setModal({ type: 'save' });
  };
  const executeImport = async (plan: ImportPlan, decisions: ImportDecision[]) => {
    const report = await perform(t('messages.executingImport'), () => api.executeImport(plan.id, decisions));
    if (report) setModal({ type: 'import-report', report });
  };
  const runImport = async (useLegacy = false) => {
    if (!current) return;
    const plan = await perform(t('messages.checkingImport'), () => api.importSnapshots(current.id, useLegacy));
    if (!plan) return;
    if (plan.items.some(item => item.matches.length)) setModal({ type: 'import-conflicts', plan });
    else await executeImport(plan, []);
  };
  const runGameImport = async () => {
    const plan = await perform(t('games.importing'), () => api.importGames());
    if (plan) setModal({ type: 'game-import', plan });
  };
  const reviewGames = async (planId: string, decisions: ImportDecision[]) => {
    const review = await perform(t('games.reviewing'), () => api.reviewGameImport(planId, decisions));
    if (review) setModal({ type: 'game-import-review', review });
  };
  const importGames = async (reviewId: string, decisions: GameSnapshotDecision[]) => {
    const report = await perform(t('games.executing'), () => api.executeGameImport(reviewId, decisions));
    if (report) setModal({ type: 'game-import-report', report });
  };

  const snapshotAction = (action: SnapshotAction, snapshot: Snapshot) => {
    if (action === 'protect' && snapshot.deletedAt) {
      setToast({ text: t('messages.recoverBeforeProtectError'), error: true });
      return;
    }
    if (action === 'delete' && snapshot.protected) {
      setToast({ text: t('messages.protectedCannotDeleteError'), error: true });
      return;
    }
    if (action === 'delete') {
      requestDelete([snapshot], snapshot.kind === 'safety' ? 'restore-points' : undefined);
      return;
    }
    if (action === 'detail' || action === 'restore') {
      setModal({ type: action, snapshot });
      return;
    }
    if (action === 'edit') {
      setModal({ type: 'save', snapshot });
      return;
    }
    if (action === 'favorite') {
      void perform(t('messages.updatingFavorite'), () =>
        api.updateSnapshot(current.id, snapshot.id, { favorite: !snapshot.favorite }),
      );
      return;
    }
    if (action === 'protect') {
      void perform(
        t('messages.updatingProtection'),
        () => api.updateSnapshot(current.id, snapshot.id, { protected: !snapshot.protected }),
        snapshot.protected ? t('messages.unprotectedToast') : t('messages.protectedToast'),
      );
      return;
    }
    if (action === 'recover') {
      void perform(
        t('messages.recoveringSave'),
        () => api.updateSnapshot(current.id, snapshot.id, { deleted: false }),
        t('messages.recoveredSaveToast'),
      );
      return;
    }
    if (action === 'verify') {
      void perform(t('messages.verifyingSave'), async () => {
        const result = await api.verifySnapshot(current.id, snapshot.id);
        setToast({ text: t('messages.verifiedToast', { count: result.fileCount }) });
      });
      return;
    }
    if (action === 'export') {
      void perform(t('messages.exportingSave'), async () => {
        const result = await api.exportSnapshot(current.id, snapshot.id);
        if (result) setToast({ text: t('messages.exportedSingleToast', { path: result }) });
      });
    }
  };

  const exportBatch = (selection: string[]) =>
    perform(t('messages.exportingBatch'), async () => {
      const result = await api.exportSnapshots(current.id, selection);
      if (result) setToast({ text: t('messages.exportedBatchToast', { count: result.count, folder: result.folder }) });
    });

  function requestDelete(snapshots: Snapshot[], returnTo?: 'restore-points') {
    if (!snapshots.length) return;
    if (snapshots.some(snapshot => snapshot.protected)) {
      setToast({ text: t('messages.protectedCannotDeleteError'), error: true });
      return;
    }
    const permanent = snapshots.every(snapshot => snapshot.deletedAt);
    if (!permanent && snapshots.some(snapshot => snapshot.deletedAt)) {
      setToast({ text: t('messages.separateActiveAndDeletedError'), error: true });
      return;
    }
    setModal({ type: 'delete', gameId: snapshots[0].gameId, snapshots, permanent, returnTo });
  }

  function closeModal() {
    if (busy) return;
    if (modal?.type === 'import-conflicts') {
      void api!.cancelImport(modal.plan.id).catch(error => setToast({ text: error.message, error: true }));
    }
    if (modal?.type === 'game-import' || modal?.type === 'game-import-review') {
      void api!
        .cancelGameImport(modal.type === 'game-import' ? modal.plan.id : modal.review.planId)
        .catch(error => setToast({ text: error.message, error: true }));
    }
    setModal(modal && 'returnTo' in modal && modal.returnTo ? { type: modal.returnTo } : null);
  }

  function finishSelection(gameId: string, ids: string[]) {
    const done = new Set(ids);
    setViews(all => ({
      ...all,
      [gameId]: {
        ...(all[gameId] ?? defaultView),
        selectedIds: (all[gameId]?.selectedIds ?? []).filter(id => !done.has(id)),
      },
    }));
    setPointSelections(all => ({
      ...all,
      [gameId]: {
        active: (all[gameId]?.active ?? []).filter(id => !done.has(id)),
        removed: (all[gameId]?.removed ?? []).filter(id => !done.has(id)),
      },
    }));
  }

  const recoverBatch = async (gameId: string, ids: string[], returnTo?: 'restore-points') => {
    const report = await perform(t('messages.recoveringRecords'), () =>
      api.updateSnapshots(gameId, ids, { deleted: false }),
    );
    if (!report) return;
    finishSelection(gameId, report.updated);
    if (report.failed.length) setModal({ type: 'batch-report', report, returnTo });
    else setToast({ text: t('messages.recoveredBatchToast', { count: report.updated.length }) });
  };

  const confirmDelete = async (deletion: Extract<ModalState, { type: 'delete' }>) => {
    const ids = deletion.snapshots.map(snapshot => snapshot.id);
    const report = await perform(
      deletion.permanent ? t('messages.deletingPermanently') : t('messages.movingRecords'),
      () =>
        deletion.permanent
          ? api.deleteSnapshots(deletion.gameId, ids)
          : api.updateSnapshots(deletion.gameId, ids, { deleted: true }),
    );
    if (!report) return;
    finishSelection(deletion.gameId, report.updated);
    if (report.failed.length) {
      setModal({ type: 'batch-report', report, permanent: deletion.permanent, returnTo: deletion.returnTo });
    } else {
      setToast({
        text: t(deletion.permanent ? 'messages.deletedPermanentlyToast' : 'messages.movedRecordsToast', {
          count: report.updated.length,
        }),
      });
      setModal(deletion.returnTo ? { type: deletion.returnTo } : null);
    }
  };

  const batchProtect = async (selection: string[], protectedTag: boolean) => {
    const gameId = current.id;
    const report = await perform(
      t(protectedTag ? 'messages.batchProtecting' : 'messages.batchUnprotecting'),
      () => api.updateSnapshots(gameId, selection, { protected: protectedTag }),
    );
    if (!report) return;
    if (report.failed.length) {
      updateView({ selectedIds: report.failed.map(item => item.id) }, gameId);
      setModal({ type: 'batch-report', report });
    } else {
      setToast({
        text: t(protectedTag ? 'messages.batchProtectedToast' : 'messages.batchUnprotectedToast', {
          count: report.updated.length,
        }),
      });
    }
  };

  return (
    <>
      <div className={`app-shell platform-${state.platform}`} inert={modal ? true : undefined}>
        <div className="titlebar">
          <span>
            SaveHub <span className="titlebar-separator">/</span> {t('app.titlebarTagline')}
          </span>
        </div>
        <aside className="sidebar">
          <button className="brand" aria-label={t('sidebar.homeAria')} onClick={() => setPage('games')}>
            <Logo />
            <span>
              SaveHub
              <small>{t('sidebar.brandSubtitle')}</small>
            </span>
          </button>
          <div className="nav-label">
            {t('sidebar.workspace')} {t('sidebar.workspace').toUpperCase() !== 'WORKSPACE' && <span>WORKSPACE</span>}
          </div>
          <nav className="main-nav" aria-label={t('sidebar.mainNavAria')}>
            <button className={page === 'games' ? 'active' : ''} onClick={() => setPage('games')}>
              <LayoutGrid size={18} />
              <span>{t('sidebar.allGames')}</span>
            </button>
            <button className={page === 'library' ? 'active' : ''} onClick={() => setPage('library')}>
              <Library size={18} />
              <span>{t('sidebar.saveLibrary')}</span>
              <span className="nav-number">{allSnapshots.length}</span>
            </button>
          </nav>
          <div className="nav-label games-label">
            {t('sidebar.myGames')}{' '}
            <button
              title={t('sidebar.addGame')}
              aria-label={t('sidebar.addGame')}
              disabled={!!busy}
              onClick={() => setModal({ type: 'game' })}
            >
              <Plus size={16} />
            </button>
          </div>
          <nav className="game-nav" aria-label={t('sidebar.gameListAria')}>
            {games.map(game => (
              <button
                key={game.id}
                className={current?.id === game.id && page === 'library' ? 'selected' : ''}
                onClick={() => chooseGame(game.id)}
              >
                <span className="game-glyph" style={{ '--game-color': game.color } as CSSProperties}>
                  <GameGlyph icon={game.icon} />
                </span>
                <span className="game-nav-name">
                  {gameName(game)}
                  <small>{t('sidebar.gameSaveCount', { count: visibleSaves(game).length })}</small>
                </span>
                {current?.id === game.id && page === 'library' && <span className="selected-dot" />}
              </button>
            ))}
          </nav>
          <button className="add-game" disabled={!!busy} onClick={() => setModal({ type: 'game' })}>
            <Plus size={15} />
            {t('sidebar.addGameProject')}
          </button>
          <div className="sidebar-bottom">
            <div className="local-storage">
              <span className="storage-heading">
                <HardDrive size={16} />
                {t('sidebar.localVault')}
                <span className="status-dot" />
              </span>
              <strong>
                {formatBytes(storageBytes)}
                <small>{t('sidebar.stored')}</small>
              </strong>
              <div className="storage-rule" />
              <p>{t('sidebar.localVaultDesc')}</p>
              <button onClick={() => void perform(t('messages.openingVault'), () => api.openFolder('vault'))}>
                {t('sidebar.openFolder')}
                <ExternalLink size={13} />
              </button>
            </div>
            <nav className="main-nav">
              <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>
                <Settings2 size={17} />
                <span>{t('sidebar.settingsAndAbout')}</span>
              </button>
            </nav>
            <div className="sidebar-footer">
              <span className="tiny-mark">S / H</span>
              <span>{t('sidebar.footerSlogan')}</span>
            </div>
          </div>
        </aside>

        <div className="workspace">
          <header className="toolbar">
            <div className="breadcrumbs">
              <span>{t('toolbar.myWorkspace')}</span>
              <ChevronRight size={13} />
              <strong>
                {
                  {
                    library: t('toolbar.pageLibrary'),
                    games: t('toolbar.pageGames'),
                    themes: t('toolbar.pageThemes'),
                    settings: t('toolbar.pageSettings'),
                  }[page]
                }
              </strong>
            </div>
            <div className="toolbar-right">
              <span className="local-indicator">
                <span className="status-dot" />
                {t('toolbar.localMode')}
              </span>
              <span className="toolbar-divider" />
              <button
                className="language-shortcut"
                aria-label={t('toolbar.switchLanguageAria')}
                title={t('toolbar.switchLanguageTitle', { language: nextLangMeta.label })}
                disabled={!!busy}
                onClick={() => switchLanguage(nextLangMeta.code)}
              >
                <Languages size={15} />
                {currentLangMeta.shortLabel}
              </button>
              <button
                className={`theme-shortcut ${page === 'themes' ? 'is-open' : ''}`}
                aria-label={t('toolbar.switchThemeAria')}
                aria-expanded={page === 'themes'}
                title={page === 'themes' ? t('toolbar.backToPreviousPage') : t('toolbar.chooseTheme')}
                onClick={toggleThemePage}
              >
                <Paintbrush size={15} />
                {themes.find(theme => theme.id === state.theme)?.name}
                <ChevronDown size={12} />
              </button>
              <button
                className="icon-button"
                title={t('toolbar.userGuide')}
                aria-label={t('toolbar.userGuide')}
                onClick={() => setModal({ type: 'help' })}
              >
                <CircleHelp size={17} />
              </button>
            </div>
          </header>
          <main className="main-content" ref={mainRef}>
            <div className="route-content" data-page={page}>
              {page === 'library' && current && (
                <>
                  <div className="page-heading">
                    <div>
                      <div className="eyebrow">YOUR ADVENTURE, PRESERVED.</div>
                      <h1>
                        {t('library.headingTitle')}
                        <span className="heading-period">{t('library.headingPeriod')}</span>
                      </h1>
                      <p>{t('library.headingDesc')}</p>
                    </div>
                    <span className="ink-seal" aria-hidden="true">
                      存<br />心
                    </span>
                  </div>
                  <section className="game-hero" aria-label={t('library.heroAria', { name: gameName(current) })}>
                    <Landscape kind={current.icon} />
                    <div className="hero-shade" />
                    <div className="hero-content">
                      <div className="hero-kicker">
                        <span className="small-line" />
                        {t('library.activeGame')}
                      </div>
                      <div className="hero-title">
                        <GameGlyph icon={current.icon} size={30} />
                        <h2>{gameName(current)}</h2>
                      </div>
                      <p className="game-subtitle">{current.subtitle || 'MY NEXT ADVENTURE'}</p>
                      <div className="hero-status">
                        <span className={`status-dot ${current.pathStatus !== 'ready' ? 'warning' : ''}`} />
                        {current.pathStatus === 'ready'
                          ? t('library.statusReady')
                          : current.pathStatus === 'missing'
                            ? t('library.statusMissing')
                            : t('library.statusUnconfigured')}
                        <span className="hero-status-divider" />{' '}
                        {state.platform === 'darwin' ? 'macOS · Apple Silicon' : 'Windows'}
                      </div>
                      <div className="hero-actions">
                        <button className="button primary" disabled={!!busy} onClick={openSave}>
                          <Plus size={17} />
                          {current.pathStatus === 'ready'
                            ? t('library.createNewSave')
                            : t('library.configureSavePath')}
                        </button>
                        <button
                          className="button subtle"
                          disabled={!!busy}
                          onClick={() => setModal({ type: 'game', game: current })}
                        >
                          <Settings2 size={15} />
                          {t('library.gameSettings')}
                        </button>
                      </div>
                    </div>
                    <span className="hero-caption">
                      {current.icon === 'ring'
                        ? t('library.captionRing')
                        : current.icon === 'spire'
                          ? t('library.captionSpire')
                          : current.icon === 'flame'
                            ? t('library.captionFlame')
                            : t('library.captionDefault')}
                    </span>
                    <span className="hero-index">
                      {String(games.indexOf(current) + 1).padStart(2, '0')} /{' '}
                      {String(games.length).padStart(2, '0')}
                    </span>
                  </section>
                  <section className="stats-row" aria-label={t('library.statsAria')}>
                    <Stat
                      icon={<Archive size={18} />}
                      label={t('library.statTotalSaves')}
                      value={String(saves.length).padStart(2, '0')}
                      unit={t('library.statTotalSavesUnit')}
                    />
                    <Stat
                      icon={<ShieldCheck size={18} />}
                      label={t('library.statRestoreSafety')}
                      value={t('library.statRestoreSafetyValue')}
                      detail={t('library.statRestoreSafetyDetail')}
                    />
                    <Stat
                      icon={<HardDrive size={18} />}
                      label={t('library.statStorage')}
                      value={formatBytes(saves.reduce((sum, snapshot) => sum + snapshot.bytes, 0))}
                      detail={t('library.statStorageDetail', { count: totalFiles })}
                    />
                    <Stat
                      icon={<Clock3 size={18} />}
                      label={t('library.statLatestSave')}
                      value={saves[0] ? dateLabel(saves[0].createdAt) : t('library.statLatestSaveEmpty')}
                      detail={saves[0] ? kindLabel(saves[0].kind) : t('library.statLatestSaveEmptyDetail')}
                    />
                  </section>
                  <SnapshotList
                    game={current}
                    view={view}
                    busy={!!busy}
                    menu={menu}
                    onMenu={setMenu}
                    onViewChange={updateView}
                    onAction={snapshotAction}
                    onImport={runImport}
                    onFolder={() =>
                      void perform(t('messages.openingBackupFolder'), () => api.openFolder('snapshots', current.id))
                    }
                    onCreate={openSave}
                    onRestorePoints={() => setModal({ type: 'restore-points' })}
                    onExport={selection => void exportBatch(selection)}
                    onDelete={snapshots => requestDelete(snapshots)}
                    onRecover={ids => void recoverBatch(current.id, ids)}
                    onProtect={(selection, protectedTag) => void batchProtect(selection, protectedTag)}
                  />
                  <footer className="page-footer">
                    <span>SAVE YOUR PROGRESS. KEEP YOUR STORIES.</span>
                    <span>{t('library.footerQuote')}</span>
                  </footer>
                </>
              )}
              {page === 'library' && !current && (
                <div className="empty-library">
                  <Landscape />
                  <div>
                    <Gamepad2 size={40} />
                    <h1>{t('library.emptyLibraryTitle')}</h1>
                    <p>{t('library.emptyLibraryDesc')}</p>
                    <button className="button primary" onClick={() => setModal({ type: 'game' })}>
                      <Plus size={17} />
                      {t('sidebar.addGame')}
                    </button>
                  </div>
                </div>
              )}

              {page === 'games' && (
                <AllGames
                  view={gamesView}
                  onViewChange={changes => {
                    const update = () => setGamesView(previous => ({ ...previous, ...changes }));
                    if (changes.layout) void animate(update);
                    else update();
                  }}
                  games={state.games}
                  platform={state.platform}
                  busy={!!busy}
                  onAdd={() => setModal({ type: 'game' })}
                  onImport={() => void runGameImport()}
                  onExport={selectedGames => setModal({ type: 'export-games', games: selectedGames })}
                  onEdit={game => setModal({ type: 'game', game })}
                  onDelete={game => setModal({ type: 'remove-game', game })}
                  onOpen={chooseGame}
                  onRecover={game =>
                    void perform(
                      t('messages.restoringGameProject'),
                      () => api.removeGame(game.id, true),
                      t('messages.restoredGameToast'),
                    )
                  }
                />
              )}

              {page === 'themes' && (
                <>
                  <PageHeading
                    eyebrow="A DIFFERENT WAY TO FEEL."
                    title={t('themes.headingTitle')}
                    description={t('themes.headingDesc')}
                  />
                  <div className="theme-grid">
                    {themes.map(theme => (
                      <button
                        key={theme.id}
                        className={`theme-card ${state.theme === theme.id ? 'chosen' : ''}`}
                        disabled={!!busy}
                        onClick={() => void perform(t('messages.switchingTheme'), () => api.setTheme(theme.id))}
                        aria-label={t('themes.switchThemeAria', { name: theme.name })}
                        aria-pressed={state.theme === theme.id}
                      >
                        <div className={`theme-preview preview-${theme.id}`}>
                          <div className="mini-sidebar">
                            <i />
                            <i />
                            <i />
                            <i />
                          </div>
                          <div className="mini-workspace">
                            <div className="mini-title" />
                            <div className="mini-hero">
                              <span>{theme.caption}</span>
                              <div className="mini-moon" />
                            </div>
                            <div className="mini-stats">
                              <i />
                              <i />
                              <i />
                            </div>
                            <div className="mini-row" />
                            <div className="mini-row" />
                          </div>
                          <span className="preview-label">{theme.english}</span>
                        </div>
                        <div className="theme-card-copy">
                          <div>
                            <h2>{theme.name}</h2>
                            <span>{theme.english}</span>
                          </div>
                          <span className={`theme-check ${state.theme === theme.id ? 'checked' : ''}`}>
                            {state.theme === theme.id && <Check size={14} />}
                          </span>
                          <p>{theme.description}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                  <div className="theme-note">
                    <Sparkles size={19} />
                    <div>
                      <strong>{t('themes.noteTitle')}</strong>
                      <p>{t('themes.noteDesc')}</p>
                    </div>
                    <span>
                      {themes.find(theme => theme.id === state.theme)?.name} · {t('themes.activeStatus')}
                    </span>
                  </div>
                </>
              )}

              {page === 'settings' && (
                <>
                  <PageHeading
                    eyebrow="YOUR SAVES. YOUR DEVICE."
                    title={t('settings.headingTitle')}
                    description={t('settings.headingDesc')}
                  />
                  <section className="settings-card">
                    <h2>
                      <Languages size={20} />
                      {t('settings.languageTitle')}
                    </h2>
                    <p>{t('settings.languageDesc')}</p>
                    <div className="language-options" role="group" aria-label={t('settings.languageGroupAria')}>
                      {SUPPORTED_LANGUAGES.map(item => (
                        <button
                          key={item.code}
                          type="button"
                          className={`button ${language === item.code ? 'primary' : 'secondary'} small`}
                          aria-pressed={language === item.code}
                          disabled={!!busy}
                          onClick={() => switchLanguage(item.code)}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </section>
                  <section className="settings-card">
                    <h2>
                      <HardDrive size={20} />
                      {t('settings.vaultTitle')}
                    </h2>
                    <p>{t('settings.vaultDesc')}</p>
                    <div className="path-display">
                      <Folder size={17} />
                      <code>{state.dataDir}</code>
                      <button
                        className="icon-button"
                        title={t('settings.openVault')}
                        onClick={() => void perform(t('messages.openingVault'), () => api.openFolder('vault'))}
                      >
                        <ExternalLink size={16} />
                      </button>
                    </div>
                    <div className="settings-metrics">
                      <span>{t('settings.metricGames', { count: state.games.length })}</span>
                      <span>{t('settings.metricStorage', { size: formatBytes(storageBytes) })}</span>
                      <span>{state.platform === 'darwin' ? 'macOS / Apple Silicon' : 'Windows'}</span>
                    </div>
                  </section>
                  <section className="settings-card">
                    <h2>
                      <ShieldCheck size={20} />
                      {t('settings.safetyTitle')}
                    </h2>
                    <div className="protection-grid">
                      <div>
                        <CheckCheck size={22} />
                        <strong>{t('settings.safetyIntegrityTitle')}</strong>
                        <p>{t('settings.safetyIntegrityDesc')}</p>
                      </div>
                      <div>
                        <History size={22} />
                        <strong>{t('settings.safetyAutoBackupTitle')}</strong>
                        <p>{t('settings.safetyAutoBackupDesc')}</p>
                      </div>
                      <div>
                        <RotateCcw size={22} />
                        <strong>{t('settings.safetyRollbackTitle')}</strong>
                        <p>{t('settings.safetyRollbackDesc')}</p>
                      </div>
                    </div>
                  </section>
                  <section className="settings-card">
                    <h2>
                      <Trash2 size={20} />
                      {t('settings.removedGamesTitle')}
                    </h2>
                    <p>{t('settings.removedGamesDesc')}</p>
                    {state.games.filter(game => game.deletedAt).length ? (
                      state.games
                        .filter(game => game.deletedAt)
                        .map(game => (
                          <div className="removed-game" key={game.id}>
                            <GameGlyph icon={game.icon} />
                            <strong>{gameName(game)}</strong>
                            <span>{t('sidebar.gameSaveCount', { count: game.snapshots.length })}</span>
                            <button
                              className="button secondary small"
                              disabled={!!busy || game.purgeGamePending || game.purgeSnapshotsPending}
                              onClick={() =>
                                void perform(
                                  t('messages.restoringGameProject'),
                                  () => api.removeGame(game.id, true),
                                  t('messages.restoredGameToast'),
                                )
                              }
                            >
                              <RotateCcw size={14} />
                              {t('settings.restoreGameProject')}
                            </button>
                          </div>
                        ))
                    ) : (
                      <div className="quiet-empty">{t('settings.noRemovedGames')}</div>
                    )}
                  </section>
                  <div className="about-line">
                    <Logo small />
                    <strong>SaveHub</strong>
                    <span>v{state.version}</span>
                    <span>Electron · Windows & macOS</span>
                    <button className="text-button" onClick={() => setModal({ type: 'help' })}>
                      {t('toolbar.userGuide')}
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </>
              )}
            </div>
          </main>
        </div>
      </div>

      {modal && (
        <Modal
          title={modalTitle(modal)}
          onClose={closeModal}
          busy={!!busy}
          wide={
            modal.type === 'game' ||
            modal.type === 'restore-points' ||
            modal.type === 'import-conflicts' ||
            modal.type === 'import-report' ||
            modal.type === 'game-import' ||
            modal.type === 'game-import-review' ||
            modal.type === 'game-import-report'
          }
        >
          {modal.type === 'game' && (
            <GameForm
              game={modal.game}
              platform={state.platform}
              api={api}
              busy={!!busy}
              onCancel={() => setModal(null)}
              onSave={async values => {
                const id = await perform(
                  t('messages.savingGameSettings'),
                  () => api.saveGame(values),
                  t('messages.savedGameSettingsToast'),
                  true,
                );
                if (id && page !== 'games') chooseGame(id);
              }}
              onDelete={modal.game ? () => setModal({ type: 'remove-game', game: modal.game! }) : undefined}
            />
          )}
          {modal.type === 'save' && current && (
            <SnapshotForm
              snapshot={modal.snapshot}
              busy={!!busy}
              onCancel={() => setModal(null)}
              onSave={values =>
                perform(
                  t(modal.snapshot ? 'messages.savingSnapshotInfo' : 'messages.creatingSnapshot'),
                  async () => {
                    if (modal.snapshot) await api.updateSnapshot(current.id, modal.snapshot.id, values);
                    else await api.saveSnapshot(current.id, values);
                  },
                  t(modal.snapshot ? 'messages.updatedSnapshotToast' : 'messages.createdSnapshotToast'),
                  true,
                )
              }
            />
          )}
          {modal.type === 'restore' && current && (
            <RestoreConfirm
              snapshot={modal.snapshot}
              game={current}
              platform={state.platform}
              busy={!!busy}
              onCancel={() => setModal(null)}
              onConfirm={() =>
                perform(
                  t('messages.restoringSnapshot'),
                  () => api.restoreSnapshot(current.id, modal.snapshot.id),
                  t('messages.restoredSnapshotToast', { label: modal.snapshot.label }),
                  true,
                )
              }
            />
          )}
          {modal.type === 'delete' && (
            <DeleteConfirmation
              snapshots={modal.snapshots}
              permanent={modal.permanent}
              busy={!!busy}
              onCancel={closeModal}
              onConfirm={() => void confirmDelete(modal)}
            />
          )}
          {modal.type === 'batch-report' && (
            <>
              <p className="dialog-description">
                {t('modals.batchReport.summary', {
                  updated: modal.report.updated.length,
                  failed: modal.report.failed.length,
                })}
              </p>
              <p className="muted">
                {t(modal.permanent ? 'modals.batchReport.permanentDesc' : 'modals.batchReport.softDesc')}
              </p>
              {modal.report.failed.map(item => (
                <div className="notice error" key={item.id}>
                  <strong>{item.label}</strong>
                  <p>{item.error}</p>
                </div>
              ))}
              <div className="dialog-actions">
                <button className="button secondary" onClick={closeModal}>
                  {t('modals.closeBtn')}
                </button>
              </div>
            </>
          )}
          {modal.type === 'restore-points' && current && (
            <>
              <RestorePoints
                points={current.restorePoints}
                selection={pointSelections[current.id] ?? { active: [], removed: [] }}
                busy={!!busy}
                canRestore={current.pathStatus === 'ready'}
                onSelect={(group, ids) =>
                  setPointSelections(all => ({
                    ...all,
                    [current.id]: { ...(all[current.id] ?? { active: [], removed: [] }), [group]: ids },
                  }))
                }
                onRestore={snapshot => setModal({ type: 'restore', snapshot })}
                onExport={snapshot => snapshotAction('export', snapshot)}
                onDelete={snapshots => requestDelete(snapshots, 'restore-points')}
                onRecover={ids => void recoverBatch(current.id, ids, 'restore-points')}
              />
              <div className="dialog-actions">
                <button className="button secondary" onClick={() => setModal(null)}>
                  {t('modals.closeBtn')}
                </button>
              </div>
            </>
          )}
          {modal.type === 'remove-game' && (
            <GameDeleteConfirmation
              key={modal.game.id}
              game={modal.game}
              busy={!!busy}
              onCancel={closeModal}
              onConfirm={deleteRecords =>
                void perform(
                  t('games.deleting'),
                  () => api.removeGame(modal.game.id, false, deleteRecords),
                  t(deleteRecords ? 'games.purgeSuccess' : 'games.deleteSuccess'),
                  true,
                )
              }
            />
          )}
          {modal.type === 'export-games' && (
            <GameExportConfirmation
              games={modal.games}
              busy={!!busy}
              onCancel={closeModal}
              onConfirm={includeSnapshots =>
                void perform(t('games.exporting'), async () => {
                  const result = await api.exportGames(
                    modal.games.map(game => game.id),
                    includeSnapshots,
                  );
                  if (result) {
                    setToast({
                      text: t('games.exportSuccess', {
                        count: result.count,
                        saves: result.snapshotCount,
                        folder: result.folder,
                      }),
                    });
                    setModal(null);
                  }
                })
              }
            />
          )}
          {modal.type === 'game-import' && (
            <GameImportChoices
              key={modal.plan.id}
              plan={modal.plan}
              busy={!!busy}
              onCancel={closeModal}
              onConfirm={decisions => void reviewGames(modal.plan.id, decisions)}
            />
          )}
          {modal.type === 'game-import-review' && (
            <GameImportReviewDialog
              key={modal.review.id}
              review={modal.review}
              busy={!!busy}
              onCancel={closeModal}
              onConfirm={decisions => void importGames(modal.review.id, decisions)}
            />
          )}
          {modal.type === 'game-import-report' && <GameImportResults report={modal.report} onClose={closeModal} />}
          {modal.type === 'detail' && (
            <>
              <div className="detail-name">
                <Archive size={23} />
                <h3>{modal.snapshot.label}</h3>
              </div>
              <p className="detail-note">{modal.snapshot.note || t('modals.detail.emptyNote')}</p>
              <dl className="details-grid">
                <dt>{t('modals.detail.createdAt')}</dt>
                <dd>{fullDate(modal.snapshot.createdAt)}</dd>
                <dt>{t('modals.detail.source')}</dt>
                <dd>{kindLabel(modal.snapshot.kind)}</dd>
                <dt>{t('modals.detail.flags')}</dt>
                <dd>
                  {[
                    modal.snapshot.favorite && t('modals.detail.flagFavorite'),
                    modal.snapshot.protected && t('modals.detail.flagProtected'),
                    modal.snapshot.deletedAt && t('modals.detail.flagTrash'),
                  ]
                    .filter(Boolean)
                    .join(t('modals.detail.flagSeparator')) || t('modals.detail.flagNone')}
                </dd>
                <dt>{t('modals.detail.fileCount')}</dt>
                <dd>
                  {t('modals.detail.fileCountValue', {
                    count: modal.snapshot.fileCount,
                    size: formatBytes(modal.snapshot.bytes),
                  })}
                </dd>
                <dt>{t('modals.detail.platform')}</dt>
                <dd>{modal.snapshot.platform === 'darwin' ? 'macOS' : 'Windows'}</dd>
                <dt>{t('modals.detail.backupItems')}</dt>
                <dd>
                  {modal.snapshot.entries.map(entry => (
                    <code key={entry}>{entry}</code>
                  ))}
                </dd>
                <dt>{t('modals.detail.snapshotId')}</dt>
                <dd className="mono small-text">{modal.snapshot.id}</dd>
              </dl>
              {modal.snapshot.absent?.length > 0 && (
                <div className="notice">
                  {t('modals.detail.absentNotice', {
                    paths: modal.snapshot.absent.join(t('modals.detail.flagSeparator')),
                  })}
                </div>
              )}
              {modal.snapshot.corrupted && <div className="notice error">{modal.snapshot.error}</div>}
              <div className="dialog-actions">
                <button className="button secondary" onClick={() => setModal(null)}>
                  {t('modals.closeBtn')}
                </button>
              </div>
            </>
          )}
          {modal.type === 'import-conflicts' && (
            <ImportConflicts
              key={modal.plan.id}
              plan={modal.plan}
              busy={!!busy}
              onCancel={closeModal}
              onConfirm={decisions => void executeImport(modal.plan, decisions)}
            />
          )}
          {modal.type === 'import-report' && <ImportResult report={modal.report} onClose={() => setModal(null)} />}
          {modal.type === 'help' && (
            <>
              <div className="help-intro">
                <Logo />
                <p>{t('modals.help.intro')}</p>
              </div>
              <ol className="help-steps">
                <li>
                  <strong>{t('modals.help.step1Title')}</strong>
                  <p>{t('modals.help.step1Desc')}</p>
                </li>
                <li>
                  <strong>{t('modals.help.step2Title')}</strong>
                  <p>{t('modals.help.step2Desc')}</p>
                </li>
                <li>
                  <strong>{t('modals.help.step3Title')}</strong>
                  <p>{t('modals.help.step3Desc')}</p>
                </li>
                <li>
                  <strong>{t('modals.help.step4Title')}</strong>
                  <p>{t('modals.help.step4Desc')}</p>
                </li>
              </ol>
              <div className="notice">
                <Monitor size={17} />
                <span>{t('modals.help.platformNotice')}</span>
              </div>
              <div className="dialog-actions">
                <button className="button primary" onClick={() => setModal(null)}>
                  {t('modals.help.startBtn')}
                  <ArrowRight size={15} />
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      {busy && (
        <div className="progress-panel" role="status">
          <LoaderCircle size={21} className="spin" />
          <div>
            <strong>{busy}</strong>
            <p>{progress?.detail || t('app.preparingProgress')}</p>
          </div>
          {progress?.total ? (
            <span>
              {progress.completed} / {progress.total}
            </span>
          ) : null}
          <div className="progress-bar">
            <i
              style={{
                width: progress?.total ? `${Math.max(3, (100 * progress.completed) / progress.total)}%` : '35%',
              }}
            />
          </div>
        </div>
      )}
      {toast && (
        <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}>
          {toast.error ? <Info size={19} /> : <Check size={19} />}
          <span>{toast.text}</span>
          <button aria-label={t('app.closeNotification')} onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}

function Stat({
  icon,
  label,
  value,
  unit,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  unit?: string;
  detail?: string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        {icon}
        {label}
      </div>
      <div className="stat-value">
        {value}
        {unit && <span>{unit}</span>}
      </div>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <div className="page-heading standalone">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}

function modalTitle(modal: ModalState) {
  return {
    game: modal.type === 'game' && modal.game ? t('modals.titles.gameSettings') : t('modals.titles.addGame'),
    save: modal.type === 'save' && modal.snapshot ? t('modals.titles.editSave') : t('modals.titles.createSave'),
    restore: t('modals.titles.restore'),
    delete:
      modal.type === 'delete' && modal.permanent
        ? t('modals.titles.deletePermanent')
        : t('modals.titles.deleteSoft'),
    'remove-game': t('games.deleteTitle'),
    'export-games': t('games.exportTitle'),
    'game-import': t('games.importTitle'),
    'game-import-review': t('games.reviewTitle'),
    'game-import-report': t('games.resultTitle'),
    detail: t('modals.titles.detail'),
    'restore-points': t('modals.titles.restorePoints'),
    'batch-report': t('modals.titles.batchReport'),
    'import-conflicts': t('modals.titles.importConflicts'),
    'import-report': t('modals.titles.importReport'),
    help: t('modals.titles.help'),
  }[modal.type];
}
