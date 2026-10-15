import React, { useEffect, useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { TranslateFn } from '../../i18n/useT';
import { useDialog } from '../../hooks/useDialog';
import { pluginMarketplaceService } from '../../services/pluginMarketplaceService';
import type { MarketplaceSourceEntry, MarketplaceState } from '../../plugins/types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Modal } from '../Modal';

interface PluginSourcesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  t: TranslateFn;
  entries: MarketplaceSourceEntry[];
  /** Passes the latest state returned by the main process to the parent on add/remove/edit (parent refreshes the plugin list accordingly). */
  onChanged: (state: MarketplaceState) => void;
}

interface EditingSource {
  /** null indicates new entry; otherwise the source ID being edited. */
  id: string | null;
  url: string;
  name: string;
}

// Lenient pre-check: only catches obvious non-GitHub URLs; full shape validation (including tree parsing) is handled by the main process.
const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/[^\s/]+\/[^\s/]+(?:\/[^\s]+)?\/?$/i;

/**
 * Plugin sources management dialog: sources are GitHub repository directories;
 * after add/remove/update, the main process re-traverses immediately.
 * Search is handled by the list itself; browsing plugins is handled in the parent marketplace dialog.
 */
export const PluginSourcesDialog: React.FC<PluginSourcesDialogProps> = ({ isOpen, onClose, t, entries, onChanged }) => {
  const { confirm, toast } = useDialog();
  const [editing, setEditing] = useState<EditingSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Clear uncommitted form data when dialog closes to prevent stale partial input on next open.
  useEffect(() => {
    if (!isOpen) {
      setEditing(null);
      setFormError(null);
    }
  }, [isOpen]);

  const startAdd = () => {
    setFormError(null);
    setEditing({ id: null, url: '', name: '' });
  };

  const startEdit = (entry: MarketplaceSourceEntry) => {
    setFormError(null);
    setEditing({ id: entry.source.id, url: entry.source.url, name: entry.source.name ?? '' });
  };

  const submit = async () => {
    if (!editing) return;
    const url = editing.url.trim();
    if (!GITHUB_URL_PATTERN.test(url)) {
      setFormError(t('pluginSettingsPanel.sources-url-invalid'));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const name = editing.name.trim();
      const result = editing.id
        ? await pluginMarketplaceService.updateSource({
          id: editing.id,
          url,
          ...(name ? { name } : { name: '' }),
        })
        : await pluginMarketplaceService.addSource({
          url,
          ...(name ? { name } : {}),
        });
      if (!result.success) {
        setFormError(result.error.message);
        return;
      }
      onChanged(result.state);
      setEditing(null);
      toast(t('pluginSettingsPanel.sources-saved'), 'success');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t('pluginSettingsPanel.marketplace-install-failed'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: MarketplaceSourceEntry) => {
    const sourceLabel = entry.source.name ?? entry.source.url;
    const approved = await confirm(
      t('pluginSettingsPanel.sources-remove-title'),
      t('pluginSettingsPanel.sources-remove-message-v1', { v1: sourceLabel }),
      { confirmText: t('pluginSettingsPanel.sources-remove-confirm'), type: 'warning' }
    );
    if (!approved) return;
    setBusy(true);
    try {
      const result = await pluginMarketplaceService.removeSource({ id: entry.source.id });
      if (result.success) {
        onChanged(result.state);
        toast(t('pluginSettingsPanel.sources-removed'), 'success');
      } else {
        toast(result.error.message, 'error');
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : t('pluginSettingsPanel.marketplace-install-failed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('pluginSettingsPanel.sources-title')}
      maxWidth="max-w-2xl"
      scrollable
    >
      <p className="text-sm text-muted-foreground">{t('pluginSettingsPanel.sources-description')}</p>

      {editing === null ? (
        <div className="mt-4">
          <Button type="button" size="sm" onClick={startAdd} disabled={busy} data-testid="plugin-sources-add">
            <Plus className="mr-2 h-4 w-4" />
            {t('pluginSettingsPanel.sources-add')}
          </Button>
        </div>
      ) : null}

      {editing !== null ? (
        <form
          className="mt-4 space-y-3 rounded-lg border border-border p-4"
          data-testid="plugin-sources-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div>
            <label htmlFor="plugin-source-name" className="block text-sm font-medium">
              {t('pluginSettingsPanel.sources-name')}
            </label>
            <Input
              id="plugin-source-name"
              value={editing.name}
              onChange={(event) => setEditing({ ...editing, name: event.target.value })}
              placeholder={t('pluginSettingsPanel.sources-name-placeholder')}
              className="mt-1"
              maxLength={200}
            />
          </div>
          <div>
            <label htmlFor="plugin-source-url" className="block text-sm font-medium">
              {t('pluginSettingsPanel.sources-url')}
            </label>
            <Input
              id="plugin-source-url"
              value={editing.url}
              onChange={(event) => setEditing({ ...editing, url: event.target.value })}
              placeholder={t('pluginSettingsPanel.sources-url-placeholder')}
              className="mt-1 font-mono text-xs"
              maxLength={2048}
              required
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('pluginSettingsPanel.sources-url-hint')}</p>
          </div>
          {formError && <p className="text-xs text-destructive" data-testid="plugin-sources-form-error">{formError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(null)} disabled={busy}>
              {t('pluginSettingsPanel.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('pluginSettingsPanel.sources-save')}
            </Button>
          </div>
        </form>
      ) : null}

      <div className="mt-4 space-y-2" data-testid="plugin-sources-list">
        {entries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t('pluginSettingsPanel.sources-empty')}
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.source.id}
              className="flex items-center justify-between gap-3 rounded border border-border px-3 py-2"
              data-testid={`plugin-source-${entry.source.id}`}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{entry.source.name ?? entry.source.url}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">{entry.source.url}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  aria-label={t('pluginSettingsPanel.sources-edit-source-v1', { v1: entry.source.name ?? entry.source.url })}
                  onClick={() => startEdit(entry)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  aria-label={t('pluginSettingsPanel.sources-remove-source-v1', { v1: entry.source.name ?? entry.source.url })}
                  onClick={() => void remove(entry)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
};

export default PluginSourcesDialog;
