import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_LANGUAGES, detectInitialLanguage, isAppLanguage } from './languages';

// The app must open in English for anyone whose browser or saved settings say Chinese.
// Chinese is not an app language (see AGENTS.md), so these guard against it coming back.

const stubBrowserLanguages = (languages: string[]) => {
  vi.stubGlobal('navigator', { language: languages[0], languages });
};

describe('app languages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not offer Chinese in the language list', () => {
    const codes = APP_LANGUAGES.map((definition) => definition.code);
    expect(codes).not.toContain('zh');
    expect(codes).not.toContain('zh-TW');
    expect(codes[0]).toBe('en');
  });

  it('rejects a saved Chinese setting, so the store falls back to its default', () => {
    expect(isAppLanguage('zh')).toBe(false);
    expect(isAppLanguage('zh-TW')).toBe(false);
    expect(isAppLanguage('en')).toBe(true);
  });

  it.each([
    [['zh-CN']],
    [['zh-TW', 'zh']],
    [['zh-HK', 'zh-Hant']],
  ])('opens in English for a Chinese browser (%j)', (languages) => {
    stubBrowserLanguages(languages);
    expect(detectInitialLanguage()).toBe('en');
  });

  it('uses the first supported browser language after a Chinese one', () => {
    stubBrowserLanguages(['zh-CN', 'fr-FR']);
    expect(detectInitialLanguage()).toBe('fr');
  });

  it('opens in English for an unsupported browser language', () => {
    stubBrowserLanguages(['it-IT']);
    expect(detectInitialLanguage()).toBe('en');
  });
});
