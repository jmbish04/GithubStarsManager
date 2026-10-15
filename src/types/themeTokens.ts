/**
 * Types for Theme Tokens (Development Guidelines §14).
 *
 * User preferences store only these declarative data points, reflected onto `<html>` CSS variables and `data-*` attributes;
 * components do not depend on any DOM selectors, nor do they accept injected HTML / JS / React components.
 */

export type ThemeRadius = 'default' | 'none' | 'small' | 'medium' | 'large';

/** reduced = reduced motion; enhanced currently has no applicable targets to enhance, omitted for now. */
export type ThemeAnimation = 'normal' | 'reduced';

export interface ThemeTokens {
  /** `#rrggbb`; null means follow the theme preset's primary color. */
  accentColor: string | null;
  /** Root font scale; 1 means no override. */
  fontScale: number;
  /** default means follow the theme preset's --radius. */
  radius: ThemeRadius;
  animation: ThemeAnimation;
}
