let alwaysStatusBubblesEnabled = true
let eventBubblesEnabled = true

export function setAlwaysStatusBubblesEnabled(enabled: boolean): void {
  alwaysStatusBubblesEnabled = enabled
}

export function isAlwaysStatusBubblesEnabled(): boolean {
  return alwaysStatusBubblesEnabled
}

export function setEventBubblesEnabled(enabled: boolean): void {
  eventBubblesEnabled = enabled
}

export function isEventBubblesEnabled(): boolean {
  return eventBubblesEnabled
}

// Backward-compatible aliases
export function setSpeechBubblesEnabled(enabled: boolean): void {
  setAlwaysStatusBubblesEnabled(enabled)
}

export function isSpeechBubblesEnabled(): boolean {
  return isAlwaysStatusBubblesEnabled()
}
