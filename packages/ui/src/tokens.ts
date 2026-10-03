/**
 * Design tokens (SDD §13.2): "Defined once in packages/ui/tokens.ts; components never
 * use raw values." Light-theme values only — dark theme isn't required by this
 * milestone (guest web, §13.1: "works at 360x640px and on 3G," no dark-mode
 * requirement stated for guests).
 */
export const color = {
  primary: '#0F766E',
  onPrimary: '#FFFFFF',
  success: '#15803D',
  warning: '#B45309',
  danger: '#B91C1C',
  bg: '#FFFFFF',
  surface: '#F8FAFC',
  border: '#E2E8F0',
  text: '#0F172A',
  textMuted: '#475569',
} as const;

/** Scale: 32/24/20/16(body)/14/12. Weights 400, 600. Line height 1.4 (SDD §13.2). */
export const type = {
  size: { xl: 32, lg: 24, md: 20, body: 16, sm: 14, xs: 12 },
  weight: { regular: '400', semibold: '600' } as const,
  lineHeight: 1.4,
};

/** 4, 8, 12, 16, 24, 32. Screen padding 16. Card padding 16. Gap between cards 12. */
export const space = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 32 };
export const screenPadding = space.md;
export const cardPadding = space.md;
export const cardGap = space.sm;

/** Radius 12 for cards/buttons, 999 for chips. Touch targets >=48x48. Primary buttons full width, 52 high. */
export const shape = { radius: 12, chipRadius: 999 };
export const touchTarget = 48;
export const primaryButtonHeight = 52;
