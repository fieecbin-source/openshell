import type { SVGProps } from "react";

/** v1.1.6/v1.1.7 used this whale glyph; keep it inside a stable SVG box. */
export function DockerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <text x="12" y="19" textAnchor="middle" fontSize="20"
        fontFamily="Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif">🐳</text>
    </svg>
  );
}
