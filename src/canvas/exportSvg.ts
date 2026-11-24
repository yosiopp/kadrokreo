import { type SvgTextLines, type SvgTextMetrics, exportSvg } from '../document/svgExport.ts'
import type { Asset, AssetId, EmbeddedFont, NodeId, Scene } from '../document/types.ts'
import { fontMetrics, layoutText } from './text.ts'

/** テキストの行分けを、描画と同じく Canvas で測って決める（折り返しの位置が描画と揃う） */
function canvasTextLines(ctx: CanvasRenderingContext2D): SvgTextLines {
  return (node) => layoutText(ctx, node)
}

/** フォントの上下の高さを、描画（canvas/render.ts）と同じく measureText で測る（基線の位置が描画と揃う） */
function canvasTextMetrics(ctx: CanvasRenderingContext2D): SvgTextMetrics {
  return (node) => fontMetrics(ctx, node)
}

/** 画面の書き出し欄で選べるオプション（ui/exportOptions.ts） */
export type SvgMarkupOptions = { ids: boolean; background: string | null; embedFonts: boolean }

const DEFAULT_OPTIONS: SvgMarkupOptions = { ids: true, background: null, embedFonts: true }

/**
 * targets のノードを SVG の文字列にする（viewer と editor の「SVG に」「SVG をコピー」）。並べ方の決まりは exportSvg と同じ。
 * fonts はドキュメントに埋め込んだ書体。options.embedFonts なら、使う書体を SVG に入れる
 */
export function svgMarkup(
  scene: Scene,
  assets: Record<AssetId, Asset>,
  targets: readonly NodeId[],
  options: SvgMarkupOptions = DEFAULT_OPTIONS,
  fonts: readonly EmbeddedFont[] = [],
): string {
  const ctx = document.createElement('canvas').getContext('2d')!
  return exportSvg(scene, targets, {
    assets,
    textLines: canvasTextLines(ctx),
    textMetrics: canvasTextMetrics(ctx),
    ids: options.ids,
    ...(options.embedFonts && fonts.length > 0 ? { fonts } : {}),
    ...(options.background === null ? {} : { background: options.background }),
  })
}

/** targets のノードを SVG ファイルにする（viewer と editor の「SVG に」） */
export function renderSvg(
  scene: Scene,
  assets: Record<AssetId, Asset>,
  targets: readonly NodeId[],
  options?: SvgMarkupOptions,
  fonts: readonly EmbeddedFont[] = [],
): Blob {
  return new Blob([svgMarkup(scene, assets, targets, options, fonts)], { type: 'image/svg+xml' })
}
