import type { Camera } from '../canvas/camera.ts'
import { measureTextNode } from '../canvas/measure.ts'
import { screenToWorld } from '../canvas/viewport.ts'
import { findFrameAt } from './hitTest.ts'
import { pasteIntoPage } from './operations/document.ts'
import type { EditorStore } from './store.ts'
import { type SvgImport, type SvgWarning, convertSvg } from './svg/convert.ts'
import { MAX_SVG_LENGTH, parseSvgDom } from './svg/xml.ts'

// SVG を図形のノードに変換して取り込む（editor 専用）。SVG は画像としては受け付けない（IMAGE_MIME_TYPES に入れない）。
// 解析は DOMParser（image/svg+xml）で行い、結果を DOM に挿入したり表示したりはしない

/** ファイル選択で SVG も選べるようにするときの accept */
export const SVG_ACCEPT = '.svg,image/svg+xml'

export function isSvgFile(file: File): boolean {
  return file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)
}

/** 貼り付けられた文字が SVG の文書に見えるか */
export function looksLikeSvg(text: string): boolean {
  const head = text.trimStart().slice(0, 1024)
  return /^<svg[\s>]/i.test(head) || (/^<\?xml|^<!--/i.test(head) && /<svg[\s>]/i.test(text.slice(0, 64 * 1024)))
}

/** SVG の文字列を変換する。name は根のフレームの名前 */
export function convertSvgText(text: string, name: string): SvgImport {
  return convertSvg(parseSvgDom(text), { name, measureText: measureTextNode })
}

export async function readSvgFile(file: File): Promise<SvgImport & { name: string }> {
  if (file.size > MAX_SVG_LENGTH) throw new Error(`${file.name}: SVG が大きすぎます（16MB まで）`)
  const name = file.name.replace(/\.[^.]+$/, '') || 'SVG'
  try {
    return { ...convertSvgText(await file.text(), name), name: file.name }
  } catch (error) {
    throw new Error(`${file.name}: ${error instanceof Error ? error.message : 'SVG を読めません'}`)
  }
}

/** 画面の中央に置く。そこにフレームがあればその中へ入れる。offset は複数のファイルを少しずつずらすため */
export function placeSvg(store: EditorStore, camera: Camera, imported: SvgImport, offset = 0): void {
  const size = camera.getSize()
  const center = screenToWorld(camera.getViewport(), { x: size.width / 2, y: size.height / 2 })
  const page = store.getState().page
  const parentId = findFrameAt(page, center)
  const { fragment } = imported
  const rootId = fragment.rootIds[0]
  const root = fragment.nodes[rootId]
  // pasteFragment は根の x, y をページ上の位置として読み、親の中の位置に直す
  const placed = {
    ...fragment,
    nodes: {
      ...fragment.nodes,
      [rootId]: {
        ...root,
        parentId,
        x: Math.round(center.x - root.width / 2) + offset,
        y: Math.round(center.y - root.height / 2) + offset,
      },
    },
  }
  const result = store.applyDocumentWith((doc) => pasteIntoPage(doc, page.id, placed))
  store.select(result?.ids ?? [])
}

/** 落としたものの知らせ。なければ null */
export function svgWarningMessage(fileName: string, warnings: readonly SvgWarning[]): string | null {
  if (warnings.length === 0) return null
  const list = warnings.map(({ label, count }) => (count > 1 ? `${label} ×${count}` : label)).join('、')
  return `${fileName} を取り込みました。kadrokreo で表せないものは置き換えるか読み飛ばしました: ${list}`
}
