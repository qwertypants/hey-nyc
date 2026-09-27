/**
 * Inline SVG icons. No icon font, no dependency, no emoji — every glyph here is a shape we
 * drew, and every one is `aria-hidden` because the accessible name always lives on the
 * control that wraps it, not on the decoration.
 */

import type { JSX } from 'react';

export interface IconProps {
  readonly size?: number;
  readonly className?: string;
}

interface SvgSizeProps {
  readonly width: number;
  readonly height: number;
  readonly className: string | undefined;
}

function svgProps(props: IconProps): SvgSizeProps {
  const size = props.size ?? 18;
  return { width: size, height: size, className: props.className };
}

export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <svg
      {...svgProps(props)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </svg>
  );
}

export function FilterIcon(props: IconProps): JSX.Element {
  return (
    <svg
      {...svgProps(props)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 7h16" />
      <path d="M7 12h10" />
      <path d="M10 17h4" />
    </svg>
  );
}

export function NearMeIcon(props: IconProps): JSX.Element {
  return (
    <svg
      {...svgProps(props)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <svg
      {...svgProps(props)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <svg
      {...svgProps(props)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m4 12.5 5.5 5.5L20 6.5" />
    </svg>
  );
}

export function ListIcon(props: IconProps): JSX.Element {
  return (
    <svg
      {...svgProps(props)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export function MapIcon(props: IconProps): JSX.Element {
  return (
    <svg
      {...svgProps(props)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m3 7 6-3 6 3 6-3v13l-6 3-6-3-6 3Z" />
      <path d="M9 4v13M15 7v13" />
    </svg>
  );
}
