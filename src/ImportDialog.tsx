import { useState, type ReactNode } from 'react';
import { Check, Copy, Info, ShieldCheck } from 'lucide-react';
import { formatBytes, fullDate } from './format';
import { t } from './i18n';
import type { ImportAction, ImportDecision, ImportItem, ImportPlan, ImportReport, Snapshot } from './types';

const canOverwrite = (snapshot: Snapshot) => !snapshot.protected && !snapshot.deletedAt && !snapshot.purgePending && !snapshot.corrupted && snapshot.kind !== 'safety';
const initialTarget = (item: ImportItem) => item.matches.find(canOverwrite) || item.matches[0];
const targetDescription = (snapshot: Snapshot) => `${snapshot.label} · ${fullDate(snapshot.createdAt)} · ${formatBytes(snapshot.bytes)}${snapshot.protected ? t('import.tagProtected') : ''}${snapshot.deletedAt ? t('import.tagTrash') : ''}${snapshot.kind === 'safety' ? t('import.tagRestorePoint') : ''}${snapshot.purgePending ? t('import.tagPurgePending') : ''}`;

export function ImportConflicts({ plan, busy, onCancel, onConfirm, intro, confirmLabel }: {
  plan: ImportPlan; busy: boolean; onCancel: () => void; onConfirm: (decisions: ImportDecision[]) => void; intro?: ReactNode; confirmLabel?: string;
}) {
  const actions: { value: ImportAction; label: string }[] = [
    { value: 'overwrite', label: t('import.actionOverwrite') }, { value: 'skip', label: t('import.actionSkip') }, { value: 'keep-both', label: t('import.actionKeepBoth') },
  ];
  const duplicates = plan.items.filter(item => item.matches.length);
  const newCount = plan.items.length - duplicates.length;
  const [choices, setChoices] = useState<Record<string, ImportDecision>>(() => Object.fromEntries(duplicates.map(item => [item.id, { itemId: item.id, action: 'skip', targetId: initialTarget(item).id }])));
  const setAction = (item: ImportItem, action: ImportAction) => setChoices(previous => ({ ...previous, [item.id]: { ...previous[item.id], action } }));
  const applyAll = (action: ImportAction) => setChoices(previous => Object.fromEntries(duplicates.map(item => {
    const choice = previous[item.id];
    const target = item.matches.find(snapshot => snapshot.id === choice.targetId && canOverwrite(snapshot)) || initialTarget(item);
    return [item.id, { ...choice, action, targetId: action === 'overwrite' ? target.id : choice.targetId }];
  })));
  const count = (action: ImportAction) => Object.values(choices).filter(choice => choice.action === action).length;
  return <form className="import-conflicts" onSubmit={event => { event.preventDefault(); if (!busy) onConfirm(duplicates.map(item => choices[item.id])); }}>
    <fieldset disabled={busy}>
      {intro || <><p className="dialog-description">{t('import.foundDuplicates', { count: duplicates.length })}</p>
      <p className="muted">{t('import.chooseHowToHandle')}{newCount > 0 && t('import.additionalNewSaves', { count: newCount })}</p></>}
      <div className="import-rules"><p><strong>{t('import.actionOverwrite')}</strong><span>{t('import.ruleOverwriteDesc')}</span></p><p><strong>{t('import.actionSkip')}</strong><span>{t('import.ruleSkipDesc')}</span></p><p><strong>{t('import.actionKeepBoth')}</strong><span>{t('import.ruleKeepBothDesc')}</span></p></div>
      <div className="import-bulk" aria-label={t('import.bulkAria')}>
        <span>{t('import.bulkLabel')}</span>
        <button type="button" className="button secondary" disabled={!duplicates.every(item => item.matches.some(canOverwrite))} onClick={() => applyAll('overwrite')}>{t('import.bulkOverwriteAll')}</button>
        <button type="button" className="button secondary" onClick={() => applyAll('skip')}>{t('import.bulkSkipAll')}</button>
        <button type="button" className="button secondary" onClick={() => applyAll('keep-both')}>{t('import.bulkKeepBothAll')}</button>
      </div>
      <div className="import-conflict-list">
        {duplicates.map((item, index) => {
          const choice = choices[item.id];
          const target = item.matches.find(snapshot => snapshot.id === choice.targetId)!;
          return <section className="import-conflict" key={item.id} data-import-id={item.id} aria-label={t('import.duplicateItemAria', { name: item.name })}>
            <div className="import-conflict-heading"><span>{String(index + 1).padStart(2, '0')}</span><div><h3>{item.name}</h3><small>{t('import.pendingItemMeta', { fileCount: item.fileCount, size: formatBytes(item.bytes) })}</small></div></div>
            <p className="import-source" title={item.source}>{item.source}</p>
            {item.matches.length > 1 ? <label className="import-target">{t('import.matchingExistingLabel', { count: item.matches.length })}<select aria-label={t('import.overwriteTargetAria', { name: item.name })} value={target.id} onChange={event => {
              const next = item.matches.find(snapshot => snapshot.id === event.target.value)!;
              setChoices(previous => ({ ...previous, [item.id]: { ...previous[item.id], targetId: next.id, action: choice.action === 'overwrite' && !canOverwrite(next) ? 'skip' : choice.action } }));
            }}>{item.matches.map(snapshot => <option value={snapshot.id} key={snapshot.id}>{targetDescription(snapshot)} · {snapshot.id.slice(0, 8)}</option>)}</select></label>
              : <p className="import-existing">{t('import.existingPrefix')}{targetDescription(target)}</p>}
            {!canOverwrite(target) && <p className="import-protected"><ShieldCheck size={14}/>{t('import.cannotOverwriteHint')}</p>}
            <fieldset className="import-options" aria-label={t('import.itemActionAria', { name: item.name })}>
              {actions.map(action => <label key={action.value} className={choice.action === action.value ? 'selected' : undefined}>
                <input type="radio" name={`import-${item.id}`} value={action.value} checked={choice.action === action.value} disabled={action.value === 'overwrite' && !canOverwrite(target)} onChange={() => setAction(item, action.value)}/>{action.label}
              </label>)}
            </fieldset>
          </section>;
        })}
        {plan.failed.length > 0 && <div className="notice error"><Info size={15}/> {t('import.prepareFailedHeader', { count: plan.failed.length })}{plan.failed.map((item, index) => <p key={index}>{item.name}：{item.error}</p>)}</div>}
      </div>
      <div className="import-confirm-footer">
        <p className="import-choice-summary" role="status">{t('import.choiceSummary', { newCount, overwriteCount: count('overwrite'), skipCount: count('skip'), keepBothCount: count('keep-both') })}</p>
        <div className="dialog-actions"><button type="button" className="button secondary" onClick={onCancel}>{t('import.cancelBtn')}</button><button type="submit" className="button primary"><Check size={15}/>{confirmLabel || t('import.executeImportBtn')}</button></div>
      </div>
    </fieldset>
  </form>;
}

export function ImportResult({ report, onClose, description }: { report: ImportReport; onClose?: () => void; description?: string }) {
  const groups = [
    { key: 'imported', name: t('import.resultImported'), items: report.imported },
    { key: 'overwritten', name: t('import.resultOverwritten'), items: report.overwritten },
    { key: 'kept-both', name: t('import.resultKeptBoth'), items: report.keptBoth },
    { key: 'skipped', name: t('import.resultSkipped'), items: report.skipped },
  ];
  return <><div className="import-summary">{groups.map(group => <span key={group.key}><strong>{group.items.length}</strong>{group.name}</span>)}<span><strong>{report.failed.length}</strong>{t('import.resultFailed')}</span></div>
    <p className="muted">{description ?? t('import.resultDesc')}</p>
    {groups.filter(group => group.items.length).map(group => <section className="import-result-group" key={group.key}><h3>{group.name}</h3><div className="report-list">{group.items.map((name, index) => <p key={index}>{group.key === 'kept-both' ? <Copy size={14}/> : <Check size={14}/>}<span>{name}</span></p>)}</div></section>)}
    {report.failed.map((item, index) => <div className="notice error" key={index}><strong>{item.name}</strong><p>{item.error}</p></div>)}
    {onClose && <div className="dialog-actions"><button className="button primary" onClick={onClose}>{t('import.doneBtn')}</button></div>}</>;
}
