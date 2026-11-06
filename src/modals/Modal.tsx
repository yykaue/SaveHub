import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n';

export function Modal({
  title,
  children,
  onClose,
  busy,
  wide,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy: boolean;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = ref.current;
    const focus =
      element?.querySelector<HTMLElement>(
        '.modal-body [data-autofocus]:not(:disabled), .modal-body input:not(:disabled), .modal-body textarea:not(:disabled), .modal-body select:not(:disabled), .modal-body button:not(:disabled)',
      ) || element?.querySelector<HTMLElement>('button:not(:disabled)');
    focus?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) closeRef.current();
      if (event.key === 'Tab') {
        const items = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
          ) || [],
        );
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const activeInside = ref.current?.contains(document.activeElement);
        if (!activeInside) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [busy]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={ref}
      >
        <div className="modal-heading">
          <h2 id="dialog-title">{title}</h2>
          <button className="icon-button" aria-label={t('modals.closeDialogAria')} disabled={busy} onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
