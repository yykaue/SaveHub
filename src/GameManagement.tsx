import { useState } from 'react';
import { Check, Download, FolderOpen, Gamepad2, Plus, RotateCcw, Search, Settings2, Trash2, Upload } from 'lucide-react';
import { GameGlyph } from './art';
import { formatBytes, gameName } from './format';
import { t } from './i18n';
import { ImportConflicts, ImportResult } from './ImportDialog';
import type { Game, GameImportItem, GameImportPlan, GameImportReport, GameImportReview, GameSnapshotDecision, ImportAction, ImportDecision, Platform } from './types';

export function GameManagement({ games, platform, busy, onAdd, onImport, onExport, onEdit, onDelete, onOpen, onRecover }: {
  games: Game[]; platform: Platform; busy: boolean; onAdd: () => void; onImport: () => void; onExport: (games: Game[]) => void;
  onEdit: (game: Game) => void; onDelete: (game: Game) => void; onOpen: (id: string) => void; onRecover: (game: Game) => void;
}) {
  const [query, setQuery] = useState(''), [removed, setRemoved] = useState(false), [selected, setSelected] = useState<string[]>([]);
  const active = games.filter(game => !game.deletedAt);
  const shown = games.filter(game => Boolean(game.deletedAt) === removed && `${gameName(game)} ${game.subtitle}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  const selection = active.filter(game => selected.includes(game.id));
  const toggle = (id: string) => setSelected(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
  return <div className="game-management">
    <div className="page-heading standalone"><div className="eyebrow">EVERY WORLD, IN YOUR HANDS.</div><h1>{t('gameManagement.title')}</h1><p>{t('gameManagement.description')}</p></div>
    <div className="management-actions"><button className="button primary" disabled={busy} onClick={onAdd}><Plus size={16}/>{t('gameManagement.add')}</button><button className="button secondary" disabled={busy} onClick={onImport}><Upload size={16}/>{t('gameManagement.import')}</button><button className="button secondary" disabled={busy || !active.length} onClick={() => onExport(selection.length ? selection : active)}><Download size={16}/>{t(selection.length ? 'gameManagement.exportSelected' : 'gameManagement.exportAll')}</button><span>{t(selection.length ? 'gameManagement.selected' : 'gameManagement.count', { count: selection.length || active.length })}</span></div>
    <div className="management-filters"><div className="management-tabs" role="group" aria-label={t('gameManagement.title')}><button aria-pressed={!removed} onClick={() => setRemoved(false)}>{t('gameManagement.active')} <span>{active.length}</span></button><button aria-pressed={removed} onClick={() => setRemoved(true)}>{t('gameManagement.removed')} <span>{games.length - active.length}</span></button></div><label className="management-search"><Search size={16}/><input aria-label={t('gameManagement.search')} placeholder={t('gameManagement.search')} value={query} onChange={event => setQuery(event.target.value)}/></label></div>
    <p className="muted small-text management-hint">{t('gameManagement.recordHint')}</p>
    {!removed && shown.length > 0 && <label className="confirm-checkbox management-select-all"><input type="checkbox" disabled={busy} checked={shown.every(game => selected.includes(game.id))} onChange={event => setSelected(ids => event.target.checked ? [...new Set([...ids, ...shown.map(game => game.id)])] : ids.filter(id => !shown.some(game => game.id === id)))}/>{t('gameManagement.selectAll')}</label>}
    <div className="management-list">{shown.map(game => {
      const records = [...game.snapshots, ...game.restorePoints];
      return <article className="management-game" key={game.id} data-game-id={game.id}>
        {!removed && <input type="checkbox" aria-label={t('gameManagement.select', { name: gameName(game) })} checked={selected.includes(game.id)} disabled={busy} onChange={() => toggle(game.id)}/>}
        <span className="game-glyph" style={{ '--game-color': game.color } as React.CSSProperties}><GameGlyph icon={game.icon} size={24}/></span>
        <div className="management-game-info"><h2>{gameName(game)}</h2><p>{game.subtitle || 'YOUR OWN WORLD'}</p><code title={game.locations[platform].root}>{game.locations[platform].root || t('gameManagement.missingPath')}</code><small>{t('gameManagement.records', { count: records.length, size: formatBytes(records.reduce((total, save) => total + save.bytes, 0)) })}</small>{game.purgeSnapshotsPending && <strong className="danger-text">{t('gameManagement.pending')}</strong>}</div>
        <div className="management-game-actions">{removed ? <button className="button secondary small" disabled={busy} onClick={() => game.purgeSnapshotsPending ? onDelete(game) : onRecover(game)}><RotateCcw size={14}/>{t(game.purgeSnapshotsPending ? 'gameManagement.retry' : 'gameManagement.restore')}</button> : <><button className="button secondary small" disabled={busy} onClick={() => onOpen(game.id)}><FolderOpen size={14}/>{t('gameManagement.open')}</button><button className="icon-button" aria-label={t('gameManagement.edit', { name: gameName(game) })} title={t('gameManagement.edit', { name: gameName(game) })} disabled={busy} onClick={() => onEdit(game)}><Settings2 size={17}/></button><button className="icon-button" aria-label={t('gameManagement.exportOne', { name: gameName(game) })} title={t('gameManagement.export')} disabled={busy} onClick={() => onExport([game])}><Download size={17}/></button><button className="icon-button danger-text" aria-label={t('gameManagement.delete', { name: gameName(game) })} title={t('gameManagement.deleteTitle')} disabled={busy} onClick={() => onDelete(game)}><Trash2 size={17}/></button></>}</div>
      </article>;
    })}</div>
    {!shown.length && <div className="quiet-empty">{t('gameManagement.empty')}</div>}
  </div>;
}

export function GameDeleteConfirmation({ game, busy, onCancel, onConfirm }: { game: Game; busy: boolean; onCancel: () => void; onConfirm: (deleteRecords: boolean) => void }) {
  const [deleteRecords, setDeleteRecords] = useState(Boolean(game.purgeSnapshotsPending));
  return <><div className="dialog-symbol"><Gamepad2 size={26}/></div><p className="dialog-description">{t('gameManagement.deleteQuestion', { name: gameName(game) })}</p><p className="muted">{t('gameManagement.deleteDesc')}</p>
    <label className="confirm-checkbox"><input type="checkbox" checked={deleteRecords} disabled={busy || game.purgeSnapshotsPending} onChange={event => setDeleteRecords(event.target.checked)}/><span>{t('gameManagement.deleteCheckbox')}</span></label>
    {deleteRecords && <div className="notice permanent-delete-warning" role="note"><Trash2 size={20}/><p>{t('gameManagement.deleteWarning', { count: game.snapshots.length + game.restorePoints.length })}</p></div>}
    <div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={onCancel}>{t('modals.cancelBtn')}</button><button className="button danger" disabled={busy} onClick={() => onConfirm(deleteRecords)}>{t(deleteRecords ? 'gameManagement.deleteWithSaves' : 'gameManagement.deleteConfirm')}</button></div></>;
}

export function GameExportConfirmation({ games, busy, onCancel, onConfirm }: { games: Game[]; busy: boolean; onCancel: () => void; onConfirm: (includeSnapshots: boolean) => void }) {
  const [includeSnapshots, setIncludeSnapshots] = useState(false);
  return <><p className="dialog-description">{t('gameManagement.exportDesc', { count: games.length })}</p><ul className="batch-confirm-list">{games.map(game => <li key={game.id}>{gameName(game)}</li>)}</ul>
    <label className="confirm-checkbox"><input type="checkbox" checked={includeSnapshots} disabled={busy} onChange={event => setIncludeSnapshots(event.target.checked)}/><span>{t('gameManagement.exportCheckbox')}</span></label><p className="muted small-text management-hint">{t('gameManagement.exportHint')}</p>
    <div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={onCancel}>{t('modals.cancelBtn')}</button><button className="button primary" disabled={busy} onClick={() => onConfirm(includeSnapshots)}><Download size={16}/>{t('gameManagement.export')}</button></div></>;
}

export function GameImportChoices({ plan, busy, onCancel, onConfirm }: { plan: GameImportPlan; busy: boolean; onCancel: () => void; onConfirm: (decisions: ImportDecision[]) => void }) {
  const duplicates = plan.items.filter(item => item.matches.length);
  const [choices, setChoices] = useState<Record<string, ImportDecision>>(() => Object.fromEntries(duplicates.map(item => [item.id, { itemId: item.id, action: 'skip', targetId: item.matches.find(game => !game.purgeSnapshotsPending)?.id || item.matches[0].id }])));
  const actions: ImportAction[] = ['overwrite', 'skip', 'keep-both'];
  const setAction = (item: GameImportItem, action: ImportAction) => setChoices(all => ({ ...all, [item.id]: { ...all[item.id], action } }));
  return <form className="game-import-choices" onSubmit={event => { event.preventDefault(); if (!busy) onConfirm(duplicates.map(item => choices[item.id])); }}><fieldset disabled={busy}>
    <p className="dialog-description">{t('gameManagement.importIntro', { count: plan.items.length, duplicates: duplicates.length })}</p><p className="muted small-text">{t('gameManagement.importRules')}</p>
    {duplicates.length > 0 && <div className="import-bulk"><span>{t('import.bulkLabel')}</span>{actions.map(action => <button key={action} type="button" className="button secondary" disabled={action === 'overwrite' && duplicates.some(item => !item.matches.some(game => !game.purgeSnapshotsPending))} onClick={() => setChoices(all => Object.fromEntries(duplicates.map(item => [item.id, { ...all[item.id], action, targetId: item.matches.find(game => !game.purgeSnapshotsPending)?.id || all[item.id].targetId }])))}>{t(action === 'overwrite' ? 'import.bulkOverwriteAll' : action === 'skip' ? 'import.bulkSkipAll' : 'import.bulkKeepBothAll')}</button>)}</div>}
    <div className="game-import-list">{plan.items.map(item => <section className="import-conflict" key={item.id} aria-label={t('gameManagement.duplicate', { name: item.game.name })}><h3>{item.game.name}</h3><small>{t(item.includesSnapshots ? 'gameManagement.withSaves' : 'gameManagement.configOnly')}</small><p className="import-source" title={item.source}>{item.source}</p>{item.matches.length > 0 && <>
      <label className="import-target">{t('import.matchingExistingLabel', { count: item.matches.length })}<select aria-label={t('gameManagement.target', { name: item.game.name })} value={choices[item.id].targetId} onChange={event => setChoices(all => ({ ...all, [item.id]: { ...all[item.id], targetId: event.target.value, action: 'skip' } }))}>{item.matches.map(game => <option value={game.id} key={game.id}>{game.name}{game.deletedAt ? t('gameManagement.removedTag') : ''}{game.purgeSnapshotsPending ? ` · ${t('gameManagement.pending')}` : ''}</option>)}</select></label>
      <fieldset className="import-options" aria-label={t('import.itemActionAria', { name: item.game.name })}>{actions.map(action => <label key={action} className={choices[item.id].action === action ? 'selected' : ''}><input type="radio" name={`game-import-${item.id}`} checked={choices[item.id].action === action} disabled={action === 'overwrite' && item.matches.find(game => game.id === choices[item.id].targetId)?.purgeSnapshotsPending} onChange={() => setAction(item, action)}/>{t(action === 'overwrite' ? 'import.actionOverwrite' : action === 'skip' ? 'import.actionSkip' : 'import.actionKeepBoth')}</label>)}</fieldset></>}</section>)}</div>
    {plan.failed.map((item, index) => <div className="notice error" key={index}><strong>{item.name}</strong><p>{item.error}</p></div>)}
    <div className="dialog-actions"><button type="button" className="button secondary" onClick={onCancel}>{t('modals.cancelBtn')}</button><button type="submit" className="button primary" disabled={!plan.items.length}><Check size={15}/>{t('gameManagement.next')}</button></div>
  </fieldset></form>;
}

export function GameImportReviewDialog({ review, busy, onCancel, onConfirm }: { review: GameImportReview; busy: boolean; onCancel: () => void; onConfirm: (decisions: GameSnapshotDecision[]) => void }) {
  const items = review.games.flatMap(game => (game.snapshots?.items || []).map(item => ({ ...item, name: `${game.name} / ${item.name}` })));
  const actionLabel = (action: string) => t(action === 'overwrite' ? 'import.actionOverwrite' : action === 'keep-both' ? 'import.actionKeepBoth' : action === 'skip' ? 'import.actionSkip' : 'import.resultImported');
  return <ImportConflicts plan={{ id: review.id, gameId: '', directory: '', items, failed: review.failed }} busy={busy} onCancel={onCancel} confirmLabel={t('gameManagement.execute')}
    intro={<><p className="dialog-description">{t('gameManagement.reviewIntro', { games: review.games.filter(game => game.action !== 'skip').length, saves: items.length, duplicates: items.filter(item => item.matches.length).length })}</p><p className="muted small-text">{t('gameManagement.reviewHint')}</p><div className="game-review-summary">{review.games.map(game => <span key={game.itemId}>{game.name} · {actionLabel(game.action)}</span>)}</div></>}
    onConfirm={decisions => onConfirm(review.games.filter(game => game.snapshots).map(game => ({ itemId: game.itemId, decisions: decisions.filter(choice => game.snapshots!.items.some(item => item.id === choice.itemId)) })))}/>;
}

export function GameImportResults({ report, onClose }: { report: GameImportReport; onClose: () => void }) {
  return <div className="game-import-results"><h3>{t('gameManagement.gameResults')}</h3><ImportResult report={report.games} description={t('gameManagement.resultDesc')}/>{report.snapshots.map((item, index) => <section key={index}><h3>{t('gameManagement.snapshotResults', { name: item.gameName })}</h3><ImportResult report={item.report} description=""/></section>)}<div className="dialog-actions"><button className="button primary" onClick={onClose}>{t('import.doneBtn')}</button></div></div>;
}
