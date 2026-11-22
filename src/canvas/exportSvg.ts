import { type SvgTextLines, type SvgTextMetrics, exportSvg } from '../document/svgExport.ts'
import type { Asset, AssetId, NodeId, Scene } from '../document/types.ts'
import { applyFont, layoutText } from './text.ts'

/** テキストの行分けを、描画と同じく Canvas で測って決める（折り返しの位置が描画と揃う） */
function canvasTextLines(ctx: CanvasRenderingContext2D): SvgTextLines {
  return (node) => layoutText(ctx, node)
}

/** フォントの上下の高さを、描画（canvas/render.ts）と同じく measureText で測る（基線の位置が描画と揃う） */
function canvasTextMetrics(ctx: CanvasRenderingContext2D): SvgTextMetrics {
  return (node) => {
    applyFont(ctx, node)
    const metrics = ctx.measureText('')
    return { ascent: metrics.fontBoundingBoxAscent, descent: metrics.fontBoundingBoxDescent }
  }
}

/** 画面の書き出し欄で選べるオプション（ui/exportOptions.ts） */
export type SvgMarkupOptions = { ids: boolean; background: string | null }

/** targets のノードを SVG の文字列にする（viewer と editor の「SVG に」「SVG をコピー」）。並べ方の決まりは exportSvg と同じ */
export function svgMarkup(
  scene: Scene,
  assets: Record<AssetId, Asset>,
  targets: readonly NodeId[],
  options: SvgMarkupOptions = { ids: true, background: null },
): string {
  const ctx = document.createElement('canvas').getContext('2d')!
  return exportSvg(scene, targets, {
    assets,
    textLines: canvasTextLines(ctx),
    textMetrics: canvasTextMetrics(ctx),
    ids: options.ids,
    ...(options.background === null ? {} : { background: options.background }),
  })
}

/** targets のノードを SVG ファイルにする（viewer と editor の「SVG に」） */
export function renderSvg(scene: Scene, assets: Record<AssetId, Asset>, targets: readonly NodeId[], options?: SvgMarkupOptions): Blob {
  return new Blob([svgMarkup(scene, assets, targets, options)], { type: 'image/svg+xml' })
}
