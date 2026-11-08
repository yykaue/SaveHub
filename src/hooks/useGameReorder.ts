import { useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { Game } from '../types';

type Placement = 'before' | 'after';
const dragType = 'application/x-savehub-game';
const nonDragSelector = 'button:not(.game-reorder-handle), input, label, a, code';

/** 原生拖拽与键盘排序共用一套顺序；仅在放下时提交，取消拖动不写入。 */
export function useGameReorder(
  games: Game[],
  layout: 'cards' | 'list',
  busy: boolean,
  onReorder: (ids: string[]) => void,
) {
  const source = useRef<string | null>(null);
  const pressTarget = useRef<Element | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [target, setTarget] = useState<{ id: string; placement: Placement } | null>(null);
  const enabled = !busy && games.length > 1;
  const clear = () => {
    source.current = null;
    pressTarget.current = null;
    setDragged(null);
    setTarget(null);
  };
  const move = (id: string, targetId: string, placement: Placement) => {
    if (!enabled || id === targetId || !games.some((game) => game.id === id)) return;
    const order = games.map((game) => game.id).filter((item) => item !== id);
    const index = order.indexOf(targetId);
    if (index < 0) return;
    order.splice(index + (placement === 'after' ? 1 : 0), 0, id);
    if (order.some((item, position) => item !== games[position].id)) onReorder(order);
  };
  const placementAt = (event: DragEvent<HTMLElement>, targetId: string): Placement => {
    const fromIndex = games.findIndex((game) => game.id === source.current);
    const toIndex = games.findIndex((game) => game.id === targetId);
    if (fromIndex >= 0 && toIndex === fromIndex - 1) return 'before';
    if (fromIndex >= 0 && toIndex === fromIndex + 1) return 'after';
    const bounds = event.currentTarget.getBoundingClientRect();
    return (
      layout === 'cards'
        ? event.clientX < bounds.left + bounds.width / 2
        : event.clientY < bounds.top + bounds.height / 2
    )
      ? 'before'
      : 'after';
  };
  const canDrop = (id: string) =>
    enabled && source.current !== null && source.current !== id && games.some((game) => game.id === source.current);

  return {
    enabled,
    itemProps: (id: string) => ({
      draggable: enabled,
      'data-dragging': dragged === id || undefined,
      'data-drop-position': target?.id === id ? target.placement : undefined,
      onMouseDown: (event: MouseEvent<HTMLElement>) => {
        pressTarget.current = event.target instanceof Element ? event.target : null;
      },
      onDragStart: (event: DragEvent<HTMLElement>) => {
        const element = event.target as HTMLElement;
        const origin = pressTarget.current ?? element;
        // 子元素中的图像、文本选择及普通操作控件不能启动游戏排序。
        if (
          !enabled ||
          (element !== event.currentTarget && !element.closest('.game-reorder-handle')) ||
          origin.closest(nonDragSelector)
        ) {
          pressTarget.current = null;
          event.preventDefault();
          return;
        }
        source.current = id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(dragType, id);
        const bounds = event.currentTarget.getBoundingClientRect();
        event.dataTransfer.setDragImage(event.currentTarget, event.clientX - bounds.left, event.clientY - bounds.top);
        setDragged(id);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!canDrop(id)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const placement = placementAt(event, id);
        setTarget((previous) =>
          previous?.id === id && previous.placement === placement ? previous : { id, placement },
        );
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setTarget((previous) => (previous?.id === id ? null : previous));
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!canDrop(id) || event.dataTransfer.getData(dragType) !== source.current) return;
        event.preventDefault();
        const draggedId = source.current!;
        const placement = placementAt(event, id);
        clear();
        move(draggedId, id, placement);
      },
      onDragEnd: clear,
    }),
    handleKey: (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
      if (!enabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const index = games.findIndex((game) => game.id === id);
      let next: number;
      switch (event.key) {
        case 'ArrowUp':
        case 'ArrowLeft':
          next = index - 1;
          break;
        case 'ArrowDown':
        case 'ArrowRight':
          next = index + 1;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = games.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      if (next !== index && games[next]) move(id, games[next].id, next < index ? 'before' : 'after');
    },
  };
}
