import type { NodeId, Scene, TextNode } from '../src/document/types.ts'
import { hugHeight, hugWidth, wrapLine, wrapWidth } from '../src/canvas/text.ts'
import { spacedMeasure } from '../src/document/textWrap.ts'
import { patchNodes } from '../src/editor/operations/tree.ts'

// Node には Canvas がないので、文字の幅は字ごとのおおよその値で見積もる。
// 英数字と記号は、ブラウザの sans-serif（macOS の Helvetica、Linux / Windows の Arial と同じ字幅の書体）の字幅の表を使う。
// 全角の字は 1 文字が fontSize の幅。editor で開き直して文字を変えれば、ブラウザで測った正しい大きさに直る。

/** 全角として扱う文字（かな・漢字・ハングル・全角記号など） */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u

/** Helvetica の字幅（1000 を fontSize とする）。空白「 」から「~」まで、文字コードの順 */
const ASCII_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // 空白 ! " # $ % & ' ( ) * + , - . /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0-9 : ; < = > ?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ A-O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P-Z [ \ ] ^ _
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` a-o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, //        p-z { | } ~
]
/** 表にない半角の字（アクセント付きのラテン文字など）の字幅 */
const OTHER_WIDTH = 556
/** 太字は字幅がおよそこの割合だけ広い（Helvetica Bold の英小文字の平均） */
const BOLD_RATIO = 1.07
/** 等幅の書体の字幅 */
const MONO_WIDTH = 0.6

/** 1 文字の幅（fontSize に対する割合） */
function charWidth(char: string, mono: boolean): number {
  if (WIDE.test(char)) return 1
  if (mono) return MONO_WIDTH
  const code = char.codePointAt(0)!
  if (code >= 0x20 && code <= 0x7e) return ASCII_WIDTHS[code - 0x20] / 1000
  return OTHER_WIDTH / 1000
}

type Style = Pick<TextNode, 'text' | 'fontSize' | 'fontWeight' | 'fontFamily' | 'sizing' | 'width' | 'lineHeight' | 'letterSpacing' | 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight'> &
  Partial<Pick<TextNode, 'height' | 'textPath'>>

export function estimateTextWidth(text: string, fontSize: number, fontWeight: number, fontFamily = 'sans-serif'): number {
  const mono = /mono|courier/i.test(fontFamily)
  let total = 0
  for (const char of text) total += charWidth(char, mono)
  return total * fontSize * (fontWeight >= 700 && !mono ? BOLD_RATIO : 1)
}

/** canvas/text.ts の layoutText と同じ決まりで、見積もった幅を使って行に分ける（SVG の書き出しのテキスト） */
export function estimateTextLines(style: Style): { text: string; width: number }[] {
  // 字間は描画（canvas/text.ts の layoutText）と同じく、文字のまとまりごとに足す
  const measure = spacedMeasure((text: string) => estimateTextWidth(text, style.fontSize, style.fontWeight, style.fontFamily), style.letterSpacing)
  const paragraphs = style.text.split('\n')
  const wrapAt = wrapWidth(style)
  return (wrapAt === null ? paragraphs : paragraphs.flatMap((paragraph) => wrapLine(paragraph, wrapAt, measure))).map((text) => ({ text, width: measure(text.trimEnd()) }))
}

/** canvas/text.ts の measureText と同じ決まりで、見積もった幅を使って大きさを出す */
export function estimateTextSize(style: Style): { width: number; height: number } {
  // 線に沿うテキストの枠は線を囲む矩形で、中身では決まらない
  if (style.textPath && style.height !== undefined) return { width: style.width, height: style.height }
  // 字間は描画（canvas/text.ts の layoutText）と同じく、文字のまとまりごとに足す
  const measure = spacedMeasure((text: string) => estimateTextWidth(text, style.fontSize, style.fontWeight, style.fontFamily), style.letterSpacing)
  const paragraphs = style.text.split('\n')
  const wrapAt = wrapWidth(style)
  const lines = wrapAt === null
    ? paragraphs.map((text) => measure(text))
    : paragraphs.flatMap((paragraph) => wrapLine(paragraph, wrapAt, measure)).map((text) => measure(text.trimEnd()))
  const height = Math.max(1, Math.ceil(hugHeight(style, lines.length * style.fontSize * style.lineHeight)))
  if (style.sizing.width !== 'hug') return { width: style.width, height }
  return { width: Math.max(1, Math.ceil(hugWidth(style, lines.reduce((max, width) => Math.max(max, width), 0)))), height }
}

/** editor の fitTextNodes の代わり。ストアに FitText として渡す */
export function fitTextEstimated<T extends Scene>(scene: T, ids: readonly NodeId[]): T {
  return patchNodes(scene, ids, (node) => (node.type === 'text' ? estimateTextSize(node) : null))
}
