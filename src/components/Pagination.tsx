import { useState } from 'react';
import { t } from '../i18n';

export function usePagination<T>(items: T[], scope: string, size = 100) {
  const [position, setPosition] = useState({ scope, index: 0 });
  const total = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(position.scope === scope ? position.index : 0, total - 1);
  return {
    items: items.slice(page * size, (page + 1) * size),
    page,
    total,
    count: items.length,
    onPage: (index: number) => setPosition({ scope, index }),
  };
}
export function Pagination({
  page,
  total,
  count,
  onPage,
}: {
  page: number;
  total: number;
  count: number;
  onPage: (index: number) => void;
}) {
  if (total <= 1) return null;
  return (
    <nav className="pagination" aria-label={t('pagination.status', { page: page + 1, total, count })}>
      <button className="button subtle" disabled={page === 0} onClick={() => onPage(page - 1)}>
        {t('pagination.previous')}
      </button>
      <span>{t('pagination.status', { page: page + 1, total, count })}</span>
      <button className="button subtle" disabled={page === total - 1} onClick={() => onPage(page + 1)}>
        {t('pagination.next')}
      </button>
    </nav>
  );
}
