import { flushSync } from 'react-dom';

let active: ViewTransition | undefined;

/**
 * 使用浏览器 View Transitions API 为前后 UI 状态拍快照并执行平滑过渡动画；
 * 若用户开启了减弱动态效果（prefers-reduced-motion）或环境不支持该 API，则直接同步更新状态。
 */
export function animate(update: () => void) {
  active?.skipTransition();
  if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return Promise.resolve();
  }
  const transition = document.startViewTransition(() => flushSync(update));
  active = transition;
  // 当新的交互主动跳过上一个未完成的视觉动画时，旧动画的 ready Promise 会被拒绝，但状态回调仍正常提交
  void transition.ready.catch(() => {});
  void transition.finished
    .catch(() => {})
    .finally(() => {
      if (active === transition) active = undefined;
    });
  return transition.updateCallbackDone;
}
