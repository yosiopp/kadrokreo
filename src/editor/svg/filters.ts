import { BLEND_MODES } from '../../document/kdr.ts'
import type { BlendMode } from '../../document/types.ts'
import { parseColor, parseFraction, parseNumbers } from './values.ts'
import type { SvgElement } from './xml.ts'

// SVG の filter を、kadrokreo の効果（落ち影・内側の影・レイヤーのぼかし）として読む。
// 読めるのは次の形の並びだけで、それ以外の部品が 1 つでもあれば読まない（呼び出し側が「フィルタ」を落としたと知らせる）:
// - feDropShadow 1 つ（落ち影）
// - feGaussianBlur 1 つだけ（in が SourceGraphic か省略。レイヤーのぼかし）
// - kadrokreo の SVG の書き出し（document/svgExport.ts の shadow）が書く並び
//   - 落ち影: [feMorphology（in=SourceAlpha、広がり）→] feGaussianBlur（in=SourceAlpha か広がりの結果）→ feOffset → feFlood → feComposite（operator=in）
//   - 内側の影: feFlood → feComposite（operator=out、in2=SourceAlpha）→ [feMorphology（広がり）→] feGaussianBlur → feOffset → feComposite（operator=in、in2=SourceAlpha）
//   広がりは feMorphology の radius（dilate なら正、erode なら負）
// - 終わりの feMerge（重ねる順は読まない。落ち影は元の絵の下、内側の影は上に描く決まりなので）
// - 既存のデザインツールの書き出しの並び（先頭が feFlood result="BackgroundImageFix"。readBackgroundFixFilter）
//   - 影ごとに: feColorMatrix（in=SourceAlpha、不透明にする）→ [feMorphology（広がり）→] feOffset → feGaussianBlur →
//     feComposite（operator=out なら落ち影、arithmetic k2=-1 k3=1 なら内側の影）→ feColorMatrix（色と濃さ）→ feBlend（mode が影の描画モード）
//   - 元の絵を重ねる feBlend（in=SourceGraphic）は読み飛ばし、影の外の feGaussianBlur はレイヤーのぼかし
// ずれとぼかしは filter をかけた要素の座標系の値のまま返す（ページの向きと大きさに直すのは呼び出し側）。

type FilterShadow = {
  type: 'drop-shadow' | 'inner-shadow'
  dx: number
  dy: number
  /** ガウスぼかしの標準偏差（kadrokreo のぼかしはこの 2 倍） */
  stdDeviation: number
  /** 広がり（feMorphology の radius。細らせるなら負） */
  spread: number
  color: string
  opacity: number
  /** 影の描画モード（既存のデザインツールの書き出しの feBlend の mode。ほかは normal） */
  blendMode: BlendMode
}

/** レイヤーのぼかし */
type FilterBlur = { type: 'layer-blur'; stdDeviation: number }

type FilterEffect = FilterShadow | FilterBlur

/** 要素の属性や CSS を重ねた値を返す関数（flood-color は CSS でも書ける） */
type Declared = (element: SvgElement) => Record<string, string>

/** filter の中身を影の並びにする。読めない部品があれば null */
export function readShadowFilter(filter: SvgElement, declared: Declared): FilterEffect[] | null {
  const parts = filter.children.filter((child): child is SvgElement => typeof child !== 'string')
  if (parts[0]?.name === 'feFlood' && parts[0].attributes.result?.trim() === 'BackgroundImageFix') return readBackgroundFixFilter(parts.slice(1))
  // ぼかし 1 つだけならレイヤーのぼかし
  if (parts.length === 1 && parts[0].name === 'feGaussianBlur' && ['', 'SourceGraphic'].includes(parts[0].attributes.in?.trim() ?? '')) {
    const stdDeviation = deviationOf(parts[0].attributes.stdDeviation, 0)
    return stdDeviation > 0 ? [{ type: 'layer-blur', stdDeviation }] : null
  }
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
        spread: 0,
        ...flood,
        blendMode: 'normal',
      })
      i += 1
    } else if (is(0, 'feMorphology', { in: 'SourceAlpha' }) || is(0, 'feGaussianBlur', { in: 'SourceAlpha' })) {
      // 落ち影。先頭に広がりの feMorphology があれば読み飛ばして数える
      const spread = parts[i].name === 'feMorphology' ? morphologyOf(parts[i]) : 0
      if (spread === null) return null
      const k = parts[i].name === 'feMorphology' ? i + 1 : i
      const at = (offset: number, name: string, attributes: Record<string, string> = {}) => is(k - i + offset, name, attributes)
      if (!(at(0, 'feGaussianBlur') && at(1, 'feOffset') && at(2, 'feFlood') && at(3, 'feComposite', { operator: 'in' }))) return null
      const flood = floodOf(parts[k + 2], declared)
      if (!flood) return null
      shadows.push({
        type: 'drop-shadow',
        dx: numberOf(parts[k + 1].attributes.dx, 0),
        dy: numberOf(parts[k + 1].attributes.dy, 0),
        stdDeviation: deviationOf(parts[k].attributes.stdDeviation, 0),
        spread,
        ...flood,
        blendMode: 'normal',
      })
      i = k + 4
    } else if (is(0, 'feFlood') && is(1, 'feComposite', { operator: 'out', in2: 'SourceAlpha' })) {
      // 内側の影。ぼかしの前に広がりの feMorphology があれば数える
      const morph = is(2, 'feMorphology')
      const spread = morph ? morphologyOf(parts[i + 2]) : 0
      if (spread === null) return null
      const k = morph ? i + 1 : i
      if (!(is(k - i + 2, 'feGaussianBlur') && is(k - i + 3, 'feOffset') && is(k - i + 4, 'feComposite', { operator: 'in', in2: 'SourceAlpha' }))) {
        return null
      }
      const flood = floodOf(parts[i], declared)
      if (!flood) return null
      shadows.push({
        type: 'inner-shadow',
        dx: numberOf(parts[k + 3].attributes.dx, 0),
        dy: numberOf(parts[k + 3].attributes.dy, 0),
        stdDeviation: deviationOf(parts[k + 2].attributes.stdDeviation, 0),
        spread,
        ...flood,
        blendMode: 'normal',
      })
      i = k + 5
    } else if (part.name === 'feMerge' && i === parts.length - 1) {
      i += 1
    } else return null
  }
  return shadows.length > 0 ? shadows : null
}

/** 既存のデザインツールの書き出しの filter（先頭の feFlood を除いた並び）を読む。読めない部品があれば null */
function readBackgroundFixFilter(parts: readonly SvgElement[]): FilterEffect[] | null {
  const effects: FilterEffect[] = []
  // 読みかけの影。morph は feMorphology の向きのまま（dilate が正）
  let pending: {
    type?: FilterShadow['type']
    morph: number
    dx: number
    dy: number
    stdDeviation: number
    color?: { color: string; opacity: number }
  } | null = null
  for (const part of parts) {
    const a = part.attributes
    const input = a.in?.trim() ?? ''
    switch (part.name) {
      case 'feColorMatrix': {
        if (input === 'SourceAlpha') {
          if (pending) return null
          pending = { morph: 0, dx: 0, dy: 0, stdDeviation: 0 }
          break
        }
        if (!pending) return null
        const values = parseNumbers(a.values)
        if ((a.type?.trim() ?? 'matrix') !== 'matrix' || values?.length !== 20 || !values.every(Number.isFinite)) return null
        const channel = (row: number) => Math.round(Math.min(1, Math.max(0, values[row * 5 + 4])) * 255).toString(16).padStart(2, '0')
        pending.color = { color: `#${channel(0)}${channel(1)}${channel(2)}`, opacity: Math.min(1, Math.max(0, values[18])) }
        break
      }
      case 'feMorphology': {
        const morph = pending ? morphologyOf(part) : null
        if (morph === null || !pending) return null
        pending.morph = morph
        break
      }
      case 'feOffset':
        if (!pending) return null
        pending.dx = numberOf(a.dx, 0)
        pending.dy = numberOf(a.dy, 0)
        break
      case 'feGaussianBlur': {
        if (pending) {
          pending.stdDeviation = deviationOf(a.stdDeviation, 0)
          break
        }
        // 影の外のぼかしは、元の絵（shape）のぼかし
        if (input !== '' && input !== 'shape' && input !== 'SourceGraphic') return null
        const stdDeviation = deviationOf(a.stdDeviation, 0)
        if (stdDeviation > 0) effects.push({ type: 'layer-blur', stdDeviation })
        break
      }
      case 'feComposite': {
        if (!pending || pending.type) return null
        const operator = a.operator?.trim()
        if (operator === 'out') pending.type = 'drop-shadow'
        else if (operator === 'arithmetic' && numberOf(a.k2, 0) === -1 && numberOf(a.k3, 0) === 1) pending.type = 'inner-shadow'
        else return null
        break
      }
      case 'feBlend': {
        if (!pending) {
          // 元の絵を重ねるもの
          if (input !== 'SourceGraphic') return null
          break
        }
        if (!pending.type || !pending.color) return null
        const mode = (a.mode?.trim() ?? 'normal') as BlendMode
        effects.push({
          type: pending.type,
          dx: pending.dx,
          dy: pending.dy,
          stdDeviation: pending.stdDeviation,
          // 内側の影の広がりは、形を細らせて（erode）書かれる
          spread: pending.type === 'inner-shadow' ? -pending.morph : pending.morph,
          ...pending.color,
          blendMode: BLEND_MODES.includes(mode) ? mode : 'normal',
        })
        pending = null
        break
      }
      default:
        return null
    }
  }
  return pending === null && effects.length > 0 ? effects : null
}

/** flood-color と flood-opacity（色の alpha も濃さに掛ける）。読めない色なら null */
function floodOf(element: SvgElement, declared: Declared): { color: string; opacity: number } | null {
  const style = declared(element)
  const color = parseColor((style['flood-color'] ?? 'black').trim())
  if (!color) return null
  const opacity = Math.min(1, Math.max(0, parseFraction(style['flood-opacity']) ?? 1))
  return { color: color.color, opacity: color.alpha * opacity }
}

/** feMorphology の広がり（dilate は正、erode は負）。読めなければ null */
function morphologyOf(element: SvgElement): number | null {
  const operator = element.attributes.operator?.trim() ?? 'erode'
  if (operator !== 'dilate' && operator !== 'erode') return null
  const radius = deviationOf(element.attributes.radius, 0)
  return operator === 'dilate' ? radius : -radius
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
