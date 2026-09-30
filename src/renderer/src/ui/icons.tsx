// Small inline SVG icon set (Figma-like line icons), 16px, stroke = currentColor.
const base = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const Icon = {
  move: () => (
    <svg {...base}>
      <path d="M3.5 2.5l9 5.2-4.2 1.1-2.2 3.8z" fill="currentColor" stroke="none" />
    </svg>
  ),
  hand: () => (
    <svg {...base}>
      <path d="M6 8V3.5a1 1 0 012 0V8M8 7.5V3a1 1 0 012 0v5M10 8V4.5a1 1 0 012 0V10a4 4 0 01-4 4H7.5a3 3 0 01-2.5-1.3L3 9.6a1 1 0 011.6-1.2L6 10V6.5a1 1 0 012 0" />
    </svg>
  ),
  frame: () => (
    <svg {...base}>
      <path d="M5 2v12M11 2v12M2 5h12M2 11h12" />
    </svg>
  ),
  rect: () => (
    <svg {...base}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
    </svg>
  ),
  text: () => (
    <svg {...base}>
      <path d="M3 3h10M8 3v10M6 13h4" />
    </svg>
  ),
  nineSlice: () => (
    <svg {...base}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <path d="M6 2.5v11M10 2.5v11M2.5 6h11M2.5 10h11" strokeDasharray="1.5 1.5" />
    </svg>
  ),
  undo: () => (
    <svg {...base}>
      <path d="M6 4L3 7l3 3M3 7h6.5a3.5 3.5 0 010 7H8" />
    </svg>
  ),
  redo: () => (
    <svg {...base}>
      <path d="M10 4l3 3-3 3M13 7H6.5a3.5 3.5 0 000 7H8" />
    </svg>
  ),
  play: () => (
    <svg {...base}>
      <path d="M4 3l9 5-9 5z" fill="currentColor" stroke="none" />
    </svg>
  ),
  gear: () => (
    <svg {...base}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2" />
    </svg>
  ),
  menu: () => (
    <svg {...base}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </svg>
  ),
  chevron: () => (
    <svg {...base}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  ),
  eye: () => (
    <svg {...base}>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  ),
  eyeOff: () => (
    <svg {...base}>
      <path d="M2 2l12 12M6.3 6.4A2 2 0 009.6 9.7M4.6 4.7C2.7 5.9 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1.3 0 2.5-.4 3.5-1M7 3.6c.3 0 .7-.1 1-.1 4 0 6.5 4.5 6.5 4.5s-.6 1.1-1.7 2.3" />
    </svg>
  ),
  lock: () => (
    <svg {...base}>
      <rect x="3.5" y="7" width="9" height="7" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </svg>
  ),
  unlock: () => (
    <svg {...base}>
      <rect x="3.5" y="7" width="9" height="7" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 014.9-.6" />
    </svg>
  ),
  plus: () => (
    <svg {...base}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  ),
  image: () => (
    <svg {...base}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <path d="M2.5 11l3-3 2.5 2.5 2-2 3.5 3.5" />
      <circle cx="10.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  group: () => (
    <svg {...base}>
      <rect x="2.5" y="2.5" width="6" height="6" rx="0.5" />
      <rect x="7.5" y="7.5" width="6" height="6" rx="0.5" />
    </svg>
  ),
  instance: () => (
    <svg {...base}>
      <path d="M8 2.5l5.5 5.5L8 13.5 2.5 8z" />
    </svg>
  ),
  component: () => (
    <svg {...base}>
      <path d="M8 2l2.2 2.2L8 6.4 5.8 4.2zM11.8 5.8L14 8l-2.2 2.2L9.6 8zM4.2 5.8L6.4 8l-2.2 2.2L2 8zM8 9.6l2.2 2.2L8 14l-2.2-2.2z" fill="currentColor" stroke="none" />
    </svg>
  ),
  zoomIn: () => (
    <svg {...base}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14M5 7h4M7 5v4" />
    </svg>
  ),
  zoomOut: () => (
    <svg {...base}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14M5 7h4" />
    </svg>
  )
}

export type IconName = keyof typeof Icon
