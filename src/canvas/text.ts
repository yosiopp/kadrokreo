import type { Size } from '../document/geometry.ts'
import type { TextNode } from '../document/types.ts'

type FontStyle = Pick<TextNode, 'fontSize' | 'fontFamily' | 'fontWeight'>
export type TextStyle = FontStyle & Pick<TextNode, 'text' | 'sizing' | 'width' | 'lineHeight' | 'minWidth' | 'maxWidth'>

/**
 * 折り返す幅。幅を決めているなら width、中身に合わせる（hug）なら上限の maxWidth（なければ折り返さないので null）。
 * 中身に合わせていても、上限を超える行は上限で折り返す（CSS の width: max-content と max-width の組み合わせと同じ）
 */
export function wrapWidth(style: Pick<TextNode, 'sizing' | 'width' | 'maxWidth'>): number | null {
  return style.sizing.width === 'hug' ? style.maxWidth : style.width
}

/** 中身に合わせる幅を、下限・上限に収める。上限より長い 1 語ははみ出す（CSS と同じく幅は上限のまま） */
export function hugWidth(style: Pick<TextNode, 'minWidth' | 'maxWidth'>, content: number): number {
  return Math.max(style.minWidth ?? 0, Math.min(style.maxWidth ?? Infinity, content))
}

/** 行の文字列と描画幅。折り返した行の幅には、行末にぶら下がった空白を含めない */
export type TextLine = { text: string; width: number }

export function applyFont(ctx: CanvasRenderingContext2D, style: FontStyle): void {
  // fontFamily が不正だと代入ごと無視されるので、先にサイズと太さだけ確実に反映しておく
  ctx.font = `${style.fontWeight} ${style.fontSize}px sans-serif`
  ctx.font = `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`
}

// ノードは不変なので、同じオブジェクトなら行分けの結果も同じ
const layoutCache = new WeakMap<TextStyle, TextLine[]>()

/** 描画する行に分ける。折り返す幅（wrapWidth）がなければ改行だけ、あればその幅に収まるよう折り返す */
export function layoutText(ctx: CanvasRenderingContext2D, style: TextStyle): TextLine[] {
  const cached = layoutCache.get(style)
  if (cached) return cached

  applyFont(ctx, style)
  const measure = (text: string) => ctx.measureText(text).width
  const paragraphs = style.text.split('\n')
  const wrapAt = wrapWidth(style)
  const lines = wrapAt === null
    ? paragraphs.map((text) => ({ text, width: measure(text) }))
    : paragraphs
        .flatMap((paragraph) => wrapLine(paragraph, wrapAt, measure))
        .map((text) => ({ text, width: measure(text.trimEnd()) }))
  layoutCache.set(style, lines)
  return lines
}

export function measureText(ctx: CanvasRenderingContext2D, style: TextStyle): Size {
  const lines = layoutText(ctx, style)
  const height = Math.ceil(lines.length * style.fontSize * style.lineHeight)
  if (style.sizing.width !== 'hug') return { width: style.width, height }
  // 行が多いと引数の数の上限を超えるので、Math.max(...lines) にしない
  const width = lines.reduce((max, line) => Math.max(max, line.width), 0)
  return { width: Math.max(1, Math.ceil(hugWidth(style, width))), height }
}

// 空白の並び / 途中で切らない語（英単語など）/ どこでも切れる 1 文字（かな・漢字・全角記号など）
const TOKENS = /\s+|[^\s　-ヿ㐀-鿿豈-﫿＀-￯]+|./gsu

/**
 * 1 段落を maxWidth に収まる行に分ける。CSS の折り返しに合わせて、
 * 行末の空白ははみ出してよく、1 語が幅に収まらないときだけ語の途中で切る。
 */
export function wrapLine(
  text: string,
  maxWidth: number,
  measure: (text: string) => number,
): string[] {
  const lines: string[] = []
  let line = ''

  for (const token of text.match(TOKENS) ?? []) {
    if (token.trim() === '') {
      line += token
      continue
    }
    if (measure(line + token) <= maxWidth) {
      line += token
      continue
    }
    if (line.trim() !== '') {
      lines.push(line)
      line = ''
      if (measure(token) <= maxWidth) {
        line = token
        continue
      }
    }
    for (const char of token) {
      if (line !== '' && measure(line + char) > maxWidth) {
        lines.push(line)
        line = ''
      }
      line += char
    }
  }

  lines.push(line)
  return lines
}
