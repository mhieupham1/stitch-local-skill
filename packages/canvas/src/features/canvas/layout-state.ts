import type { ScreenLayoutPatch } from '../../../../core/src/schema.js';
export type SaveState = 'saved' | 'saving' | 'unsaved';
export type PendingLayout = { patch: ScreenLayoutPatch; revision: number } | null;
