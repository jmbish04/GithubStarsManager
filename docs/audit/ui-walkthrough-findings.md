# UI Walkthrough Notes

## Repositories page (production preview)

The production preview has switched to the default shadcn semantic color system. The page background, cards, toolbar, inputs, sidebar, and sorter use the background/card/muted/accent/border variables. Unselected categories are transparent, and the current category keeps the secondary active state.

The first screenshot showed that the AI search button in its disabled (empty query) state had low text contrast: gray text, because the old `.ui-button-primary` CSS overrode shadcn's `text-primary-foreground`. `.ui-button-primary` and `.btn-primary` now use `hsl(var(--primary))` and `hsl(var(--primary-foreground))`. After the fix, the button label "AI Search" is visible, still correctly disabled for an empty query, and stays inside the search toolbar.

The repositories page currently has no horizontal page overflow. The active/hover layering of the category navigation and the control boundaries in the search toolbar are clear. Still to walk through: the login page, Discovery, Gist, Release, Fork, every settings panel, plus overlays, dropdown menus, tooltips, theme switching, and keyboard interaction.

## Settings page and AI configuration page

On the General settings page, the sidebar Tabs, language RadioGroup, update button, and contact button have a clear hierarchy, and the card borders and muted backgrounds match the shadcn structure. The empty-state card on the AI configuration page is structurally fine, but the walkthrough found that the "Add AI Configuration" button and the primary action buttons on several settings pages still explicitly combined `bg-primary text-white`. In the default shadcn dark theme, primary is a light color, which made the text unreadable. These were replaced in bulk with `text-primary-foreground`, and destructive actions with `text-destructive-foreground`. A rebuild for re-checking is next.

After rebuilding and refreshing, the label, icon, and background of the "Add AI Configuration" button on the AI configuration page are all visible, confirming that the `text-primary-foreground` fix works. Next up is testing the Select, Slider, Checkbox, RadioGroup, save, and cancel interactions in the new configuration form.

The API format Radix Select in the new AI configuration form opened successfully. The popup uses the card/popover background, border, and shadow, with a clearly checked item, and the option list does not overflow the form boundary. Still to verify: switching options, the Checkbox, and cancel.

Interaction re-test: after switching the Select from OpenAI Chat Completions to OpenAI Responses, the endpoint preview URL updated to `/responses`, showing the form behavior is still correct. After checking "Use custom prompt", the Radix Checkbox shows its checked state, the default prompt is filled into the Textarea automatically, the "Restore default prompt" button appears, and the Textarea is visible with no layout overflow.

The Slider re-test showed that the Radix Slider's aria value starts at `1`, with a range of `1–10`. A real interaction regression test was added in `src/components/ui/SliderInput.test.tsx`. The pointer path uses userEvent to hit the actual Radix `Slider.Root` precisely (the root with `data-orientation="horizontal"` and `relative flex w-full`). With the mocked Root width at 100 and a click at clientX=60, `aria-valuenow` changed from `1` to `6`. On the keyboard path, after focusing the thumb and sending ArrowRight, `aria-valuenow` changed from `1` to `2`. Both tests pass with no React/Radix warnings.

The Slider DOM inspection confirmed that the Radix Root is `relative flex w-full`, the track uses `h-2 bg-secondary`, and the thumb uses shadcn's `h-5 w-5 border-2 border-primary bg-background`. The regression test finds this Root through semantic selectors, so both the component structure and the pointer/keyboard user paths are verified.

After canceling a new AI configuration, the page returns to its empty state and no unsaved content is left behind. On the empty-state WebDAV page, the primary button, card, icon, and hint text are all visible with no layout overflow. After switching, every settings Tab keeps a consistent active state.

Backup and restore panel walkthrough: when WebDAV is not configured, the backup and restore buttons are correctly disabled and shown in the muted state. After clicking the "Include secrets" Switch, the thumb and track update correctly, and neither the card nor the description area overflows.
