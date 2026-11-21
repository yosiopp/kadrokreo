import type { NodeId, Scene, TextNode } from '../src/document/types.ts'
import { wrapLine } from '../src/canvas/text.ts'
import { patchNodes } from '../src/editor/operations.ts'

// Node には Canvas がないので、文字の幅は字の種類ごとのおおよその値で見積もる。
// editor で開き直して文字を変えれば、ブラウザで測った正しい大きさに直る。

/** 全角として扱う文字（かな・漢字・ハングル・全角記号など） */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u
const NARROW = /[\s.,:;'"`!|iIjlrtf()[\]{}]/
const UPPER_WIDE = /[MWmw@%]/

/** 1 文字の幅（fontSize に対する割合） */
function charWidth(char: string): number {
  if (WIDE.test(char)) return 1
  if (char === ' ') return 0.28
  if (NARROW.test(char)) return 0.3
  if (UPPER_WIDE.test(char)) return 0.82
  if (/[A-Z0-9]/.test(char)) return 0.64
  return 0.52
}

type Style = Pick<TextNode, 'text' | 'fontSize' | 'fontWeight' | 'autoWidth' | 'width' | 'lineHeight'>

export function estimateTextWidth(text: string, fontSize: number, fontWeight: number): number {
  let total = 0
  for (const char of text) total += charWidth(char)
  return total * fontSize * (fontWeight >= 700 ? 1.06 : 1)
}

/** canvas/text.ts の measureText と同じ決まりで、見積もった幅を使って大きさを出す */
export function estimateTextSize(style: Style): { width: number; height: number } {
  const measure = (text: string) => estimateTextWidth(text, style.fontSize, style.fontWeight)
  const paragraphs = style.text.split('\n')
  const lines = style.autoWidth
    ? paragraphs.map((text) => measure(text))
    : paragraphs.flatMap((paragraph) => wrapLine(paragraph, style.width, measure)).map((text) => measure(text.trimEnd()))
  const height = Math.ceil(lines.length * style.fontSize * style.lineHeight)
  if (!style.autoWidth) return { width: style.width, height }
  return { width: Math.max(1, Math.ceil(Math.max(...lines))), height }
}

/** editor の fitTextNodes の代わり。ストアに FitText として渡す */
export function fitTextEstimated<T extends Scene>(scene: T, ids: readonly NodeId[]): T {
  return patchNodes(scene, ids, (node) => (node.type === 'text' ? estimateTextSize(node) : null))
}
