import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ListsPushIndicator } from './ListsPushIndicator';

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {};
  return {
    state,
    toast: vi.fn(),
    useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => (selector ? selector(state) : state),
  };
});

vi.mock('../store/useAppStore', () => ({
  useAppStore: mocks.useAppStore,
}));

vi.mock('../hooks/useDialog', () => ({
  useDialog: () => ({ toast: mocks.toast }),
}));

vi.mock('../i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

type PushState = { isRunning: boolean; error: string | null; message?: string; total: number; done: number };

const setPush = (patch: Partial<PushState>) => {
  mocks.state.listsPush = { isRunning: false, error: null, total: 0, done: 0, ...patch };
  mocks.state.resetListsPush ??= vi.fn();
};

describe('ListsPushIndicator error notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPush({});
  });

  it('toasts errors occurring while not running (e.g. pre-flight validation) only once', () => {
    const { rerender } = render(<ListsPushIndicator />);
    expect(mocks.toast).not.toHaveBeenCalled();

    setPush({ error: 'Token not configured' });
    rerender(<ListsPushIndicator />);
    rerender(<ListsPushIndicator />);

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith('Token not configured', 'error');
  });

  it('toasts once without repeating when run finishes with error', () => {
    setPush({ isRunning: true, total: 2, done: 1 });
    const { rerender } = render(<ListsPushIndicator />);

    setPush({ isRunning: false, error: 'Push failed' });
    rerender(<ListsPushIndicator />);
    rerender(<ListsPushIndicator />);

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith('Push failed', 'error');
  });

  it('toasts each time when identical error messages are written twice consecutively while not running', () => {
    const { rerender } = render(<ListsPushIndicator />);

    setPush({ error: 'Network unavailable' });
    rerender(<ListsPushIndicator />);
    setPush({ error: 'Network unavailable' });
    rerender(<ListsPushIndicator />);

    expect(mocks.toast).toHaveBeenCalledTimes(2);
    expect(mocks.toast).toHaveBeenNthCalledWith(2, 'Network unavailable', 'error');
  });

  it('does not toast errors that already existed upon mount', () => {
    setPush({ error: 'Old error' });
    const { rerender } = render(<ListsPushIndicator />);
    rerender(<ListsPushIndicator />);

    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('does not clear a new push run started within 4 seconds by previous reset timer', () => {
    vi.useFakeTimers();
    try {
      setPush({ isRunning: true, total: 1, done: 0 });
      const { rerender } = render(<ListsPushIndicator />);
      setPush({ isRunning: false, message: 'Done' });
      rerender(<ListsPushIndicator />);
      setPush({ isRunning: true, total: 1, done: 0 });
      rerender(<ListsPushIndicator />);

      vi.advanceTimersByTime(5000);

      expect(mocks.state.resetListsPush).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not clear a pre-flight error occurring within 4 seconds by previous reset timer', () => {
    vi.useFakeTimers();
    try {
      setPush({ isRunning: true, total: 1, done: 0 });
      const { rerender } = render(<ListsPushIndicator />);
      setPush({ isRunning: false, message: 'Done' });
      rerender(<ListsPushIndicator />);
      setPush({ error: 'Token not configured' });
      rerender(<ListsPushIndicator />);

      vi.advanceTimersByTime(5000);

      expect(mocks.state.resetListsPush).not.toHaveBeenCalled();
      expect(mocks.toast).toHaveBeenLastCalledWith('Token not configured', 'error');
    } finally {
      vi.useRealTimers();
    }
  });
});
