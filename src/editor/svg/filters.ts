import { parseColor, parseFraction, parseNumbers } from './values.ts'
import type { SvgElement } from './xml.ts'

// SVG の filter を、kadrokreo の影（落ち影・内側の影）として読む。
// 読めるのは次の形の並びだけで、それ以外の部品が 1 つでもあれば読まない（呼び出し側が「フィルタ」を落としたと知らせる）:
// - feDropShadow 1 つ（落ち影）
// - kadrokreo の SVG の書き出し（document/svgExport.ts の shadow）が書く並び
//   - 落ち影: feGaussianBlur（in=SourceAlpha）→ feOffset → feFlood → feComposite（operator=in）
//   - 内側の影: feFlood → feComposite（operator=out、in2=SourceAlpha）→ feGaussianBlur → feOffset → feComposite（operator=in、in2=SourceAlpha）
// - 終わりの feMerge（重ねる順は読まない。落ち影は元の絵の下、内側の影は上に描く決まりなので）
// ずれとぼかしは filter をかけた要素の座標系の値のまま返す（ページの向きと大きさに直すのは呼び出し側）。

export type FilterShadow = {
  type: 'drop-shadow' | 'inner-shadow'
  dx: number
  dy: number
  /** ガウスぼかしの標準偏差（kadrokreo のぼかしはこの 2 倍） */
  stdDeviation: number
  color: string
  opacity: number
}

/** 要素の属性や CSS を重ねた値を返す関数（flood-color は CSS でも書ける） */
type Declared = (element: SvgElement) => Record<string, string>

/** filter の中身を影の並びにする。読めない部品があれば null */
export function readShadowFilter(filter: SvgElement, declared: Declared): FilterShadow[] | null {
  const parts = filter.children.filter((child): child is SvgElement => typeof child !== 'string')
  const shadows: FilterShadow[] = []
  let i = 0
  const is = (offset: number, name: string, attributes: Record<string, string> = {}) => {
    const part = parts[i + offset]
    return part?.name === name && Object.entries(attributes).every(([key, value]) => part.attributes[key]?.trim() === value)
  }
  while (i < parts.length) {
    const part = parts[i]
    if (part.name === 'feDropShadow') {
      const a = part.attributes
      const flood = floodOf(part, declared)
      if (!flood) return null
      shadows.push({
        type: 'drop-shadow',
        dx: numberOf(a.dx, 2),
        dy: numberOf(a.dy, 2),
        stdDeviation: deviationOf(a.stdDeviation, 2),
        ...flood,
      })
      i += 1
    } else if (
      is(0, 'feGaussianBlur', { in: 'SourceAlpha' }) &&
      is(1, 'feOffset') &&
      is(2, 'feFlood') &&
      is(3, 'feComposite', { operator: 'in' })
    ) {
      const flood = floodOf(parts[i + 2], declared)
      if (!flood) return null
      shadows.push({
        type: 'drop-shadow',
        dx: numberOf(parts[i + 1].attributes.dx, 0),
        dy: numberOf(parts[i + 1].attributes.dy, 0),
        stdDeviation: deviationOf(parts[i].attributes.stdDeviation, 0),
        ...flood,
      })
      i += 4
    } else if (
      is(0, 'feFlood') &&
      is(1, 'feComposite', { operator: 'out', in2: 'SourceAlpha' }) &&
      is(2, 'feGaussianBlur') &&
      is(3, 'feOffset') &&
      is(4, 'feComposite', { operator: 'in', in2: 'SourceAlpha' })
    ) {
      const flood = floodOf(parts[i], declared)
      if (!flood) return null
      shadows.push({
        type: 'inner-shadow',
        dx: numberOf(parts[i + 3].attributes.dx, 0),
        dy: numberOf(parts[i + 3].attributes.dy, 0),
        stdDeviation: deviationOf(parts[i + 2].attributes.stdDeviation, 0),
        ...flood,
      })
      i += 5
    } else if (part.name === 'feMerge' && i === parts.length - 1) {
      i += 1
    } else return null
  }
  return shadows.length > 0 ? shadows : null
}

/** flood-color と flood-opacity（色の alpha も濃さに掛ける）。読めない色なら null */
function floodOf(element: SvgElement, declared: Declared): { color: string; opacity: number } | null {
  const style = declared(element)
  const color = parseColor((style['flood-color'] ?? 'black').trim())
  if (!color) return null
  const opacity = Math.min(1, Math.max(0, parseFraction(style['flood-opacity']) ?? 1))
  return { color: color.color, opacity: color.alpha * opacity }
}

function numberOf(raw: string | undefined, fallback: number): number {
  const value = parseNumbers(raw)?.[0]
  return value !== undefined && Number.isFinite(value) ? value : fallback
}

/** stdDeviation（横と縦の 2 つなら大きい方）。負なら 0 */
function deviationOf(raw: string | undefined, fallback: number): number {
  const values = parseNumbers(raw)
  if (!values || values.length === 0 || !values.every(Number.isFinite)) return fallback
  return Math.max(0, ...values)
}
