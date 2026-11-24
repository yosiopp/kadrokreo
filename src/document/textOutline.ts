import { firstFamily } from './fontFile.ts'
import { applyMatrix, flipMatrix } from './geometry.ts'
import { type GlyphCommand, type OutlineFont, parseOutlineFont } from './openType.ts'
import { alignFactor } from './paint.ts'
import type { Contour, Vertex } from './path.ts'
import { wrapLine, wrapWidth } from './textWrap.ts'
import type { Asset, AssetId, EmbeddedFont, TextNode } from './types.ts'

// テキストの文字の形（輪郭）。kdr に埋め込んだ書体（document.fonts）のファイルから字の輪郭を読み、テキストの行分けに合わせて並べる。
// アウトライン化（editor/operations/outline.ts）と、テキストを入れたブーリアン演算（booleanNode.ts）が使う。
//
// 描画と同じ形にするための前提:
// - 行分けは描画と同じ折り返し（textWrap.ts）を、Canvas ではなく書体ファイルの送り幅と字詰め（GPOS の kern か kern の表）で測ってかける。
//   Canvas も同じ書体で測るので、ほとんどの場合は同じ行に分かれる（合字などの置き換えはしないので、そこだけ幅がずれうる）。
// - 基線は描画（render.ts の textShape）と同じ式で、上下の高さは書体の hhea（USE_TYPO_METRICS なら OS/2 の typo）から取る。
// - 書体の太さは CSS と同じ選び方（いちばん近い太さ）。書体に無い太さを太字に見せかける描き方（合成の太字）は再現しない。
// - 書体に無い文字は描画では OS の書体で補われるが、ここでは形を作れないので除く（数を missing で返す）。
//
// どの書体ファイルを使えるかは、ドキュメントを開いたとき・書体を足し外ししたときに setOutlineFonts で知らせる
// （描画・当たり判定は Scene だけを受け取り、ドキュメントの assets を持たないため。canvas/fonts.ts と CLI が呼ぶ）。

let current: { fonts: readonly EmbeddedFont[]; assets: Record<AssetId, Asset> } = { fonts: [], assets: {} }
let generation = 0
const parsed = new WeakMap<Uint8Array, OutlineFont | null>()
const outlineCache = new WeakMap<TextNode, { generation: number; outline: TextOutline | null }>()

/**
 * 文字の形に使える書体（ドキュメントの埋め込んだ書体と、そのファイル）を知らせる。
 * 書体の並びとそのファイルが前と同じなら何もしない（画像を足して assets が変わっただけでは、覚えた結果を捨てない）
 */
export function setOutlineFonts(fonts: readonly EmbeddedFont[], assets: Record<AssetId, Asset>): void {
  if (current.fonts === fonts && current.assets === assets) return
  const before = current
  current = { fonts, assets }
  const same = before.fonts.length === fonts.length && fonts.every((font, i) => {
    const old = before.fonts[i]
    return old.assetId === font.assetId && old.family === font.family && old.weight === font.weight && old.style === font.style
      && before.assets[old.assetId]?.bytes === assets[font.assetId]?.bytes
  })
  if (!same) generation++
}

/** setOutlineFonts で書体が変わるたびに増える数。文字の形から作った結果を覚えている所が、覚え直すかを決めるのに使う */
export function outlineFontsGeneration(): number {
  return generation
}

function parsedFont(font: EmbeddedFont): OutlineFont | null {
  const asset = current.assets[font.assetId]
  if (!asset || !Object.hasOwn(current.assets, font.assetId)) return null
  if (!parsed.has(asset.bytes)) parsed.set(asset.bytes, parseOutlineFont(asset.bytes))
  return parsed.get(asset.bytes) ?? null
}

/** CSS の書体の選び方で、望む太さにいちばん合う太さを選ぶ */
export function matchWeight(available: readonly number[], wanted: number): number | null {
  if (available.length === 0) return null
  if (available.includes(wanted)) return wanted
  const lighter = available.filter((w) => w < wanted).sort((a, b) => b - a)
  const heavier = available.filter((w) => w > wanted).sort((a, b) => a - b)
  if (wanted >= 400 && wanted <= 500) {
    const upTo500 = heavier.filter((w) => w <= 500)
    return upTo500[0] ?? lighter[0] ?? heavier[0]
  }
  return wanted < 400 ? (lighter[0] ?? heavier[0]) : (heavier[0] ?? lighter[0])
}

/**
 * テキストを描く埋め込んだ書体（読めたもの）。書体名の先頭が埋め込んだ書体でない・書体ファイルが読めないなら null。
 * 斜体でない書体を先に選ぶ（テキストは斜体を持たないので）
 */
export function textOutlineFont(node: Pick<TextNode, 'fontFamily' | 'fontWeight'>): OutlineFont | null {
  const family = firstFamily(node.fontFamily)
  const faces = current.fonts.filter((font) => font.family === family && parsedFont(font) !== null)
  if (faces.length === 0) return null
  const normal = faces.filter((font) => font.style === 'normal')
  const pool = normal.length > 0 ? normal : faces
  const weight = matchWeight(pool.map((font) => font.weight), node.fontWeight)
  const face = pool.find((font) => font.weight === weight)
  return face ? parsedFont(face) : null
}

/** テキストの文字の形。contours はノードの座標系（裏返しも含む）で nonzero で塗る。missing は書体に無いので除いた文字の数 */
export type TextOutline = { contours: Contour[]; missing: number }

const isSpace = (char: string) => /\s/u.test(char)

/** 文字の並びの幅（px）。字の送り幅と字詰めの足し算 */
function measureWith(font: OutlineFont, scale: number): (text: string) => number {
  return (text) => {
    let width = 0
    let previous = -1
    for (const char of text) {
      const glyph = font.glyphIndex(char.codePointAt(0)!)
      if (previous >= 0) width += font.kerning(previous, glyph)
      width += font.advance(glyph)
      previous = glyph
    }
    return width * scale
  }
}

/**
 * テキストの文字を、埋め込んだ書体の字の輪郭にしたもの。書体を埋め込んでいない（読めない）テキストは null。
 * 同じノードなら同じ結果（書体が変わるまで覚える）
 */
export function textOutline(node: TextNode): TextOutline | null {
  const cached = outlineCache.get(node)
  if (cached && cached.generation === generation) return cached.outline
  const font = textOutlineFont(node)
  const outline = font ? buildOutline(node, font) : null
  outlineCache.set(node, { generation, outline })
  return outline
}

function buildOutline(node: TextNode, font: OutlineFont): TextOutline {
  const scale = node.fontSize / font.unitsPerEm
  const measure = measureWith(font, scale)
  const wrapAt = wrapWidth(node)
  const paragraphs = node.text.split('\n')
  const lines = wrapAt === null
    ? paragraphs.map((text) => ({ text, width: measure(text) }))
    : paragraphs.flatMap((paragraph) => wrapLine(paragraph, wrapAt, measure, node.fontSize)).map((text) => ({ text, width: measure(text.trimEnd()) }))
  const lineHeight = node.fontSize * node.lineHeight
  const ascent = font.ascender * scale
  const descent = font.descender * scale
  const baseline = (lineHeight - (ascent + descent)) / 2 + ascent
  const align = alignFactor(node.textAlign)
  const flip = flipMatrix(node)
  const contours: Contour[] = []
  let missing = 0
  lines.forEach((line, row) => {
    const originY = lineHeight * row + baseline
    let pen = (node.width - line.width) * align
    let previous = -1
    for (const char of line.text) {
      const glyph = font.glyphIndex(char.codePointAt(0)!)
      if (previous >= 0) pen += font.kerning(previous, glyph) * scale
      previous = glyph
      if (glyph === 0 && !isSpace(char)) missing++
      else {
        const originX = pen
        const point = (x: number, y: number) => {
          const p = { x: originX + x * scale, y: originY - y * scale }
          return flip ? applyMatrix(flip, p) : p
        }
        contours.push(...glyphContours(font.glyphPath(glyph), point))
      }
      pen += font.advance(glyph) * scale
    }
  })
  return { contours, missing }
}

/** 字の輪郭の命令を、頂点の並び（2 次曲線は 3 次に直す）にする */
export function glyphContours(commands: readonly GlyphCommand[], point: (x: number, y: number) => { x: number; y: number }): Contour[] {
  const contours: Contour[] = []
  let vertices: Vertex[] = []
  // 書体の単位での今の点（2 次曲線の制御点を 3 次に直すのに使う）
  let cx = 0
  let cy = 0
  const finish = () => {
    if (vertices.length >= 2) {
      const first = vertices[0]
      const last = vertices[vertices.length - 1]
      // 終わりの点が始まりと重なっていれば、1 つにまとめる（始まりの点が終わりの曲線の制御点を受け継ぐ）
      if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) {
        if (last.in) first.in = last.in
        vertices.pop()
      }
    }
    if (vertices.length >= 2) contours.push({ vertices, closed: true })
    vertices = []
  }
  for (const command of commands) {
    switch (command.type) {
      case 'M':
        finish()
        vertices.push(point(command.x, command.y))
        cx = command.x
        cy = command.y
        break
      case 'L':
        vertices.push(point(command.x, command.y))
        cx = command.x
        cy = command.y
        break
      case 'Q': {
        const previous = vertices[vertices.length - 1]
        if (!previous) break
        previous.out = point(cx + (2 / 3) * (command.x1 - cx), cy + (2 / 3) * (command.y1 - cy))
        vertices.push({ ...point(command.x, command.y), in: point(command.x + (2 / 3) * (command.x1 - command.x), command.y + (2 / 3) * (command.y1 - command.y)) })
        cx = command.x
        cy = command.y
        break
      }
      case 'C': {
        const previous = vertices[vertices.length - 1]
        if (!previous) break
        previous.out = point(command.x1, command.y1)
        vertices.push({ ...point(command.x, command.y), in: point(command.x2, command.y2) })
        cx = command.x
        cy = command.y
        break
      }
      case 'Z':
        finish()
        break
    }
  }
  finish()
  return contours
}
