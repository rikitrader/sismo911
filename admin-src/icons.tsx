// Inline SVG icon set (stroke-based, 1.6px, currentColor) — no external deps.
import type { JSX } from 'preact';

type P = JSX.SVGAttributes<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: P & { children: any }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Icon = {
  dashboard: (p: P) => <Svg {...p}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></Svg>,
  users: (p: P) => <Svg {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" /><path d="M17.5 14.4A5.5 5.5 0 0 1 20.5 20" /></Svg>,
  roles: (p: P) => <Svg {...p}><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" /><path d="m9.5 12 1.8 1.8L15 10" /></Svg>,
  permissions: (p: P) => <Svg {...p}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><circle cx="12" cy="15.5" r="1.4" /></Svg>,
  audit: (p: P) => <Svg {...p}><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M5 3h9l6 6v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M8 13h6M8 17h4" /></Svg>,
  login: (p: P) => <Svg {...p}><path d="M15 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3" /><path d="M10 17l5-5-5-5" /><path d="M15 12H3" /></Svg>,
  sessions: (p: P) => <Svg {...p}><rect x="2.5" y="4" width="19" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></Svg>,
  search: (p: P) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></Svg>,
  sun: (p: P) => <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>,
  moon: (p: P) => <Svg {...p}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></Svg>,
  plus: (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>,
  close: (p: P) => <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>,
  chevron: (p: P) => <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>,
  check: (p: P) => <Svg {...p}><path d="m20 6-11 11-5-5" /></Svg>,
  command: (p: P) => <Svg {...p}><path d="M15 6a3 3 0 1 1 3 3h-3V6Zm-6 0a3 3 0 1 0-3 3h3V6Zm6 12a3 3 0 1 0 3-3h-3v3Zm-6 0a3 3 0 1 1-3-3h3v3Z" /><rect x="9" y="9" width="6" height="6" rx="1" /></Svg>,
  arrowLeft: (p: P) => <Svg {...p}><path d="M19 12H5M12 19l-7-7 7-7" /></Svg>,
  more: (p: P) => <Svg {...p}><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></Svg>,
  alert: (p: P) => <Svg {...p}><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 2.4 18a1.8 1.8 0 0 0 1.6 2.7h16a1.8 1.8 0 0 0 1.6-2.7L13.7 3.9a1.8 1.8 0 0 0-3.4 0Z" /></Svg>,
  lock: (p: P) => <Svg {...p}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></Svg>,
  link: (p: P) => <Svg {...p}><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></Svg>,
  copy: (p: P) => <Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></Svg>,
  circle: (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9" /></Svg>,
  collapse: (p: P) => <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></Svg>,
  inbox: (p: P) => <Svg {...p}><path d="M3 13h5l1.5 2.5h5L16 13h5" /><path d="M5 4h14l2 8v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6l2-8Z" /></Svg>,
  org: (p: P) => <Svg {...p}><path d="M3 21h18" /><path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16" /><path d="M15 9h2a2 2 0 0 1 2 2v10" /><path d="M9 7h2M9 11h2M9 15h2" /></Svg>,
  flag: (p: P) => <Svg {...p}><path d="M4 21V4" /><path d="M4 4h13l-2 4 2 4H4" /></Svg>,
  shield: (p: P) => <Svg {...p}><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" /></Svg>,
  key: (p: P) => <Svg {...p}><circle cx="7.5" cy="15.5" r="4" /><path d="m10.5 12.5 8-8" /><path d="m15 8 2.5 2.5M18 5l2.5 2.5" /></Svg>,
  device: (p: P) => <Svg {...p}><rect x="2.5" y="4" width="19" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></Svg>,
  phone: (p: P) => <Svg {...p}><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M11 18.5h2" /></Svg>,
  trash: (p: P) => <Svg {...p}><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /></Svg>,
  refresh: (p: P) => <Svg {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></Svg>,
  download: (p: P) => <Svg {...p}><path d="M12 3v12M7 11l5 5 5-5" /><path d="M5 21h14" /></Svg>,
  unlock: (p: P) => <Svg {...p}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 7.5-2" /></Svg>,
  edit: (p: P) => <Svg {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" /></Svg>,
  plug: (p: P) => <Svg {...p}><path d="M9 2v6M15 2v6" /><path d="M7 8h10v3a5 5 0 0 1-10 0V8Z" /><path d="M12 16v6" /></Svg>,
};

export type IconName = keyof typeof Icon;
