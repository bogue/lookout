const STEP = 0.15 // of the viewport
const MIN_PX = 400
const MAX_RATIO = 0.9

// Cmd+←/→ resize step: ±15% of the viewport, clamped to [400px, 90% of the viewport]
export const stepPanelWidth = (width: number, dir: 1 | -1, viewport: number) =>
  Math.min(Math.max(width + dir * viewport * STEP, MIN_PX), viewport * MAX_RATIO)

// true when typing there, so shortcuts should leave the key alone (e.g. Cmd+← moves the caret)
export const isTextField = (el: Element | null) =>
  !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || (el as HTMLElement).isContentEditable)
