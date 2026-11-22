import { applyMatrix, getNodesBounds, getWorldMatrix, invert, multiply, nodeMatrix, toLocal } from '../../document/geometry.ts'
import { type MaskNode, canMask, isMaskNode, maskFillRule, shapeContours } from '../../document/mask.ts'
import { type Contour, mapVertices, pathContours, pathFromContours, pathOutlines } from '../../document/path.ts'
import { type BooleanOp, booleanContours } from '../../document/pathBoolean.ts'
import type { FrameNode, MaskType, NodeId, PathNode, Scene } from '../../document/types.ts'
import { createFrame, createId, createPath } from '../nodes.ts'
import { reshapeContours } from '../pathEdit.ts'
import { insertNode, moveNode, patchNodes, removeNodes, sortByDocumentOrder, topLevelIds } from './tree.ts'

// パスの結合・分割と、マスクとして使う操作。どれも純粋な関数で、何も変わらなければ同じ参照を返す。

/** 結合できる種類（矩形・楕円・パス） */
function joinable(scene: Scene, ids: readonly NodeId[]): MaskNode[] {
  return sortByDocumentOrder(scene, topLevelIds(scene, ids)).map((id) => scene.nodes[id]).filter(canMask)
}

/** 結合できるか（矩形・楕円・パスを 2 つ以上選んでいる） */
export function canJoinPaths(scene: Scene, ids: readonly NodeId[]): boolean {
  return joinable(scene, ids).length >= 2
}

/**
 * 選んだ矩形・楕円・パスを、1 つのパスの輪郭（contours）にまとめる（既存のデザインツールの「パスの結合」）。
 * まとめた先は最も背面のもの（id・名前・塗り・線・効果・マスクの指定・塗る範囲の決め方を引き継ぐ）で、残りは消す。
 * 矩形と楕円は形の輪郭（角丸は曲線）にし、パスは頂点の角の丸めを残す。輪郭の並びは重なり順（背面から）。
 * 端の形は最初の輪郭にだけ付くので、まとめた先がパスでなければ付けない。選んだもののうち、矩形・楕円・パスでないものはそのまま
 */
export function joinPaths<T extends Scene>(scene: T, ids: readonly NodeId[]): { scene: T; id: NodeId | null } {
  const targets = joinable(scene, ids)
  if (targets.length < 2) return { scene, id: null }
  const [base] = targets
  // まとめた先の親の座標系に、全部の輪郭を直す（親が回っていても、ページ上の形は変わらない）
  const toParent = invert(getWorldMatrix(scene, base.parentId))
  const contours: Contour[] = targets.flatMap((node) => {
    const m = multiply(toParent, multiply(getWorldMatrix(scene, node.parentId), nodeMatrix(node)))
    const own = node.type === 'path' ? pathContours(node) : shapeContours(node)
    return own.map((contour) => ({ vertices: mapVertices(contour.vertices, (p) => applyMatrix(m, p)), closed: contour.closed }))
  })
  const path = pathOnBase(base, pathFromContours(contours))
  const removed = removeNodes(scene, targets.slice(1).map((node) => node.id))
  return { scene: { ...removed, nodes: { ...removed.nodes, [base.id]: path } }, id: base.id }
}

/** まとめた先（最も背面のもの）を、輪郭 shape のパスにする。矩形・楕円なら、ノードの共通の項目と見た目を引き継いだ新しいパスにする */
function pathOnBase(base: MaskNode, shape: ReturnType<typeof pathFromContours>): PathNode {
  if (base.type === 'path') return { ...base, ...shape, rotation: 0 }
  return {
    ...createPath(shape, shape.closed),
    contours: shape.contours,
    // 矩形・楕円から、ノードの共通の項目と見た目を引き継ぐ（角丸は輪郭の曲線になった）
    id: base.id,
    name: base.name,
    parentId: base.parentId,
    visible: base.visible,
    locked: base.locked,
    opacity: base.opacity,
    sizing: base.sizing,
    layoutPositioning: base.layoutPositioning,
    constraints: base.constraints,
    minWidth: base.minWidth,
    maxWidth: base.maxWidth,
    minHeight: base.minHeight,
    maxHeight: base.maxHeight,
    fills: base.fills,
    strokes: base.strokes,
    strokeWidth: base.strokeWidth,
    strokeDashes: base.strokeDashes,
    effects: base.effects,
    isMask: base.isMask,
    maskType: base.maskType,
  }
}

/** 1 つのパスに持てる頂点の数の上限（kdr の読み込みの上限と同じ） */
export const MAX_PATH_POINTS = 10_000

/** ブーリアン演算の名前（画面と CLI のメッセージ用） */
export const BOOLEAN_LABELS: Record<BooleanOp, string> = {
  union: '合体',
  subtract: '差し引き',
  intersect: '交差',
  exclude: '除外',
}

/** ブーリアン演算ができるか（矩形・楕円・パスを 2 つ以上選んでいる） */
export const canBooleanPaths = canJoinPaths

/**
 * 選んだ矩形・楕円・パスにブーリアン演算をかけ、結果を 1 つのパス（contours と fillRule: 'evenodd'）に焼き込む（既存のデザインツールの Boolean groups を平らにしたもの）。
 * 合体・交差・除外は全部に、差し引きは最も背面の形から残りを引く。結果は最も背面のもの（id・名前・塗り・線・効果・マスクの指定）を引き継ぎ、残りは消す。
 * 形は塗りの形だけを見る（線の太さは含めない）。パスの開いた輪郭は閉じた形として扱い、頂点の角の丸めは曲線にして演算する。
 * 結果が空なら empty、頂点が多すぎれば too-many を返し、何も変えない
 */
export function booleanPaths<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  op: BooleanOp,
): { scene: T; id: NodeId | null; error?: 'empty' | 'too-many' } {
  const targets = joinable(scene, ids)
  if (targets.length < 2) return { scene, id: null }
  const [base] = targets
  const toParent = invert(getWorldMatrix(scene, base.parentId))
  const shapes = targets.map((node) => {
    const m = multiply(toParent, multiply(getWorldMatrix(scene, node.parentId), nodeMatrix(node)))
    const own = node.type === 'path' ? pathOutlines(node) : shapeContours(node)
    return {
      contours: own.map((contour) => ({ vertices: mapVertices(contour.vertices, (p) => applyMatrix(m, p)), closed: true })),
      fillRule: maskFillRule(node),
    }
  })
  const contours = booleanContours(shapes, op)
  if (contours.length === 0) return { scene, id: null, error: 'empty' }
  if (contours.reduce((sum, contour) => sum + contour.vertices.length, 0) > MAX_PATH_POINTS) return { scene, id: null, error: 'too-many' }
  const shape = pathFromContours(contours)
  const path: PathNode = { ...pathOnBase(base, shape), closed: true, fillRule: 'evenodd', startCap: 'none', endCap: 'none' }
  const removed = removeNodes(scene, targets.slice(1).map((node) => node.id))
  return { scene: { ...removed, nodes: { ...removed.nodes, [base.id]: path } }, id: base.id }
}

/** 分割できるか（輪郭を 2 つ以上持つパスを選んでいる） */
export function canSplitPaths(scene: Scene, ids: readonly NodeId[]): boolean {
  return ids.some((id) => {
    const node = scene.nodes[id]
    return node?.type === 'path' && node.contours.length > 0
  })
}

/**
 * 輪郭を 2 つ以上持つパスを、輪郭ごとのパスに分ける（既存のデザインツールの「分割」に当たる）。最初の輪郭は元のノード（id・端の形）のまま、
 * 2 つ目からは同じ見た目の新しいパスにして、元のすぐ手前に輪郭の順で置く（端の形は付けない）。返す ids は分けてできた全部のパス
 */
export function splitPaths<T extends Scene>(scene: T, ids: readonly NodeId[]): { scene: T; ids: NodeId[] } {
  let next = scene
  const result: NodeId[] = []
  for (const id of ids) {
    const node = next.nodes[id]
    if (node?.type !== 'path' || node.contours.length === 0) continue
    const m = nodeMatrix(node)
    const contours = pathContours(node).map((contour) => ({
      vertices: mapVertices(contour.vertices, (p) => applyMatrix(m, p)),
      closed: contour.closed,
    }))
    const [first, ...rest] = contours
    next = { ...next, nodes: { ...next.nodes, [id]: { ...node, ...pathFromContours([first]), rotation: 0 } } }
    result.push(id)
    const parentId = node.parentId
    const siblings = parentId === null ? next.rootIds : (next.nodes[parentId] as FrameNode).children
    let index = siblings.indexOf(id) + 1
    for (const contour of rest) {
      const part: PathNode = {
        ...node,
        ...pathFromContours([contour]),
        id: createId(),
        rotation: 0,
        startCap: 'none',
        endCap: 'none',
      }
      next = insertNode(next, part, parentId, index++)
      result.push(part.id)
    }
  }
  return { scene: next, ids: result }
}

/** マスクとして使う操作ができるか。選んだものがどれもマスクならやめる操作、背面のものがマスクにできればかける操作になる */
export function maskAction(scene: Scene, ids: readonly NodeId[]): 'set' | 'clear' | null {
  const targets = sortByDocumentOrder(scene, topLevelIds(scene, ids)).map((id) => scene.nodes[id])
  if (targets.length === 0) return null
  if (targets.every(isMaskNode)) return 'clear'
  return canMask(targets[0]) ? 'set' : null
}

/**
 * マスクとして使う（既存のデザインツールの「マスクとして使う」）。選んだものがどれもマスクなら、マスクをやめる。
 * 1 つだけ選んでいれば、それをマスクにする（同じ親の中で手前にある兄弟が切り取られる）。
 * いくつも選んでいれば、それらをフレーム（塗らず、はみ出しも隠さない）にまとめ、最も背面のものをマスクにする
 * （マスクの範囲が選んだものだけになる）。最も背面のものが矩形・楕円・パスでなければ何もしない。
 * maskType を渡すと、マスクの種類も決める（省くと今の種類のまま）。返す id は、まとめたフレーム（まとめなければマスクにしたノード）
 */
export function applyMask<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  groupName: string,
  maskType?: MaskType,
): { scene: T; id: NodeId | null } {
  const action = maskAction(scene, ids)
  if (action === null) return { scene, id: null }
  const targets = sortByDocumentOrder(scene, topLevelIds(scene, ids))
  if (action === 'clear') return { scene: patchNodes(scene, targets, () => ({ isMask: false })), id: null }
  const [maskId] = targets
  const masked = patchNodes(scene, [maskId], () => (maskType ? { isMask: true, maskType } : { isMask: true }))
  if (targets.length === 1) return { scene: masked, id: maskId }

  // 最も手前のものの親の、そのすぐ手前に、選んだものを囲むフレームを置いて中へ移す
  const bounds = getNodesBounds(scene, targets)!
  const front = scene.nodes[targets[targets.length - 1]]
  const parentId = front.parentId
  const siblings = parentId === null ? scene.rootIds : (scene.nodes[parentId] as FrameNode).children
  const origin = toLocal(scene, parentId, bounds)
  const frame: FrameNode = {
    ...createFrame({ x: origin.x, y: origin.y, width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) }),
    name: groupName,
    fills: [],
    clipContent: false,
  }
  let next = insertNode(masked, frame, parentId, siblings.indexOf(front.id) + 1)
  for (const id of targets) next = moveNode(next, id, frame.id)
  return { scene: next, id: frame.id }
}

/** パスに輪郭を描き足す。contour は親の座標系の頂点。枠は全部の輪郭に合わせ直し、回転は頂点に織り込む */
export function addContour<T extends Scene>(scene: T, id: NodeId, contour: Contour): T {
  if (contour.vertices.length < 2) return scene
  return reshapeContours(scene, id, (contours) => [...contours, contour])
}
