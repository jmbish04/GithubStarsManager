import type { SVGProps } from 'react';

/**
 * simple-icons removed the Windows brand icon starting from v13 per Microsoft trademark guidelines.
 * Here we inline its legacy glyph (path data is CC0-1.0) to ensure Windows uses the same
 * Simple Icons brand icon set alongside other platforms.
 */
export function SiWindows(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M0,0H11.377V11.372H0ZM12.623,0H24V11.372H12.623ZM0,12.623H11.377V24H0Zm12.623,0H24V24H12.623" />
    </svg>
  );
}
