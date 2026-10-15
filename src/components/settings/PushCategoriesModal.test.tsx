import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PushCategoriesModal } from './PushCategoriesModal';
import type { Category } from '../../types';

vi.mock('../../store/useAppStore', () => ({
  useAppStore: vi.fn((selector) => {
    const state = {
      language: 'en',
    };
    return selector ? selector(state) : state;
  }),
}));

const categories: Category[] = [
  { id: 'a', name: 'Category A', icon: '📦', keywords: [] },
  { id: 'b', name: 'Category B', icon: '🧪', keywords: [], isCustom: true },
  { id: 'c', name: 'Category C', icon: '🛠', keywords: [], isCustom: true },
];

const renderModal = (onConfirm = vi.fn()) => {
  render(<PushCategoriesModal isOpen onClose={vi.fn()} categories={categories} onConfirm={onConfirm} />);
  return onConfirm;
};

describe('PushCategoriesModal', () => {
  it('defaults to all selected when opened', () => {
    renderModal();

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3);
    boxes.forEach(box => expect(box).toBeChecked());
    expect(screen.getByRole('button', { name: 'Push 3 selected' })).toBeEnabled();
  });

  it('disables the confirm button when none are selected', async () => {
    renderModal();

    await userEvent.click(screen.getByRole('button', { name: 'Select none' }));

    screen.getAllByRole('checkbox').forEach(box => expect(box).not.toBeChecked());
    expect(screen.getByRole('button', { name: 'Push 0 selected' })).toBeDisabled();
  });

  it('returns remaining ids after unchecking an item', async () => {
    const onConfirm = renderModal();

    await userEvent.click(screen.getByRole('checkbox', { name: /Category B/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Push 2 selected' }));

    expect(onConfirm).toHaveBeenCalledWith(['a', 'c']);
  });

  it('restores all selected after closing and reopening', async () => {
    const props = { onClose: vi.fn(), categories, onConfirm: vi.fn() };
    const { rerender } = render(<PushCategoriesModal isOpen {...props} />);

    await userEvent.click(screen.getByRole('checkbox', { name: /Category B/ }));
    expect(screen.getByRole('checkbox', { name: /Category B/ })).not.toBeChecked();

    rerender(<PushCategoriesModal isOpen={false} {...props} />);
    rerender(<PushCategoriesModal isOpen {...props} />);

    screen.getAllByRole('checkbox').forEach(box => expect(box).toBeChecked());
  });

  it('returns all ids after select none then select all', async () => {
    const onConfirm = renderModal();

    await userEvent.click(screen.getByRole('button', { name: 'Select none' }));
    await userEvent.click(screen.getByRole('button', { name: 'Select all' }));
    await userEvent.click(screen.getByRole('button', { name: 'Push 3 selected' }));

    expect(onConfirm).toHaveBeenCalledWith(['a', 'b', 'c']);
  });
});
