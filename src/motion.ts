import { flushSync } from 'react-dom';

let active: ViewTransition | undefined;

// Snapshot the old and new UI for a short transition. No delay is added for
// reduced-motion users, and state updates still work without this browser API.
export function animate(update: () => void) {
  active?.skipTransition();
  if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return Promise.resolve();
  }
  const transition = document.startViewTransition(() => flushSync(update));
  active = transition;
  // A new interaction may intentionally skip the visual animation while the
  // update callback still commits. Its ready promise rejects in that case.
  void transition.ready.catch(() => {});
  void transition.finished
    .catch(() => {})
    .finally(() => {
      if (active === transition) active = undefined;
    });
  return transition.updateCallbackDone;
}
