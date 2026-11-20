const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'color', 'range', 'button', 'file'])

/** 文字入力を受け付ける要素か。キーボードショートカットを横取りしない判定に使う */
export function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(target.type)
  return target.isContentEditable || /^(TEXTAREA|SELECT)$/.test(target.tagName)
}
