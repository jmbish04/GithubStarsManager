const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Regression tests for the prompt generation and busy feedback of the "Repo Info Card" example plugin.
// The page script is not a module; we run it inside a minimal DOM stub sandbox and inspect exposed internals.
const PLUGIN_SCRIPT = path.resolve(__dirname, '../../examples/plugins/repo-info-card/ui/index.js');
const CANVASES = [
  { id: '1x1', w: 1200, h: 1200 },
  { id: '5x2', w: 1500, h: 600 },
  { id: '3x4', w: 1200, h: 1600 },
  { id: 'custom', w: 640, h: 2400 },
];

/**
 * Constructs a lightweight mock DOM element for the test sandbox.
 *
 * @param {string} id Element ID
 * @returns {Record<string, any>} Mock node with basic DOM manipulation methods
 */
function makeElement(id) {
  const classes = new Set();
  const attributes = new Map();
  return {
    id,
    textContent: '',
    value: '',
    innerHTML: '',
    className: '',
    type: '',
    disabled: false,
    hidden: false,
    tabIndex: 0,
    clientWidth: 800,
    clientHeight: 600,
    scrollWidth: 800,
    scrollHeight: 600,
    dataset: {},
    style: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    append() {},
    replaceChildren() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    hasPointerCapture() { return false; },
    releasePointerCapture() {},
    attachShadow() { return makeElement(`${id}-shadow`); },
  };
}

/**
 * Loads and executes the repo info card UI script in an isolated VM sandbox, exposing internal objects.
 *
 * @returns {{ plugin: Record<string, any>, byId: (id: string) => Record<string, any> }} Plugin context running in sandbox and element getter
 */
function loadPlugin() {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const sandbox = {
    document: {
      documentElement: makeElement('html'),
      getElementById: byId,
      querySelector: (selector) => byId(selector),
      querySelectorAll: () => [],
      createElement: (tag) => makeElement(tag),
      addEventListener() {},
      removeEventListener() {},
    },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
    DOMParser: class {
      parseFromString(html) {
        const root = makeElement('parsed-doc');
        if (html.includes('id="card"')) {
          const card = makeElement('card');
          card.outerHTML = '<div id="card"></div>';
          root.getElementById = (id) => (id === 'card' ? card : null);
        } else {
          root.getElementById = () => null;
        }
        return root;
      }
    },
    setTimeout,
    clearTimeout,
  };
  // Expose script-scoped constants and functions on the global sandbox for test assertions.
  const expose = '\n;let __mockRequest = null; const __origReq = request; request = (method, args) => __mockRequest ? __mockRequest(method, args) : __origReq(method, args); globalThis.__plugin = { state, STR, CARD_LANGUAGES, STRUCTURES, layoutForCanvas, buildSystemPrompt, buildUserPrompt, setBusy, setStatus, handleInit, canvasMatchesSnapshot, sanitizeFragment, generate, setRequestMock: (fn) => { __mockRequest = fn; }, AI_SYSTEM_LIMIT, AI_USER_LIMIT };\n';
  vm.runInNewContext(
    fs.readFileSync(PLUGIN_SCRIPT, 'utf8') + expose,
    sandbox,
    { filename: PLUGIN_SCRIPT }
  );
  return { plugin: sandbox.__plugin, byId };
}

/**
 * Generates standard sample repository metadata for unit testing.
 *
 * @returns {Record<string, any>} Repository data stub containing basic attributes
 */
function repository() {
  return {
    name: 'project',
    full_name: 'owner/project',
    html_url: 'https://github.com/owner/project',
    owner: { login: 'owner' },
    description: 'Example repository',
    language: 'TypeScript',
    stargazers_count: 42,
    forks_count: 3,
    open_issues_count: 1,
    license: 'MIT',
    topics: ['desktop'],
    created_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-01-03T00:00:00Z',
  };
}

const LABEL_PLACEHOLDERS = {
  K_STARS: 'stars',
  K_FORKS: 'forks',
  K_LANGUAGE: 'language',
  K_LICENSE: 'license',
  K_KEY: 'key',
  K_FOOTER: 'footer',
};

test('repo info card: every language fits the system-prompt bridge limit with localized labels', () => {
  const { plugin } = loadPlugin();
  assert.equal(plugin.CARD_LANGUAGES.length, 10);
  for (const language of plugin.CARD_LANGUAGES) {
    for (const field of Object.values(LABEL_PLACEHOLDERS)) {
      assert.equal(typeof language.labels?.[field], 'string', `${language.code}.${field} must be a string`);
      assert.ok(language.labels[field].length > 0, `${language.code}.${field} must not be empty`);
    }
    for (const canvas of CANVASES) {
      // 'auto' (follow UI) resolves to the host UI language state.language.
      plugin.state.language = language.code;
      const system = plugin.buildSystemPrompt(canvas, 'auto');
      const where = `${language.code}/${canvas.id}`;
      assert.ok(system.length <= plugin.AI_SYSTEM_LIMIT,
        `${where}: system prompt ${system.length} exceeds ${plugin.AI_SYSTEM_LIMIT}`);
      assert.ok(!system.includes('{K_'), `${where}: left an unlocalized {K_*} placeholder`);
      assert.ok(system.includes(`Language: ${language.englishName}`),
        `${where}: missing the language directive for ${language.englishName}`);
      // Assert only on labels actually used in the layout template, localized to the target language.
      const template = plugin.STRUCTURES[plugin.layoutForCanvas(canvas.id, canvas.w, canvas.h)];
      for (const [placeholder, field] of Object.entries(LABEL_PLACEHOLDERS)) {
        if (!template.includes(`{${placeholder}}`)) continue;
        assert.ok(system.includes(language.labels[field]),
          `${where}: ${placeholder} not localized to ${language.code}`);
      }
    }
  }
});

test('repo info card: an explicit language option overrides the UI language in both prompts', () => {
  const { plugin } = loadPlugin();
  plugin.state.language = 'zh';
  const system = plugin.buildSystemPrompt({ id: '1x1', w: 1200, h: 1200 }, 'ja');
  assert.ok(system.includes('Language: Japanese'));
  assert.ok(system.includes('スター'));

  const { prompt, readmeIncluded, truncatedReadme } = plugin.buildUserPrompt(repository(), 'readme body', '', 'ja');
  assert.ok(prompt.includes('Write EVERY visible string in Japanese'),
    'user prompt must restate the target language');
  assert.ok(prompt.includes('readme body'));
  assert.equal(readmeIncluded, true);
  assert.equal(truncatedReadme, false);
  assert.ok(prompt.length <= plugin.AI_USER_LIMIT);
});

test('repo info card: prompt builders default to state.languageOption when omitted', () => {
  const { plugin } = loadPlugin();
  plugin.state.language = 'zh';
  plugin.state.languageOption = 'auto';
  const system = plugin.buildSystemPrompt({ id: '1x1', w: 1200, h: 1200 });
  assert.ok(system.includes('Language: Simplified Chinese'));
  const { prompt } = plugin.buildUserPrompt(repository(), 'readme body', '');
  assert.ok(prompt.includes('Write EVERY visible string in Simplified Chinese'));
});

test('repo info card: an oversized README is truncated instead of being silently dropped', () => {
  const { plugin } = loadPlugin();
  const huge = 'x'.repeat(plugin.AI_USER_LIMIT + 1000);
  const { prompt, readmeIncluded, truncatedReadme } = plugin.buildUserPrompt(repository(), huge, '', 'zh');
  assert.equal(truncatedReadme, true);
  assert.equal(readmeIncluded, true);
  assert.ok(prompt.length <= plugin.AI_USER_LIMIT);
  assert.ok(prompt.includes('truncated at the prompt limit'));
});

test('repo info card: generating toggles a visible busy state on the button and status line', () => {
  const { plugin, byId } = loadPlugin();
  const generate = byId('generate');
  const status = byId('status');
  assert.equal(generate.disabled, false);

  plugin.setBusy(true);
  assert.equal(generate.disabled, true, 'generate button must be disabled while waiting');
  assert.ok(generate.classList.contains('is-busy'), 'button needs the spinner hook');
  assert.equal(generate.getAttribute('aria-busy'), 'true');
  assert.ok(status.classList.contains('is-busy'), 'status line needs the pulse hook');
  assert.equal(status.getAttribute('aria-busy'), 'true');
  assert.equal(generate.textContent, plugin.STR.zh.generatingShort);

  plugin.setBusy(false);
  assert.equal(generate.disabled, false);
  assert.ok(!generate.classList.contains('is-busy'));
  assert.equal(generate.getAttribute('aria-busy'), 'false');
  assert.ok(!status.classList.contains('is-busy'));
  assert.equal(status.getAttribute('aria-busy'), 'false');
  assert.equal(generate.textContent, plugin.STR.zh.generate);
});

test('repo info card: async init while busy does not overwrite the generating status line', () => {
  const { plugin, byId } = loadPlugin();
  const status = byId('status');
  plugin.handleInit({ repository: repository(), readme: null, language: 'zh' });
  assert.equal(status.textContent, plugin.STR.zh.loadedWithoutReadme);

  // User clicks generate, entering busy state (first generation, no existing card)
  plugin.setBusy(true);
  plugin.setStatus(plugin.STR.zh.generating);
  assert.equal(status.textContent, plugin.STR.zh.generating);

  // Host asynchronously sends followup init with README
  plugin.handleInit({ repository: repository(), readme: '# Project README', language: 'zh' });
  assert.equal(plugin.state.readme, '# Project README');
  assert.equal(status.textContent, plugin.STR.zh.generating,
    'status line must remain on generating while busy (first generation)');

  plugin.setBusy(false);

  // Regeneration scenario (existing card state): receiving README while busy does not overwrite generating status
  plugin.state.fragment = '<div id="card">existing card</div>';
  plugin.state.fragmentCanvas = { id: '1x1', w: 1200, h: 1200 };
  plugin.state.usedReadme = false;
  plugin.setBusy(true);
  plugin.setStatus(plugin.STR.zh.generating);

  plugin.handleInit({ repository: repository(), readme: '# New README', language: 'zh' });
  assert.equal(plugin.state.readme, '# New README');
  assert.equal(status.textContent, plugin.STR.zh.generating,
    'status line must remain on generating while regenerating existing card');

  plugin.setBusy(false);

  // When not busy and existing card receives updated README, display readmeReady status
  plugin.handleInit({ repository: repository(), readme: '# Updated README', language: 'zh' });
  assert.equal(status.textContent, plugin.STR.zh.readmeReady,
    'status line should prompt readmeReady when not busy');
});

test('repo info card: busy state disables export buttons and restores them on finish', () => {
  const { plugin, byId } = loadPlugin();
  const copyCode = byId('copy-code');
  const copyImage = byId('copy-image');
  const saveImage = byId('save-image');

  plugin.state.fragment = '<div id="card">ok</div>';
  plugin.state.fragmentCanvas = { id: '1x1', w: 1200, h: 1200 };
  plugin.state.canvasId = '1x1';
  copyCode.disabled = false;
  copyImage.disabled = false;
  saveImage.disabled = false;

  plugin.setBusy(true);
  assert.equal(copyCode.disabled, true);
  assert.equal(copyImage.disabled, true);
  assert.equal(saveImage.disabled, true);

  plugin.setBusy(false);
  assert.equal(copyCode.disabled, false);
  assert.equal(copyImage.disabled, false);
  assert.equal(saveImage.disabled, false);

  // When custom dimensions do not match, screenshot buttons must remain disabled after busy state clears
  plugin.state.canvasId = 'custom';
  plugin.state.fragmentCanvas = { id: 'custom', w: 800, h: 1000 };
  plugin.state.customWidth = 900; // Dimension changed
  plugin.state.customHeight = 1000;

  plugin.setBusy(true);
  plugin.setBusy(false);
  assert.equal(copyCode.disabled, false);
  assert.equal(copyImage.disabled, true, 'screenshot button must stay disabled when custom width differs');
  assert.equal(saveImage.disabled, true, 'save image button must stay disabled when custom width differs');

  // When custom dimensions match again, screenshot buttons become enabled
  plugin.state.customWidth = 800;
  plugin.setBusy(true);
  plugin.setBusy(false);
  assert.equal(copyImage.disabled, false, 'screenshot button should be enabled when custom dimensions match');
  assert.equal(saveImage.disabled, false, 'save image button should be enabled when custom dimensions match');
});

test('repo info card: sanitization failure preserves existing fragment and snapshot state', async () => {
  const { plugin, byId } = loadPlugin();
  const status = byId('status');
  const initialCanvas = { id: '1x1', w: 1200, h: 1200 };
  plugin.state.repository = repository();
  plugin.state.fragment = '<div id="card">original</div>';
  plugin.state.fragmentCanvas = initialCanvas;
  plugin.state.fragmentLanguage = 'zh';
  plugin.state.usedReadme = true;

  // User attempts to regenerate with new canvas and language
  plugin.state.canvasId = '5x2';
  plugin.state.languageOption = 'ja';

  // Mock AI returning invalid response (missing id="card" root element)
  plugin.setRequestMock(async (method) => {
    if (method === 'ai.generate') {
      return '<div>invalid response without card root</div>';
    }
    throw new Error(`Unexpected method: ${method}`);
  });

  await plugin.generate();

  // Status line shows missing card root error, and busy state is safely released
  assert.ok(status.textContent.includes(plugin.STR.zh.noCard));
  assert.equal(plugin.state.busy, false);

  // Previous card state and snapshot remain untouched, not corrupted by failed request
  assert.equal(plugin.state.fragment, '<div id="card">original</div>');
  assert.equal(plugin.state.fragmentCanvas, initialCanvas);
  assert.equal(plugin.state.fragmentLanguage, 'zh');
  assert.equal(plugin.state.usedReadme, true);

  // Direct invocation of sanitizeFragment also throws expected error
  assert.throws(() => {
    plugin.sanitizeFragment('<div>no card root</div>', { id: '5x2', w: 1500, h: 600 });
  }, /card/i);
});
