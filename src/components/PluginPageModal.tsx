
import { TranslateFn } from '../i18n/useT';
import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import { usePluginPageReadme } from '../features/plugins/hooks/usePluginPageReadme';
import { Modal } from './Modal';
import { PluginPageViewer } from './PluginPageViewer';
import type { Repository } from '../types';

/**
 * Repository context dispatched by modal actions. Fields align with main process `sanitizeRepository` allowlist,
 * plus two text summaries required for card generation; excludes host-internal fields like
 * analysis errors, index timestamps, and avatar URLs.
 */
function repositoryContext(repository: Repository): Record<string, unknown> {
  return {
    id: repository.id,
    name: repository.name,
    full_name: repository.full_name,
    description: repository.description,
    html_url: repository.html_url,
    stargazers_count: repository.stargazers_count,
    forks_count: repository.forks_count,
    language: repository.language,
    created_at: repository.created_at,
    updated_at: repository.updated_at,
    pushed_at: repository.pushed_at,
    owner: { login: repository.owner.login },
    topics: repository.topics,
    license: repository.license ?? null,
    archived: repository.archived ?? null,
    disabled: repository.disabled ?? null,
    fork: repository.fork ?? null,
    is_template: repository.is_template ?? null,
    open_issues_count: repository.open_issues_count ?? null,
    default_branch: repository.default_branch ?? null,
    custom_description: repository.custom_description ?? null,
    ai_summary: repository.ai_summary ?? null,
  };
}

interface PluginPageModalProps {
  pluginId: string;
  pluginName: string;
  pageId: string;
  pageTitle: string;
  repository: Repository;
  onClose: () => void;
  t: TranslateFn;
}

/**
 * Host container for V1.4 modal actions (opensPage): wraps plugin page inside a modal dialog, and dispatches
 * the clicked repository's metadata and README body at once via plugin-page:init. Context is actively provided
 * by the host without going through the capability bridge; page access to host capabilities remains restricted to permission-gated bridge methods.
 */
export const PluginPageModal: React.FC<PluginPageModalProps> = ({
  pluginId, pluginName, pageId, pageTitle, repository, onClose, t,
}) => {
  const language = useAppStore(useShallow((state) => state.language));
  const theme = useAppStore(useShallow((state) => state.theme));
  const { readme } = usePluginPageReadme(repository);

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`${pluginName} · ${pageTitle}`}
      maxWidth="h-[calc(100vh_-_2rem)] max-h-[calc(100vh_-_2rem)] w-[calc(100vw_-_2rem)] max-w-none"
      scrollable
      contentClassName="flex flex-col"
      closeLabel={t('pluginPageViewer.close')}
    >
      <PluginPageViewer
        variant="modal"
        pluginId={pluginId}
        pluginName={pluginName}
        pageId={pageId}
        pageTitle={pageTitle}
        onClose={onClose}
        t={t}
        initContext={{ repository: repositoryContext(repository), readme, language, theme }}
      />
    </Modal>
  );
};

export default PluginPageModal;
