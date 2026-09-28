// Inline stroke icons. Drawn at 16px on a 24px viewBox so a single set stays
// crisp at every size the chrome uses. Kept local instead of pulling in an icon
// package: the shell only needs a handful, and this keeps the bundle free of a
// dependency that would ship thousands of unused glyphs.
type IconProps = { size?: number };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export const IconChevronLeft = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M15 18l-6-6 6-6" /></svg>
);
export const IconChevronRight = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M9 18l6-6-6-6" /></svg>
);
export const IconMenu = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M3 6h18M3 12h18M3 18h18" /></svg>
);
export const IconLayers = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M12 2l9 5-9 5-9-5 9-5z" /><path d="M3 12l9 5 9-5" /><path d="M3 17l9 5 9-5" /></svg>
);
export const IconPlus = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconCamera = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" /><circle cx="12" cy="13" r="4" /></svg>
);
// Figma's mark is a stack of rounded shapes; drawn as a filled glyph because the
// logo reads as a solid form rather than a stroked outline.
export const IconFigma = ({ size = 16 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8.5 2A3.5 3.5 0 0 0 8.5 9H12V2H8.5Z" />
    <path d="M12 2v7h3.5a3.5 3.5 0 1 0 0-7H12Z" />
    <path d="M8.5 9a3.5 3.5 0 1 0 0 7H12V9H8.5Z" />
    <path d="M12 9v7h3.5a3.5 3.5 0 1 0 0-7H12Z" />
    <path d="M8.5 16A3.5 3.5 0 1 0 12 19.5V16H8.5Z" />
  </svg>
);
export const IconCopy = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
);
export const IconTrash = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" /><path d="M10 11v6M14 11v6" /></svg>
);
export const IconGrid = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
);
export const IconMove = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20" /></svg>
);
export const IconCursor = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M3 3l7.5 18 2.5-7 7-2.5L3 3z" /></svg>
);
export const IconHand = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M18 11V6a2 2 0 00-4 0v5M14 10V4a2 2 0 00-4 0v6M10 10.5V6a2 2 0 00-4 0v8" /><path d="M18 8a2 2 0 114 0v6a8 8 0 01-8 8h-2a8 8 0 01-8-8" /></svg>
);
export const IconCamera2 = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" /></svg>
);
export const IconDownload = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><path d="M7 10l5 5 5-5M12 15V3" /></svg>
);
export const IconRotateCcw = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M3 3v6h6" /><path d="M3.5 9a9 9 0 101.6-3" /></svg>
);
export const IconMaximize = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M16 21h3a2 2 0 002-2v-3M8 21H5a2 2 0 01-2-2v-3" /></svg>
);
export const IconMinus = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M5 12h14" /></svg>
);
export const IconCheck = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M20 6L9 17l-5-5" /></svg>
);
export const IconLoader = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M12 2v4M12 18v4M4.9 4.9l2.9 2.9M16.2 16.2l2.9 2.9M2 12h4M18 12h4M4.9 19.1l2.9-2.9M16.2 7.8l2.9-2.9" /></svg>
);
export const IconAlert = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" /></svg>
);
export const IconX = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><path d="M18 6L6 18M6 6l12 12" /></svg>
);
export const IconMonitor = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
);
