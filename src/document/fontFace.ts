import { FONT_EXTENSIONS, firstFamily } from './fontFile.ts'
import { dataUri } from './svgShapes.ts'
import { matchWeight } from './textOutline.ts'
import type { Asset, AssetId, EmbeddedFont, TextNode } from './types.ts'

// kdr に埋め込んだ書体（document.fonts）を、書き出す SVG・HTML の @font-face にする。
// 書体のファイルは手を加えずにそのまま入れる（字を絞る・形式を変えることはしない。OFL は改変した書体に予約された書体名を使うことを禁じ、
// 著作権表示とライセンスは書体ファイルの name の表に入っているので、そのまま入れればそれも一緒に渡る）。
// 入れるのは、書き出すテキストが実際に使う書体（書体名・太さごとに、ブラウザが選ぶのと同じ 1 つ）だけ。

const FORMATS: Record<string, string> = {
  'font/ttf': 'truetype',
  'font/otf': 'opentype',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
}

/**
 * テキストが使う埋め込んだ書体。書体名の先頭が埋め込んだ書体なら、斜体でない書体を先に、CSS と同じ選び方で太さを選ぶ
 * （テキストは斜体を持たない。textOutline.ts の textOutlineFont と同じ選び方）。並びは document.fonts の順。ファイルの無い書体は選ばない
 */
export function usedFontFaces(
  fonts: readonly EmbeddedFont[],
  assets: Record<AssetId, Asset>,
  texts: Iterable<Pick<TextNode, 'fontFamily' | 'fontWeight'>>,
): EmbeddedFont[] {
  if (fonts.length === 0) return []
  const available = fonts.filter((font) => Object.hasOwn(assets, font.assetId))
  const used = new Set<EmbeddedFont>()
  const seen = new Set<string>()
  for (const text of texts) {
    const key = `${text.fontFamily}\u0000${text.fontWeight}`
    if (seen.has(key)) continue
    seen.add(key)
    const family = firstFamily(text.fontFamily)
    const faces = available.filter((font) => font.family === family)
    if (faces.length === 0) continue
    const normal = faces.filter((font) => font.style === 'normal')
    const pool = normal.length > 0 ? normal : faces
    const weight = matchWeight(pool.map((font) => font.weight), text.fontWeight)
    const face = pool.find((font) => font.weight === weight)
    if (face) used.add(face)
  }
  return fonts.filter((font) => used.has(font))
}

/**
 * 書体 1 つの @font-face。src は書体ファイルの URL（data URI かファイル名）。
 * 書体名は読み込みの検証で引用符・\・; { } < > を含まないので、そのまま引用符で囲める
 */
export function fontFaceRule(font: EmbeddedFont, mime: string, src: string): string {
  const format = FORMATS[mime]
  return [
    '@font-face {',
    `  font-family: "${font.family}";`,
    `  src: url("${src.replace(/["\\\n]/g, (c) => `\\${c === '\n' ? 'a ' : c}`)}")${format ? ` format("${format}")` : ''};`,
    `  font-weight: ${font.weight};`,
    `  font-style: ${font.style};`,
    '}',
  ].join('\n')
}

/** 書体を data URI で埋め込んだ @font-face の並び（SVG の書き出しと、保存する HTML ファイル）。使う書体がなければ空文字 */
export function embeddedFontFaces(faces: readonly EmbeddedFont[], assets: Record<AssetId, Asset>): string {
  return faces.map((font) => fontFaceRule(font, assets[font.assetId].mime, dataUri(assets[font.assetId]))).join('\n')
}

/**
 * 書体のファイルとして保存するときの名前（viewer の「書体ファイルを保存」と、コピー用の CSS の @font-face の url）。
 * 書体名のファイル名に使えない文字・空白は - にし、太さと斜体を付ける（`Red-Hat-Display-700.ttf`）
 */
export function fontFileName(font: EmbeddedFont, mime: string): string {
  // eslint-disable-next-line no-control-regex
  const base = font.family.replace(/[\\/:*?"<>|\u0000-\u001f\s]+/g, '-').replace(/^-+|-+$/g, '') || 'font'
  return `${base}-${font.weight}${font.style === 'italic' ? '-italic' : ''}.${FONT_EXTENSIONS[mime] ?? 'ttf'}`
}
