import {
  isAlwaysStatusBubblesEnabled,
  isEventBubblesEnabled,
  setAlwaysStatusBubblesEnabled,
  setEventBubblesEnabled,
  setSpeechBubblesEnabled,
} from '../webview-ui/src/speechBubbles.js';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`[test-bubble-settings] ${message}`);
}

setAlwaysStatusBubblesEnabled(true);
setEventBubblesEnabled(true);

setAlwaysStatusBubblesEnabled(false);
assert(isAlwaysStatusBubblesEnabled() === false, 'always-status should be false after explicit disable');
assert(isEventBubblesEnabled() === true, 'event-bubbles should remain true when always-status changes');

setEventBubblesEnabled(false);
assert(isEventBubblesEnabled() === false, 'event-bubbles should be false after explicit disable');
assert(isAlwaysStatusBubblesEnabled() === false, 'always-status should remain false when event-bubbles changes');

setSpeechBubblesEnabled(true);
assert(isAlwaysStatusBubblesEnabled() === true, 'legacy setter should map to always-status toggle');
assert(isEventBubblesEnabled() === false, 'legacy setter must not overwrite event-bubbles toggle');

console.log('[test-bubble-settings] PASS');
