/**
 * Minimal server-rendered pages: the landing page, the passcode page, and the
 * OAuth consent page. The product UI is the React app in the repository root;
 * these exist so the Worker is usable and authenticatable on its own.
 * Colors follow the system theme; no custom palette.
 */
const BASE_STYLE = `
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  input, button { font: inherit; padding: .5rem .75rem; }
  form { display: grid; gap: .75rem; }
  .error { color: CanvasText; font-weight: 600; }
  code { font-family: ui-monospace, monospace; }`;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${BASE_STYLE}</style></head><body>${body}</body></html>`;
}

export function landingPage(): string {
  return page(
    "GitHub Stars Manager",
    `<h1>GitHub Stars Manager</h1>
<p>Your GitHub stars in Postgres with vector and keyword search, a daily inbox of new projects that match your interests, and research consultations that search GitHub for well-starred projects and judge what you can reuse.</p>
<ul>
  <li><a href="/scalar">API reference (Scalar)</a> · <a href="/swagger">Swagger UI</a> · <a href="/openapi.json">openapi.json</a></li>
  <li><a href="/health">Health</a></li>
  <li>MCP endpoint: <code>/mcp</code> (OAuth 2.1, or <code>Authorization: Bearer</code>)</li>
  <li><a href="/login">Sign in</a></li>
</ul>`,
  );
}

export function loginPage(failed: boolean): string {
  return page(
    "Sign in",
    `<h1>Sign in</h1>
${failed ? '<p class="error" role="alert">That passcode is not correct.</p>' : ""}
<form method="post" action="/auth/login">
  <label for="passcode">Passcode</label>
  <input id="passcode" name="passcode" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
</form>`,
  );
}

export function consentPage(opts: { clientName: string; redirectHost: string; state: string; failed: boolean }): string {
  return page(
    "Connect an app",
    `<h1>Connect ${escapeHtml(opts.clientName)}</h1>
<p>This grants <strong>${escapeHtml(opts.redirectHost)}</strong> access to GitHub Stars Manager for one year. Only continue if you started this connection.</p>
${opts.failed ? '<p class="error" role="alert">That passcode is not correct.</p>' : ""}
<form method="post" action="/authorize">
  <input type="hidden" name="state" value="${escapeHtml(opts.state)}">
  <label for="passcode">Passcode</label>
  <input id="passcode" name="passcode" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Connect</button>
</form>`,
  );
}
