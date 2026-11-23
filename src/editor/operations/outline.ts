import { booleanPath, isBooleanNode } from '../../document/booleanNode.ts'
import { applyMatrix, nodeMatrix } from '../../document/geometry.ts'
import { type ShapeNode, isShape } from '../../document/mask.ts'
import { strokeOutline } from '../../document/outlineStroke.ts'
import { hasStroke, shownPaints } from '../../document/paint.ts'
import { isLine, mapVertices, pathFromContours } from '../../document/path.ts'
import type { FrameNode, NodeId, PathNode, Scene, SceneNode } from '../../document/types.ts'
import { createId, createPath } from '../nodes.ts'
import { MAX_PATH_POINTS } from './paths.ts'
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
