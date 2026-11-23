// SVG ファイルを図形のノードに変換してページに置く（kdr svg）。
// Node には DOMParser がないので、editor と同じ変換（src/editor/svg/convert.ts）に、自前の小さな XML の読み取り（parseSvgXml）で作った木を渡す。
// 依存を足さないのは、SVG に要る XML は要素・属性・文字・CDATA くらいで小さく書けること、
// CLI は Node の型の除去だけでビルドせずに動かしていて依存を増やしたくないこと、ENTITY の展開を最初から持たないほうが安全なことから
import type { NodeId, Page, Scene } from '../src/document/types.ts'
import { pasteFragment } from '../src/editor/operations/clipboard.ts'
import { insertNode } from '../src/editor/operations/tree.ts'
import type { SvgTextMetrics } from '../src/document/svgExport.ts'
import { type SvgImport, convertSvg } from '../src/editor/svg/convert.ts'
import { parseSvgXml } from '../src/editor/svg/xml.ts'
import { estimateTextSize } from './textMeasure.ts'

/** textMetrics はフォントの上下の高さ（png.ts の canvasTextMetrics）。省略すると見積もる */
export function convertSvgFile(bytes: Uint8Array, name: string, textMetrics?: SvgTextMetrics): SvgImport {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return convertSvg(parseSvgXml(text), { name, measureText: estimateTextSize, ...(textMetrics ? { textMetrics } : {}) })
}

/** 変換した SVG を、親（null ならページ直下）の中の (x, y) に置く。id はここで振り直す */
export function placeSvgFragment(
  page: Page,
  imported: SvgImport,
  parentId: NodeId | null,
  at: { x: number; y: number },
  rename: { id?: string; name?: string } = {},
): { page: Page; id: NodeId } {
  // 空の場面に貼って id を振り直してから、根を親の中へ入れる
  const empty: Scene = { nodes: {}, rootIds: [] }
  const fresh = pasteFragment(empty, imported.fragment).scene
  const rootId = fresh.rootIds[0]
  const { [rootId]: root, ...descendants } = fresh.nodes
  const id = rename.id ?? rootId
  const placed = { ...root, id, x: at.x, y: at.y, ...(rename.name === undefined ? {} : { name: rename.name }) }
  if (root.type === 'frame' && id !== rootId) {
    for (const child of root.children) descendants[child] = { ...descendants[child], parentId: id }
  }
  const next = insertNode({ ...page, nodes: { ...page.nodes, ...descendants } }, placed, parentId)
  return { page: next, id }
}
