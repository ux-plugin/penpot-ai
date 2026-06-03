/**
 * Prevents infinite loops in two-way selection sync.
 * When we programmatically set Figma selection, we set a flag to ignore
 * the resulting selectionchange event.
 */
let ignoreNextSelectionChange = false;

export function markIgnoreNextSelectionChange(): void {
  ignoreNextSelectionChange = true;
}

export function shouldIgnoreSelectionChange(): boolean {
  if (ignoreNextSelectionChange) {
    ignoreNextSelectionChange = false;
    return true;
  }
  return false;
}
