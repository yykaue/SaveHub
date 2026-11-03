import { useState } from 'react';
import { Check, Download, Gamepad2, Trash2 } from 'lucide-react';
import { gameName } from './format';
import { t } from './i18n';
import { ImportConflicts, ImportResult } from './ImportDialog';
import type { Game, GameImportItem, GameImportPlan, GameImportReport, GameImportReview, GameSnapshotDecision, ImportAction, ImportDecision } from './types';

export function GameDeleteConfirmation({ game, busy, onCancel, onConfirm }: { game: Game; busy: boolean; onCancel: () => void; onConfirm: (deleteRecords: boolean) => void }) {
  const [deleteRecords, setDeleteRecords] = useState(Boolean(game.purgeGamePending || game.purgeSnapshotsPending));
  return <><div className="dialog-symbol"><Gamepad2 size={26}/></div><p className="dialog-description">{t('gameManagement.deleteQuestion', { name: gameName(game) })}</p><p className="muted">{t('gameManagement.deleteDesc')}</p>
    <label className="confirm-checkbox"><input type="checkbox" checked={deleteRecords} disabled={busy || (game.purgeGamePending || game.purgeSnapshotsPending)} onChange={event => setDeleteRecords(event.target.checked)}/><span>{t('gameManagement.deleteCheckbox')}</span></label>
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
  const [choices, setChoices] = useState<Record<string, ImportDecision>>(() => Object.fromEntries(duplicates.map(item => [item.id, { itemId: item.id, action: 'skip', targetId: item.matches.find(game => !(game.purgeGamePending || game.purgeSnapshotsPending))?.id || item.matches[0].id }])));
  const actions: ImportAction[] = ['overwrite', 'skip', 'keep-both'];
  const setAction = (item: GameImportItem, action: ImportAction) => setChoices(all => ({ ...all, [item.id]: { ...all[item.id], action } }));
  return <form className="game-import-choices" onSubmit={event => { event.preventDefault(); if (!busy) onConfirm(duplicates.map(item => choices[item.id])); }}><fieldset disabled={busy}>
    <p className="dialog-description">{t('gameManagement.importIntro', { count: plan.items.length, duplicates: duplicates.length })}</p><p className="muted small-text">{t('gameManagement.importRules')}</p>
    {duplicates.length > 0 && <div className="import-bulk"><span>{t('import.bulkLabel')}</span>{actions.map(action => <button key={action} type="button" className="button secondary" disabled={action === 'overwrite' && duplicates.some(item => !item.matches.some(game => !(game.purgeGamePending || game.purgeSnapshotsPending)))} onClick={() => setChoices(all => Object.fromEntries(duplicates.map(item => [item.id, { ...all[item.id], action, targetId: item.matches.find(game => !(game.purgeGamePending || game.purgeSnapshotsPending))?.id || all[item.id].targetId }])))}>{t(action === 'overwrite' ? 'import.bulkOverwriteAll' : action === 'skip' ? 'import.bulkSkipAll' : 'import.bulkKeepBothAll')}</button>)}</div>}
    <div className="game-import-list">{plan.items.map(item => <section className="import-conflict" key={item.id} aria-label={t('gameManagement.duplicate', { name: item.game.name })}><h3>{item.game.name}</h3><small>{t(item.includesSnapshots ? 'gameManagement.withSaves' : 'gameManagement.configOnly')}</small><p className="import-source" title={item.source}>{item.source}</p>{item.matches.length > 0 && <>
      <label className="import-target">{t('import.matchingExistingLabel', { count: item.matches.length })}<select aria-label={t('gameManagement.target', { name: item.game.name })} value={choices[item.id].targetId} onChange={event => setChoices(all => ({ ...all, [item.id]: { ...all[item.id], targetId: event.target.value, action: 'skip' } }))}>{item.matches.map(game => <option value={game.id} key={game.id}>{game.name}{game.deletedAt ? t('gameManagement.removedTag') : ''}{(game.purgeGamePending || game.purgeSnapshotsPending) ? ` · ${t('gameManagement.pending')}` : ''}</option>)}</select></label>
      <fieldset className="import-options" aria-label={t('import.itemActionAria', { name: item.game.name })}>{actions.map(action => <label key={action} className={choices[item.id].action === action ? 'selected' : ''}><input type="radio" name={`game-import-${item.id}`} checked={choices[item.id].action === action} disabled={action === 'overwrite' && item.matches.some(game => game.id === choices[item.id].targetId && (game.purgeGamePending || game.purgeSnapshotsPending))} onChange={() => setAction(item, action)}/>{t(action === 'overwrite' ? 'import.actionOverwrite' : action === 'skip' ? 'import.actionSkip' : 'import.actionKeepBoth')}</label>)}</fieldset></>}</section>)}</div>
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
