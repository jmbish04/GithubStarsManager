export const PROJECT_REPO_URL = 'https://github.com/AmintaCCCP/GithubStarsManager';

export const PROJECT_ISSUES_URL = `${PROJECT_REPO_URL}/issues`;

/**
 * Where the in-app update check reads versions/version-info.xml: this fork, not the original project.
 * The fork's version only moves after an upstream release is merged here (and translated), and the Mac
 * updater installs it from this fork, so the notice matches what will actually be installed.
 */
export const UPDATE_SOURCE_REPO_URL = 'https://github.com/jmbish04/GithubStarsManager';

/** The GitHub Stars Manager Worker backend (worker/): pgvector search and the OpenAI-compatible door to core-guardian. */
export const WORKER_BACKEND_URL = 'https://github-stars-manager.hacolby.workers.dev';
