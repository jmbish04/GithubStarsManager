import { makeT } from '../i18n/useT';
import { getCurrentAppLanguage } from '../i18n';





/**
 * Clipboard utility functions.
 * Provides compatibility checks and fallback mechanisms.
 */

export interface ClipboardSupport {
  writeText: boolean;
  readText: boolean;
  isSecureContext: boolean;
}

/**
 * Checks clipboard API support.
 */
export const checkClipboardSupport = (): ClipboardSupport => {
  const isSecureContext = typeof window !== 'undefined' && window.isSecureContext;
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;

  return {
    writeText: isSecureContext && !!clipboard && typeof clipboard.writeText === 'function',
    readText: isSecureContext && !!clipboard && typeof clipboard.readText === 'function',
    isSecureContext,
  };
};

/**
 * Checks whether writing to the clipboard is supported.
 */
export const isWriteSupported = (): boolean => {
  return checkClipboardSupport().writeText;
};

/**
 * Checks whether reading from the clipboard is supported.
 */
export const isReadSupported = (): boolean => {
  return checkClipboardSupport().readText;
};

/**
 * Gets an error message when the clipboard operation is not supported.
 */
export const getClipboardErrorMessage = (
  operation: 'read' | 'write',
  language: AppLanguage = getCurrentAppLanguage()
): string => {
  const t = makeT(language, 'app');
  const support = checkClipboardSupport();

  if (!support.isSecureContext) {
    return t('clipboardUtils.clipboard-requires-https-protocol');
  }

  if (operation === 'write' && !support.writeText) {
    return t('clipboardUtils.your-browser-does-not-support-clipboard-write-pl');
  }

  if (operation === 'read' && !support.readText) {
    return t('clipboardUtils.your-browser-does-not-support-clipboard-read-ple');
  }

  return t('clipboardUtils.clipboard-operation-failed-please-check-browser');
};

/**
 * Safe clipboard write function with compatibility checks and fallback mechanism.
 */
export const safeWriteText = async (text: string): Promise<{ success: boolean; error?: string }> => {
  const support = checkClipboardSupport();

  if (!support.writeText) {
    // Try fallback mechanism (execCommand)
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-999999px';
      textarea.style.top = '-999999px';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();

      const success = document.execCommand('copy');
      document.body.removeChild(textarea);

      if (success) {
        return { success: true };
      }
    } catch {
      // Fallback failed, return error
    }

    return {
      success: false,
      error: getClipboardErrorMessage('write'),
    };
  }

  try {
    await navigator.clipboard.writeText(text);
    return { success: true };
  } catch {
    return {
      success: false,
      error: getClipboardErrorMessage('write'),
    };
  }
};

/**
 * Safe clipboard read function with compatibility checks.
 */
export const safeReadText = async (): Promise<{ success: boolean; text?: string; error?: string }> => {
  const support = checkClipboardSupport();

  if (!support.readText) {
    return {
      success: false,
      error: getClipboardErrorMessage('read'),
    };
  }

  try {
    const text = await navigator.clipboard.readText();
    return { success: true, text };
  } catch {
    return {
      success: false,
      error: getClipboardErrorMessage('read'),
    };
  }
};import type { AppLanguage } from '../i18n/languages';

