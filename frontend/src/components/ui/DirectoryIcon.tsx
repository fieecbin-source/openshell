import { useId, type SVGProps } from "react";

/** Blue folder artwork shared by the SFTP list, breadcrumbs and empty state. */
export function DirectoryIcon(props: SVGProps<SVGSVGElement>) {
  const id = useId();
  return (
    <svg viewBox="0 0 32 26" fill="none" aria-hidden="true" {...props}>
      <defs>
        <linearGradient id={`${id}-back`} x1="16" y1="1" x2="16" y2="25" gradientUnits="userSpaceOnUse"><stop stopColor="#7DD7FF" /><stop offset="1" stopColor="#2693DF" /></linearGradient>
        <linearGradient id={`${id}-front`} x1="16" y1="8" x2="16" y2="25" gradientUnits="userSpaceOnUse"><stop stopColor="#80DAFF" /><stop offset="1" stopColor="#40AFF0" /></linearGradient>
      </defs>
      <path d="M2 5a3 3 0 0 1 3-3h7l3 3h12a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5Z" fill={`url(#${id}-back)`} />
      <path d="M4 8h24v12H4z" fill="#D7F2FF" />
      <rect x="1" y="9" width="30" height="16" rx="3" fill={`url(#${id}-front)`} />
      <path d="M4 10h24" stroke="white" strokeOpacity=".45" strokeLinecap="round" />
    </svg>
  );
}
