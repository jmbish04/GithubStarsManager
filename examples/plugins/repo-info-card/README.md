# Repo Info Card Example (V1.4 Modal Action)

Transforms a repository's metadata and README into a shareable single-file HTML info card using the host's currently configured AI provider, complete with live preview, code copying, and PNG screenshot copying/saving.

## Installation and Entry Points

1. Go to **Settings → Plugins → Install local plugin**, select this directory, review and grant the required permissions, and enable it.
2. In any repository card's `…` menu, choose **Plugin Actions** → **Generate Repo Info Card**. The host opens this plugin page in a modal dialog (the page targeted by `repositoryActions[].opensPage` in the manifest), dispatching the clicked repository's metadata, README contents, UI language, and theme via `plugin-page:init`.
3. This page can also be accessed from **Settings → Plugins → Open Page**. Because this entry point lacks repository context, the page provides a search box to choose a repository via `repositories.search` / `repositories.get` (in this case without a README, using metadata only).

## Page Layout and Control Styling

The page uses a two-column layout: the left column is the configuration panel (repository info, style/canvas/card language, generate button, and status bar), and the right column is the preview area (zoom bar, canvas, and export actions). On narrower viewports, it automatically collapses into a vertical stack.

Control styling matches the main application: the page includes the same Linear design tokens from `src/index.css` (HSL variables, border radii, borders, and hover/focus states). The modal entry point switches between light and dark modes based on the `theme` provided in `plugin-page:init`, while the settings panel entry point falls back to system preferences when no theme context is available.

## Configuration Options (Card Option Tabs)

All three configuration options are presented as card tabs, matching the interaction pattern used for theme presets in the application's appearance settings: click to select, where the active card displays a primary border, a halo ring, and a checkmark badge in the top-right corner. Arrow keys navigate between cards and synchronize selection.

- **Style**: TE Paper / Dark Instrument / Minimal Monochrome. Each card features a miniature preview rendered with the palette itself. The style only affects the plugin's CSS palette; switching styles does not require calling the AI again.
- **Canvas**: Preset aspect ratios 1:1 (1200×1200), 5:2 (1500×600), and 3:4 (1200×1600), with miniature outlines scaled to the true aspect ratio. A full-width **Custom** card allows specifying arbitrary dimensions (400–3000 px, rounded to integers) via width and height input fields. PNG exports are always @2x.
- **Card Language**: Follows UI language or any i18n-supported language (中文 / English / 日本語 / Español / Português (Brasil) / Русский / 繁體中文 / Français / Deutsch / 한국어), matching `APP_LANGUAGES` in `src/i18n/languages.ts`. Fixed strings on the card (stat labels, spec keys, footer) are localized into the prompt according to the selected language, preventing the model from outputting an entirely English card when facing an all-English template.
- **Additional Notes** (optional): Additional user requirements for the card (≤600 characters, such as "focus on plugin architecture" or "keep headline concise"), injected into the user prompt under a `USER REQUIREMENTS` section. Requirements may guide focus and wording, but cannot bypass output rules or introduce facts beyond repository information. Changes take effect on next generation.

During generation, the button switches to "Generating..." with a spinning indicator, and the status bar leaves its muted gray state to pulse with a breathing animation (respecting system reduced-motion preferences). AI requests require confirmation in a host modal before awaiting network responses, so these feedback cues prevent the UI from appearing frozen.

## Preview: Tab Switching, Zooming, and Panning

The top of the preview area features a segmented "Preview / Code" tab control:

- **Preview**: The rendered info card, supporting the zoom and pan controls described below.
- **Code**: The HTML fragment of the card (sanitized AI output) with syntax highlighting (provided by the plugin's lightweight built-in tokenizer without external dependencies), which can be edited directly. Switching back to "Preview" automatically sanitizes and applies edits, updating the preview. If modified code is missing the `id="card"` root element, focus remains on the code tab and a warning appears in the status bar.
- The "Copy HTML" button always exports the complete, self-contained single-file HTML (including any applied edits).

Above the preview area is the zoom control bar:

- `−` / `+` zooms in steps of 1.25×, clamped between 0.2× and 6× of the "Fit" scale.
- The percentage button and **Fit** reset the scale to fit the viewport.
- **100%** displays the card at actual export pixel size.
- Hold `Ctrl` / `⌘` while scrolling the mouse wheel inside the preview area to zoom.

When the canvas is zoomed larger than the preview viewport, drag with the mouse to pan (cursor changes to a grab hand); touch devices retain native scrolling gestures. Zooming only affects the display scale; exported PNGs are always generated at the canvas @2x dimensions.

## How It Works

- The plugin provides the layout CSS and system prompt (≤2000 characters, bounded by the `ai.generate` parameter limit); the AI only outputs the card body markup. The plugin sanitizes the AI output (removing script/style/img tags, `on*` event attributes, and `javascript:` URLs) and validates the `id="card"` root element.
- **Decoupled canvas and layout**: `data-canvas` controls dimensions (`--w`/`--h`/font sizes/spacing), while `data-layout` (square / banner / portrait) determines structural layout rules. Custom dimensions automatically map to the closest layout based on aspect ratio, scaling font sizes and spacing relative to the 1:1 canvas.
- **Full README in prompt**: With the host's `ai.generate` text limit expanded to 160,000 characters, the README is embedded verbatim (without stripping, rewriting, or summarizing) under `README (full text):`. Only the rare few READMEs exceeding this ceiling are truncated, labeled as `README (full text, truncated at the prompt limit):` and noted in the status bar. The prompt instructs the AI to treat the README as the primary authority, using description and topics only to fill gaps.
- Generated cards remain tied to their canvas size at generation time: switching canvas sizes (or editing custom dimensions) disables screenshot export and displays a status hint to regenerate. Style changes, on the other hand, restyle the card instantly without regeneration.
- Previews render inside shadow DOM to isolate styles from the parent page. **Card styles are injected via Constructable Stylesheets (`adoptedStyleSheets`)** because the page CSP is `style-src plugin-page://<id>` (without `unsafe-inline`). Dynamically inserting `<style>` elements would be blocked, causing cards to revert to browser default styling. Palette variables are attached to `#card` rather than `:root` (which matches nothing in a shadow tree).
- Screenshots are rasterized to @2x PNG via SVG `foreignObject` + `<canvas>` (plain text cards without external dependencies), followed by:
  - `clipboard.writeImage` (permission `clipboard:write`) to copy to clipboard;
  - `downloads.saveFile` (permission `downloads:create`) to open the host native save dialog.
- "Copy HTML" writes the complete standalone HTML document to clipboard via `clipboard.write` (ready to open directly in a browser, with `<html lang>` matching the chosen card language).

This plugin contains no `worker.js`: it is a pure page-type plugin ("page + modal action") that does not spin up a Node Worker.
