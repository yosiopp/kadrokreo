import { booleanPath, isBooleanNode } from '../../document/booleanNode.ts'
import { applyMatrix, nodeMatrix } from '../../document/geometry.ts'
import { type ShapeNode, isShape } from '../../document/mask.ts'
import { strokeOutline } from '../../document/outlineStroke.ts'
import { hasStroke, shownPaints } from '../../document/paint.ts'
import { isLine, mapVertices, pathFromContours } from '../../document/path.ts'
import type { FrameNode, NodeId, PathNode, Scene, SceneNode, TextNode } from '../../document/types.ts'
import { createId, createPath } from '../nodes.ts'
import { MAX_PATH_POINTS } from '../../document/kdr.ts'
import { textOutline, textOutlineFont } from '../../document/textOutline.ts'
import { insertNode, removeNodes, topLevelIds } from './tree.ts'

// 線の輪郭化（既存のデザインツールの Outline stroke）。線の形を、線の色で塗るパスにする。純粋な関数で、何も変わらなければ同じ参照を返す。

/** 輪郭化の材料になる形（矩形・楕円・パスと、ブーリアン演算のノードは結果のパス）。線がなければ null */
function strokedShape(scene: Scene, node: SceneNode | undefined): ShapeNode | null {
  if (!node) return null
  const shape = isBooleanNode(node) ? booleanPath(scene, node) : node
  return isShape(shape) && hasStroke(shape) ? shape : null
}

/** 輪郭化できるか（線のある矩形・楕円・パス・ブーリアン演算のノードを選んでいる） */
export function canOutlineStroke(scene: Scene, ids: readonly NodeId[]): boolean {
  return ids.some((id) => strokedShape(scene, scene.nodes[id]) !== null)
}

/**
 * 選んだ図形の線を、線の形のパス（塗りは線の塗り、線はなし）にする。
 * 塗りのある図形は、線を外した元の図形を残し、そのすぐ手前に「名前 の線」のパスを置く。塗りのない図形（と直線）は、
 * 同じ id のまま線の形のパスに置き換える（ブーリアン演算のノードなら子も消える）。効果・不透明度・描画モードは線の形に引き継ぐ。
 * 返す ids は作った（置き換えた）パス。頂点が多すぎる図形はそのままにして too-many を返す
 */
export function outlineStrokes<T extends Scene>(scene: T, ids: readonly NodeId[]): { scene: T; ids: NodeId[]; error?: 'too-many' } {
  let next = scene
  const done: NodeId[] = []
  let error: 'too-many' | undefined
  for (const id of topLevelIds(scene, ids)) {
    const node = next.nodes[id]
    const shape = strokedShape(next, node)
    if (!shape) continue
    const m = nodeMatrix(shape)
    const contours = strokeOutline(shape).map((contour) => ({ vertices: mapVertices(contour.vertices, (p) => applyMatrix(m, p)), closed: true }))
    if (contours.length === 0) continue
    if (contours.reduce((sum, contour) => sum + contour.vertices.length, 0) > MAX_PATH_POINTS) {
      error = 'too-many'
      continue
    }
    const keep = !isLine(shape) && shownPaints(shape.fills).length > 0
    const geometry = pathFromContours(contours)
    const outline: PathNode = {
      ...createPath(geometry, true),
      contours: geometry.contours,
      id: keep ? createId() : id,
      name: keep ? `${node.name} の線` : node.name,
      parentId: node.parentId,
      visible: node.visible,
      locked: node.locked,
      opacity: node.opacity,
      blendMode: node.blendMode,
      layoutPositioning: node.layoutPositioning,
      constraints: node.constraints,
      minWidth: node.minWidth,
      maxWidth: node.maxWidth,
      minHeight: node.minHeight,
      maxHeight: node.maxHeight,
      fills: shape.strokes,
      strokes: [],
      effects: shape.effects,
      // 合体の結果なので、どちらで読んでも同じ形になる
      fillRule: 'evenodd',
      // 元を残すときはマスクの役目も元に残す
      isMask: keep ? false : shape.isMask,
      maskType: shape.maskType,
    }
    if (keep) {
      const parentId = node.parentId
      const siblings = parentId === null ? next.rootIds : (next.nodes[parentId] as FrameNode).children
      const stripped = { ...next, nodes: { ...next.nodes, [id]: { ...node, strokes: [] } as SceneNode } }
      next = insertNode(stripped, outline, parentId, siblings.indexOf(id) + 1)
    } else {
      const removed = node.type === 'frame' ? removeNodes(next, node.children) : next
      next = { ...removed, nodes: { ...removed.nodes, [id]: outline } }
    }
    done.push(outline.id)
  }
  return error ? { scene: next, ids: done, error } : { scene: next, ids: done }
}

// テキストのアウトライン化（文字をパスにする）。kdr に埋め込んだ書体のファイルから字の輪郭を読む（document/textOutline.ts）。

/** アウトライン化できるテキストか（埋め込んだ書体で描くテキスト） */
export function canOutlineText(node: SceneNode | undefined): node is TextNode {
  return node?.type === 'text' && textOutlineFont(node) !== null
}

/**
 * テキストを、文字の形のパス（親の座標系に置く。回転は形に焼き込む）にする。id・名前・塗り・効果・不透明度・マスクの指定はテキストのまま。
 * 埋め込んだ書体で描かないテキストは null。文字が 1 つも形にならなければ empty、頂点が多すぎれば too-many
 */
export function textToPath(node: TextNode): { path: PathNode; missing: number } | 'empty' | 'too-many' | null {
  const outline = textOutline(node)
  if (!outline) return null
  if (outline.contours.length === 0) return 'empty'
  if (outline.contours.reduce((sum, contour) => sum + contour.vertices.length, 0) > MAX_PATH_POINTS) return 'too-many'
  const m = nodeMatrix(node)
  const geometry = pathFromContours(outline.contours.map((contour) => ({ vertices: mapVertices(contour.vertices, (p) => applyMatrix(m, p)), closed: true })))
  const path: PathNode = {
    ...createPath(geometry, true),
    contours: geometry.contours,
    id: node.id,
    name: node.name,
    parentId: node.parentId,
    visible: node.visible,
    locked: node.locked,
    opacity: node.opacity,
    blendMode: node.blendMode,
    layoutPositioning: node.layoutPositioning,
    constraints: node.constraints,
    minWidth: null,
    maxWidth: null,
    minHeight: null,
    maxHeight: null,
    fills: node.fills,
    strokes: [],
    effects: node.effects,
    // 字の輪郭は、穴を逆向きに回して表す（書体の決まり）
    fillRule: 'nonzero',
    isMask: node.isMask,
    maskType: node.maskType,
  }
  return { path, missing: outline.missing }
}

export type OutlineTextResult<T extends Scene> = {
  scene: T
  /** パスにしたテキスト（同じ id のパスになった） */
  ids: NodeId[]
  /** 埋め込んだ書体で描かないので、そのままにしたテキスト */
  unembedded: NodeId[]
  /** 書体に無いので形にできず、除いた文字の数（パスにしたテキストの合計） */
  missing: number
  /** 頂点が多すぎてそのままにしたテキスト */
  tooMany: NodeId[]
}

/**
 * 選んだテキストを、同じ id のまま文字の形のパスに置き換える（アウトライン化。既存のデザインツールの「アウトライン化」「平らにする」）。
 * テキストのほかは無視する。埋め込んだ書体で描かないテキスト・頂点が多すぎるテキストはそのままにして、unembedded・tooMany で知らせる。
 * 空のテキスト（空白だけ）は形が無いのでそのまま
 */
export function outlineTexts<T extends Scene>(scene: T, ids: readonly NodeId[]): OutlineTextResult<T> {
  let next = scene
  const result: OutlineTextResult<T> = { scene, ids: [], unembedded: [], missing: 0, tooMany: [] }
  for (const id of topLevelIds(scene, ids)) {
    const node = next.nodes[id]
    if (node?.type !== 'text') continue
    const converted = textToPath(node)
    if (converted === null) result.unembedded.push(id)
    else if (converted === 'too-many') result.tooMany.push(id)
    else if (converted !== 'empty') {
      next = { ...next, nodes: { ...next.nodes, [id]: converted.path } }
      result.ids.push(id)
      result.missing += converted.missing
    }
  }
  result.scene = next
  return result
}
