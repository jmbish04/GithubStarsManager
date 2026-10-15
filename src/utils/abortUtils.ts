/**
 * Combines an external AbortSignal and a timeout into a single AbortController.
 * Avoids AbortSignal.timeout / AbortSignal.any (unsupported in Chrome < 124 / Safari < 16),
 * using standard AbortController semantics: aborts whenever either source aborts.
 * Cleans up the timer and listeners once aborted to prevent leaks.
 */
export function createCombinedAbortController(parentSignal: AbortSignal | undefined, timeoutMs: number): AbortController {
  const controller = new AbortController();
  // If parent signal is already aborted, abort immediately and return.
  // Registering a listener now would never fire (the abort event is only emitted once),
  // and setting a timer first would needlessly wait out the timeout period.
  if (parentSignal?.aborted) {
    controller.abort();
    return controller;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  controller.signal.addEventListener('abort', () => {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }, { once: true });
  return controller;
}
