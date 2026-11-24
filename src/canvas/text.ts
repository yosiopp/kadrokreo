import type { Size } from '../document/geometry.ts'
import type { TextNode } from '../document/types.ts'
import { hugHeight, hugWidth, wrapLine, wrapWidth } from '../document/textWrap.ts'

export { breakUnits, hugHeight, hugWidth, wrapLine, wrapWidth } from '../document/textWrap.ts'

export type FontStyle = Pick<TextNode, 'fontSize' | 'fontFamily' | 'fontWeight'>
export type TextStyle = FontStyle & Pick<TextNode, 'text' | 'sizing' | 'width' | 'lineHeight' | 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight'>

/** 行の文字列と描画幅。折り返した行の幅には、行末にぶら下がった空白を含めない */
export type TextLine = { text: string; width: number }

// 書体の指定ごとに、実際に代入する文字列（fontFamily が不正なら太さと大きさだけの指定）。
// 毎回 2 回代入すると、同じ指定が続いても Canvas が毎回解析し直す（large の全部の描き直しで約 2ms）。
// 不正かどうかは書き方だけで決まり、書体の読み込みでは変わらないので、捨てずに覚える
const resolvedFonts = new Map<string, string>()
const RESOLVED_FONTS_LIMIT = 1000
const styleFonts = new WeakMap<FontStyle, string>()

/** 書体を ctx に設定し、実際に代入した文字列を返す */
export function applyFont(ctx: CanvasRenderingContext2D, style: FontStyle): string {
  // ノードは不変なので、同じオブジェクトなら代入する文字列も同じ（文字列を組み立てて引く手間も省く）
  const known = styleFonts.get(style)
  if (known !== undefined) {
    ctx.font = known
    return known
  }
  const font = `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`
  const resolved = resolvedFonts.get(font)
  if (resolved !== undefined) {
    styleFonts.set(style, resolved)
    ctx.font = resolved
    return resolved
  }
  // fontFamily が不正だと代入ごと無視されるので、先にサイズと太さだけ確実に反映しておく
  const fallback = `${style.fontWeight} ${style.fontSize}px sans-serif`
  ctx.font = fallback
  const before = ctx.font
  ctx.font = font
  // 代入が効かなかった（または効いても同じ指定になった）なら、次からは太さと大きさだけを代入すれば同じになる
  if (resolvedFonts.size >= RESOLVED_FONTS_LIMIT) resolvedFonts.clear()
  const result = ctx.font === before ? fallback : font
  resolvedFonts.set(font, result)
  styleFonts.set(style, result)
  return result
}

/**
 * フォントの上下の高さ（px）。描画（render.ts）は行の高さの中でこれを真ん中に置いて基線を決める。
 * SVG の書き出しと取り込みも同じ値で基線と枠の上端を行き来する（書き出して取り込み直しても位置がずれない）
 */
export function fontMetrics(ctx: CanvasRenderingContext2D, style: FontStyle): { ascent: number; descent: number } {
  applyFont(ctx, style)
  const metrics = ctx.measureText('')
  return { ascent: metrics.fontBoundingBoxAscent, descent: metrics.fontBoundingBoxDescent }
}

// ノードは不変なので、同じオブジェクトなら行分けの結果も同じ
let layoutCache = new WeakMap<TextStyle, TextLine[]>()
// 行分けは文字と書体と折り返す幅だけで決まるので、それをキーにしても覚える。インスタンスの写しのテキストは
// 別のノードでも中身が同じなので、1 回ずつ測らずに済む（large で開くときの行分けが約 19ms → 数 ms）
const contentCache = new Map<string, TextLine[]>()
/** 中身で覚える数の上限。超えたら全部捨てて覚え直す */
const CONTENT_CACHE_LIMIT = 20_000
// 書体の読み込みが済むと測った幅が変わるので、中身で覚えたものは捨てる（ノードで覚えたものは、ノードの大きさと揃えるため残す）
if (typeof document !== 'undefined') document.fonts?.addEventListener('loadingdone', () => contentCache.clear())

// 書体ごとの上下の高さ。描画ではテキストの数だけ測り（large で約 6,000 回）、書体が同じなら答えも同じなので覚える。
// 書体の読み込みが済むと値が変わるので、そのとき（と forgetTextLayout）は捨てる
const fontBoxes = new Map<string, { ascent: number; descent: number }>()
if (typeof document !== 'undefined') document.fonts?.addEventListener('loadingdone', () => fontBoxes.clear())

/**
 * ctx に設定した書体（font は applyFont が返した文字列）の上下の高さ。textBaseline は alphabetic にしておく
 * （描画の textShape 用。fontMetrics と違い、ctx の書体と textBaseline は呼ぶ側が設定する）
 */
export function fontBox(ctx: CanvasRenderingContext2D, font: string): { ascent: number; descent: number } {
  const cached = fontBoxes.get(font)
  if (cached) return cached
  const metrics = ctx.measureText('')
  const box = { ascent: metrics.fontBoundingBoxAscent, descent: metrics.fontBoundingBoxDescent }
  if (fontBoxes.size >= 1000) fontBoxes.clear()
  fontBoxes.set(font, box)
  return box
}

/**
 * 覚えた行分けを全部捨てる。ドキュメントに埋め込んだ書体が使えるようになったとき（canvas/fonts.ts）に呼ぶ。
 * 埋め込んだ書体で測って決めたテキストの大きさに、行分けを合わせ直すため
 */
export function forgetTextLayout(): void {
  layoutCache = new WeakMap()
  contentCache.clear()
  fontBoxes.clear()
}

/** 描画する行に分ける。折り返す幅（wrapWidth）がなければ改行だけ、あればその幅に収まるよう折り返す */
export function layoutText(ctx: CanvasRenderingContext2D, style: TextStyle): TextLine[] {
  const cached = layoutCache.get(style)
  if (cached) return cached
  const wrapAt = wrapWidth(style)
  const key = `${style.fontWeight}\u0000${style.fontSize}\u0000${style.fontFamily}\u0000${wrapAt}\u0000${style.text}`
  const shared = contentCache.get(key)
  if (shared) {
    layoutCache.set(style, shared)
    return shared
  }

  applyFont(ctx, style)
  const measure = (text: string) => ctx.measureText(text).width
  const paragraphs = style.text.split('\n')
  const lines = wrapAt === null
    ? paragraphs.map((text) => ({ text, width: measure(text) }))
    : paragraphs
        // 詰めのずれは 1 文字ぶんより十分小さいので、文字の大きさを余裕に取る
        .flatMap((paragraph) => wrapLine(paragraph, wrapAt, measure, style.fontSize))
        .map((text) => ({ text, width: measure(text.trimEnd()) }))
  layoutCache.set(style, lines)
  if (contentCache.size >= CONTENT_CACHE_LIMIT) contentCache.clear()
  contentCache.set(key, lines)
  return lines
}

export function measureText(ctx: CanvasRenderingContext2D, style: TextStyle): Size {
  const lines = layoutText(ctx, style)
  const height = Math.max(1, Math.ceil(hugHeight(style, lines.length * style.fontSize * style.lineHeight)))
  if (style.sizing.width !== 'hug') return { width: style.width, height }
  // 行が多いと引数の数の上限を超えるので、Math.max(...lines) にしない
  const width = lines.reduce((max, line) => Math.max(max, line.width), 0)
  return { width: Math.max(1, Math.ceil(hugWidth(style, width))), height }
}
