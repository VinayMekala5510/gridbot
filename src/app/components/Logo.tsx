import { useId } from "react";

/** Gridbot mark: a peacock feather. Keep in sync with src/app/icon.svg (browser tab icon). */
export function Logo({ size = 30 }: { size?: number }) {
  const mask = `barbs-${useId().replace(/:/gu, "")}`;
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <mask id={mask}>
          <rect width="64" height="64" fill="#fff" />
          <path d="M17 39 C22 37.5 25.5 34 27 30 M17 30 C20.5 28.5 22.5 25.5 23.5 22 M20.5 18 C23 16.5 24.5 14 25.5 11 M47 39 C42 37.5 38.5 34 37 30 M47 30 C43.5 28.5 41.5 25.5 40.5 22 M43.5 18 C41 16.5 39.5 14 38.5 11" fill="none" stroke="#000" strokeWidth="1.7" strokeLinecap="round" />
        </mask>
      </defs>
      <g transform="rotate(16 32 32)">
        <path d="M31.6 62 C30.8 54 31 46 32.2 38" fill="none" stroke="#0f6b2c" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M31 47 C26.5 46.5 21.5 44 18 40.5 M31.2 52 C27 51.5 23 49.5 20 46.5 M31.4 56.5 C28 56 25 54.5 22.5 52.5" fill="none" stroke="#7a5a2e" strokeWidth="1.9" strokeLinecap="round" />
        <path d="M32.6 47 C37.5 46.5 42.5 44 46 40.5 M32.4 52 C36.6 51.5 40.6 49.5 43.6 46.5 M32.2 56.5 C35.6 56 38.6 54.5 41 52.5" fill="none" stroke="#6b4e27" strokeWidth="1.9" strokeLinecap="round" />
        <path mask={`url(#${mask})`} d="M33 1 C34 6 46 13 46 28 C46 38.5 39.5 44.5 32 47.5 C24.5 44.5 18 38.5 18 28 C18 15 27.5 9 33 1 Z" fill="#17853c" />
        <ellipse cx="32" cy="23" rx="8.6" ry="11" fill="#8a5a1c" />
        <ellipse cx="32" cy="23.6" rx="6.4" ry="8.3" fill="#1c2a86" />
        <ellipse cx="32" cy="24.2" rx="4.3" ry="5.6" fill="#1e8ae6" />
        <ellipse cx="32" cy="24.6" rx="2.3" ry="2.8" fill="#0a0a0a" />
      </g>
    </svg>
  );
}
