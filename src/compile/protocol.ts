import type { CompileState, PdfLocation } from './types';

export interface ViewerState {
    page: number;
    left: number;
    top: number;
    scale: string | number;
    rotation: number;
    scrollMode: number;
    spreadMode: number;
    sidebar: number;
    cursor: number;
}
export type PreviewMessage =
    | { type: 'ready' }
    | { type: 'action'; action: 'compile' | 'stop' | 'log' | 'save' }
    | { type: 'state'; state: ViewerState }
    | { type: 'reverse'; revision: number; page: number; h: number; v: number }
    | { type: 'rendered'; revision: number }
    | { type: 'error'; message: string };
export type HostMessage =
    | { type: 'init'; state?: ViewerState; projectKey?: string }
    | { type: 'pdf'; revision: number; bytes: ArrayBuffer }
    | { type: 'status'; state: CompileState; message: string }
    | { type: 'forward'; revision: number; locations: PdfLocation[] };

export function isViewerState(value: unknown): value is ViewerState {
    if (!value || typeof value !== 'object') return false;
    const state = value as ViewerState;
    return Number.isInteger(state.page) && state.page >= 1 && state.page <= 1_000_000
        && [state.left, state.top].every(number => Number.isFinite(number) && Math.abs(number) < 1e9)
        && (typeof state.scale === 'string' && ['auto', 'page-fit', 'page-width', 'page-height'].includes(state.scale)
            || typeof state.scale === 'number' && state.scale >= 0.1 && state.scale <= 10)
        && [0, 90, 180, 270].includes(state.rotation)
        && [0, 1, 2, 3].includes(state.scrollMode) && [0, 1, 2].includes(state.spreadMode)
        && [0, 1, 2, 3, 4].includes(state.sidebar) && [0, 1].includes(state.cursor);
}
