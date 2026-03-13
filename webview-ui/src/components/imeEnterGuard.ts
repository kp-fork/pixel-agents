export interface ImeEnterGuardState {
  composing: boolean
  pendingAfterCompositionEnd: boolean
  lastCompositionEndAtMs: number
}

const DEFAULT_TAIL_WINDOW_MS = 80

export function createImeEnterGuardState(): ImeEnterGuardState {
  return {
    composing: false,
    pendingAfterCompositionEnd: false,
    lastCompositionEndAtMs: 0,
  }
}

export function markCompositionStart(state: ImeEnterGuardState): void {
  state.composing = true
  state.pendingAfterCompositionEnd = false
}

export function markCompositionEnd(
  state: ImeEnterGuardState,
  nowMs = Date.now(),
): void {
  state.composing = false
  state.pendingAfterCompositionEnd = true
  state.lastCompositionEndAtMs = nowMs
}

export function shouldConsumeImeTailEnter(
  state: ImeEnterGuardState,
  key: string,
  isComposing: boolean,
  nowMs = Date.now(),
  tailWindowMs = DEFAULT_TAIL_WINDOW_MS,
): boolean {
  if (isComposing) return false
  if (!state.pendingAfterCompositionEnd) return false

  const elapsedMs = nowMs - state.lastCompositionEndAtMs
  const withinTailWindow = elapsedMs >= 0 && elapsedMs <= tailWindowMs

  if (key === 'Enter' && withinTailWindow) {
    state.pendingAfterCompositionEnd = false
    return true
  }

  // First non-composing key event after composition end clears the guard.
  state.pendingAfterCompositionEnd = false
  return false
}
