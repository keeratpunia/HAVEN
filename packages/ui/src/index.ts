/**
 * @haven/ui
 *
 * Design tokens (SDD §13.2: color, type, spacing, shape, touch-target scales).
 * Cross-platform shared primitives (Button, StatusChip, etc. — SDD §13.5) are built
 * directly in each app for now (see docs/DECISIONS.md) rather than here, to avoid
 * taking on this package's React/React Native peer-dependency wiring within the guest
 * web milestone's scope; this package stays the single source of token *values*.
 */

export const HAVEN_UI_SCAFFOLD_VERSION = '0.0.0';

export * from './tokens.js';
