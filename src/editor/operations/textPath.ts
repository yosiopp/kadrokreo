import { booleanPath, isBooleanNode } from '../../document/booleanNode.ts'
import { applyMatrix, getWorldMatrix, invert, multiply, tidy } from '../../document/geometry.ts'
import { type ShapeNode, isShape, shapeContours } from '../../document/mask.ts'
import { type Contour, mapVertices, pathOutlines } from '../../document/path.ts'
import { isPathText, textPathFromVertices } from '../../document/textPath.ts'
import type { NodeId, Scene, SceneNode } from '../../document/types.ts'
import { patchNodes, updateNode } from './tree.ts'

// テキストを線に沿わせる（SVG の textPath）。線の形はテキストのノードが写して持つ（線のノードを指さない）ので、
// 沿わせた後に元の図形を動かしたり消したりしても、テキストは変わらない。純粋な関数で、何も変わらなければ同じ参照を返す。
// テキストの大きさを中身に合わせ直すのは呼び出し側（fitTextNodes）。

/** 沿わせる線にできる図形（矩形・楕円・パスと、ブーリアン演算のノードは結果のパス） */
function guideShape(scene: Scene, node: SceneNode | undefined): ShapeNode | null {
  if (!node) return null
  const shape = isBooleanNode(node) ? booleanPath(scene, node) : node
  return isShape(shape) ? shape : null
}

/** 図形の最初の輪郭（ノードの座標系）。パスは開いたまま、矩形・楕円は閉じた輪郭 */
function guideContour(shape: ShapeNode): Contour | null {
  const contour = shape.type === 'path' ? pathOutlines(shape)[0] : shapeContours(shape)[0]
  return contour && contour.vertices.length >= 2 ? contour : null
}

/** 選んだノードから、沿わせるテキストと線にする図形を選ぶ（テキスト 1 つと図形 1 つのときだけ） */
export function textPathTargets(scene: Scene, ids: readonly NodeId[]): { text: NodeId; guide: NodeId } | null {
  if (ids.length !== 2) return null
  const text = ids.find((id) => scene.nodes[id]?.type === 'text')
  const guide = ids.find((id) => id !== text && guideShape(scene, scene.nodes[id]) !== null)
  return text !== undefined && guide !== undefined ? { text, guide } : null
}

/**
 * テキストを図形の線（最初の輪郭）に沿わせる。線の形をテキストの親の座標系に写し、テキストの枠をそれを囲む矩形にする
 * （回転・裏返しは線の形に焼き込んで 0 に戻す）。図形はそのまま残す。沿わせられなければ同じ参照を返す
 */
export function attachTextToPath<T extends Scene>(scene: T, textId: NodeId, guideId: NodeId): T {
  const text = scene.nodes[textId]
  const guide = guideShape(scene, scene.nodes[guideId])
  if (text?.type !== 'text' || !guide) return scene
  const contour = guideContour(guide)
  if (!contour) return scene
  // 図形の座標系 → ページ → テキストの親の座標系
  const toParent = multiply(invert(getWorldMatrix(scene, text.parentId)), getWorldMatrix(scene, guideId))
  const vertices = mapVertices(contour.vertices, (point) => applyMatrix(toParent, point))
  const shape = textPathFromVertices(vertices, contour.closed, text.textPath?.startOffset ?? 0)
  return updateNode(scene, textId, {
    x: tidy(shape.x),
    y: tidy(shape.y),
    width: tidy(shape.width),
    height: tidy(shape.height),
    rotation: 0,
    flipX: false,
    flipY: false,
    sizing: { ...text.sizing, width: 'fixed' },
    textPath: shape.textPath,
  })
}

/** テキストを線から外し、ふつうに行に並べる（幅は中身に合わせる）。位置は枠の左上のまま */
export function detachTextFromPath<T extends Scene>(scene: T, ids: readonly NodeId[]): T {
  return patchNodes(scene, ids, (node) => (isPathText(node) ? { textPath: null, sizing: { ...node.sizing, width: 'hug' } } : null))
}

/** 線に沿うテキストの並べ始める位置（線の長さに対する割合、0〜1） */
export function setTextPathOffset<T extends Scene>(scene: T, ids: readonly NodeId[], startOffset: number): T {
  const value = Math.min(1, Math.max(0, startOffset))
  return patchNodes(scene, ids, (node) =>
    isPathText(node) && node.textPath.startOffset !== value ? { textPath: { ...node.textPath, startOffset: value } } : null,
  )
}
