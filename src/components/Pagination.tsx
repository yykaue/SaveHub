import { useState } from 'react';
import { t } from '../i18n';

/**
 * 通用客户端分页状态管理 Hook：当 `scope`（如当前选中游戏、标签页或搜索词）变化时自动重置到第 1 页。
 */
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

/** 分页导航条组件（总页数不超过 1 页时自动隐藏） */
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
