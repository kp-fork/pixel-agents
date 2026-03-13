import assert from 'node:assert/strict'
import {
  createImeEnterGuardState,
  markCompositionEnd,
  markCompositionStart,
  shouldConsumeImeTailEnter,
} from '../webview-ui/src/components/imeEnterGuard.ts'

function run(): void {
  {
    const state = createImeEnterGuardState()
    markCompositionStart(state)
    markCompositionEnd(state, 1_000)
    const consumed = shouldConsumeImeTailEnter(state, 'Enter', false, 1_020)
    assert.equal(consumed, true, 'should consume trailing Enter within tail window')
    assert.equal(state.pendingAfterCompositionEnd, false, 'guard should clear after consume')
  }

  {
    const state = createImeEnterGuardState()
    markCompositionStart(state)
    markCompositionEnd(state, 2_000)
    const first = shouldConsumeImeTailEnter(state, 'Enter', false, 2_030)
    const second = shouldConsumeImeTailEnter(state, 'Enter', false, 2_040)
    assert.equal(first, true, 'first trailing Enter should be consumed')
    assert.equal(second, false, 'second Enter should not be consumed')
  }

  {
    const state = createImeEnterGuardState()
    markCompositionStart(state)
    markCompositionEnd(state, 3_000)
    const consumed = shouldConsumeImeTailEnter(state, 'a', false, 3_020)
    assert.equal(consumed, false, 'non-Enter key should not be consumed')
    assert.equal(state.pendingAfterCompositionEnd, false, 'guard should clear on first regular key')
  }

  {
    const state = createImeEnterGuardState()
    markCompositionStart(state)
    markCompositionEnd(state, 4_000)
    const consumed = shouldConsumeImeTailEnter(state, 'Enter', false, 4_120)
    assert.equal(consumed, false, 'Enter outside tail window should not be consumed')
  }

  {
    const state = createImeEnterGuardState()
    markCompositionStart(state)
    markCompositionEnd(state, 5_000)
    const duringComposition = shouldConsumeImeTailEnter(state, 'Enter', true, 5_010)
    assert.equal(duringComposition, false, 'composing events should not be consumed here')
    assert.equal(state.pendingAfterCompositionEnd, true, 'guard should remain while composing')
    const trailing = shouldConsumeImeTailEnter(state, 'Enter', false, 5_020)
    assert.equal(trailing, true, 'trailing Enter after composing should be consumed')
  }

  console.log('[test-ime-enter-guard] PASS')
}

run()
