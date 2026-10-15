import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useTurnStatusAnnouncement } from './useTurnStatusAnnouncement';

type HookProps = { status: Parameters<typeof useTurnStatusAnnouncement>[0] };

describe('useTurnStatusAnnouncement', () => {
  it('announces completion only after a streaming state and stays silent while streaming', () => {
    const { result, rerender } = renderHook(
      (props: HookProps) => useTurnStatusAnnouncement(props.status, 'zh'),
      { initialProps: { status: '' } },
    );

    // User message phase / empty state: no announcement
    expect(result.current).toBe('');

    // First turn streaming begins: clear announcement
    rerender({ status: 'streaming' });
    expect(result.current).toBe('');

    // First turn completed: announce once
    rerender({ status: 'complete' });
    expect(result.current).toBe('回答已完成。');

    // Second turn streaming begins: clear old announcement first so identical text can be re-announced
    rerender({ status: 'streaming' });
    expect(result.current).toBe('');

    // Second turn completed: announce again (even with identical text)
    rerender({ status: 'complete' });
    expect(result.current).toBe('回答已完成。');
  });

  it('announces failure and stop, and does not announce for non-streaming transitions', () => {
    const { result, rerender } = renderHook(
      (props: HookProps) => useTurnStatusAnnouncement(props.status, 'en'),
      { initialProps: { status: 'error' } },
    );

    // Initial error (page recovery scenario), not transitioned through streaming: no announcement
    expect(result.current).toBe('');

    rerender({ status: 'streaming' });
    rerender({ status: 'aborted' });
    expect(result.current).toBe('Generation stopped.');

    rerender({ status: 'complete' });
    // aborted -> complete without passing through streaming: do not re-announce
    expect(result.current).toBe('Generation stopped.');
  });
});
