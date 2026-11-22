import { BOOLEAN_OPERATION_LABELS, booleanBounds, booleanResult, canBoolean, isBooleanNode } from '../../document/booleanNode.ts'
import { applyMatrix, getNodesBounds, nodeMatrix, tidy, toLocal } from '../../document/geometry.ts'
import { mapVertices, pathFromContours } from '../../document/path.ts'
import type { BooleanOperation, FrameNode, NodeId, PathNode, Scene } from '../../document/types.ts'
import { createFrame, createPath } from '../nodes.ts'
import { MAX_PATH_POINTS } from './paths.ts'
import { insertNode, moveNode, patchNodes, removeNodes, sortByDocumentOrder, topLevelIds } from './tree.ts'

// ブーリアン演算のノード（元の図形を子に残し、結果を描くフレーム。document/booleanNode.ts）を作る・変える・平らにする操作と、
// 枠を結果に合わせる後始末。どれも純粋な関数で、何も変わらなければ同じ参照を返す。

/** 演算のノードにまとめられる選択か（テキスト以外を 2 つ以上選んでいる） */
export function canCreateBooleanNode(scene: Scene, ids: readonly NodeId[]): boolean {
  return topLevelIds(scene, ids).filter((id) => canBoolean(scene.nodes[id])).length >= 2
}

/**
 * 選んだもの（テキスト以外）を、演算のノードにまとめる（既存のデザインツールの Boolean groups）。元の図形は子として残り、結果はノードが描く。
 * 塗り・線・効果は最も背面の子（矩形・楕円・パス・フレームのとき）から引き継ぐ（既存のデザインツールと同じ）。ノードは最も手前のもののすぐ手前に置く。
 * テキストは演算に入らないので、選んでいてもまとめない。返す id は作ったノード
 */
export function createBooleanNode<T extends Scene>(scene: T, ids: readonly NodeId[], op: BooleanOperation): { scene: T; id: NodeId | null } {
  const targets = sortByDocumentOrder(scene, topLevelIds(scene, ids)).filter((id) => canBoolean(scene.nodes[id]))
  if (targets.length < 2) return { scene, id: null }
  const base = scene.nodes[targets[0]]
  const bounds = getNodesBounds(scene, targets)!
  const front = scene.nodes[targets[targets.length - 1]]
  const parentId = front.parentId
  const siblings = parentId === null ? scene.rootIds : (scene.nodes[parentId] as FrameNode).children
  const origin = toLocal(scene, parentId, bounds)
  const styled = 'strokes' in base
  const frame: FrameNode = {
    ...createFrame({ x: origin.x, y: origin.y, width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) }),
    name: BOOLEAN_OPERATION_LABELS[op],
    fills: styled ? base.fills : [],
    strokes: styled ? base.strokes : [],
    strokeWidth: styled ? base.strokeWidth : 1,
    strokeDashes: styled ? base.strokeDashes : [],
    effects: base.effects,
    clipContent: false,
    booleanOperation: op,
  }
  let next = insertNode(scene, frame, parentId, siblings.indexOf(front.id) + 1)
  for (const id of targets) next = moveNode(next, id, frame.id)
  return { scene: fitBooleanNodes(next), id: frame.id }
}

/**
 * 演算のノードの演算を変える。演算のノードでないものは変えない。
 * 枠はここでは合わせない（ストアの後始末 fitBooleanNodes が合わせる。ここで大きさを変えると、利用者が拡大したものとして子も拡大されてしまう）
 */
export function setBooleanOperation<T extends Scene>(scene: T, ids: readonly NodeId[], op: BooleanOperation): T {
  const targets = ids.filter((id) => {
    const node = scene.nodes[id]
    return node && isBooleanNode(node) && node.booleanOperation !== op
  })
  return targets.length === 0 ? scene : patchNodes(scene, targets, () => ({ booleanOperation: op }))
}

/** 平らにできるか（演算のノードを選んでいる） */
export function canFlattenBoolean(scene: Scene, ids: readonly NodeId[]): boolean {
  return ids.some((id) => scene.nodes[id] && isBooleanNode(scene.nodes[id]))
}

/**
 * 演算のノードを、結果の形のパス（contours と fillRule: 'evenodd'）に焼き込み、子を消す（既存のデザインツールの「平らにする」）。
 * id・名前・塗り・線・効果はノードのまま。結果が空か頂点が多すぎるノードはそのままにし、error で知らせる。返す ids は焼き込んだパス
 */
export function flattenBooleanNodes<T extends Scene>(scene: T, ids: readonly NodeId[]): { scene: T; ids: NodeId[]; error?: 'empty' | 'too-many' } {
  let next = scene
  const done: NodeId[] = []
  let error: 'empty' | 'too-many' | undefined
  for (const id of topLevelIds(scene, ids)) {
    const node = next.nodes[id]
    if (!node || !isBooleanNode(node)) continue
    const m = nodeMatrix(node)
    const contours = booleanResult(next, node).map((contour) => ({ vertices: mapVertices(contour.vertices, (p) => applyMatrix(m, p)), closed: true }))
    if (contours.length === 0) {
      error = 'empty'
      continue
    }
    if (contours.reduce((sum, contour) => sum + contour.vertices.length, 0) > MAX_PATH_POINTS) {
      error = 'too-many'
      continue
    }
    const shape = pathFromContours(contours)
    const path: PathNode = {
      ...createPath(shape, true),
      contours: shape.contours,
      id: node.id,
      name: node.name,
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
      fills: node.fills,
      strokes: node.strokes,
      strokeWidth: node.strokeWidth,
      strokeDashes: node.strokeDashes,
      effects: node.effects,
      fillRule: 'evenodd',
    }
    const removed = removeNodes(next, node.children)
    next = { ...removed, nodes: { ...removed.nodes, [id]: path } }
    done.push(id)
  }
  return error ? { scene: next, ids: done, error } : { scene: next, ids: done }
}

/** 枠と結果を囲む矩形のずれがこれ以下なら合わせ直さない（px） */
const FIT_EPSILON = 0.02

/**
 * 演算のノードの枠を、結果を囲む矩形に合わせる（既存のデザインツールと同じく、子を動かすと枠が結果に付いてくる）。
 * 子をずらしてノードの左上を結果の左上にし、ページ上の見た目は変えない。入れ子は内側から合わせる。
 * 結果が空のノードはそのまま。ストアが変更のたびに通す
 */
export function fitBooleanNodes<T extends Scene>(scene: T): T {
  const order: NodeId[] = []
  const visit = (ids: readonly NodeId[]) => {
    for (const id of ids) {
      const node = scene.nodes[id]
      if (node?.type !== 'frame') continue
      visit(node.children)
      if (node.booleanOperation !== null) order.push(id)
    }
  }
  visit(scene.rootIds)
  return order.reduce((current, id) => fitOne(current, id), scene)
}

function fitOne<T extends Scene>(scene: T, id: NodeId): T {
  const node = scene.nodes[id]
  if (!isBooleanNode(node)) return scene
  const box = booleanBounds(scene, node)
  if (!box) return scene
  const near = (a: number, b: number) => Math.abs(a - b) <= FIT_EPSILON
  if (near(box.x, 0) && near(box.y, 0) && near(box.width, node.width) && near(box.height, node.height)) return scene
  const width = Math.max(tidy(box.width), 0.01)
  const height = Math.max(tidy(box.height), 0.01)
  // 新しい枠の左上は、今の枠での結果の左上（ページ上で動かさない）。回したノードでは回す軸（枠の中心）も変わるので、それを打ち消す
  const target = applyMatrix(nodeMatrix(node), box)
  const offset = applyMatrix(nodeMatrix({ x: 0, y: 0, width, height, rotation: node.rotation }), { x: 0, y: 0 })
  // 子は（ずれが 0 でも）新しいオブジェクトにする。ストアの後始末は「変わっていない子」を親の大きさの変化に追従させるので、
  // 枠合わせで変わった大きさに子が拡大されないよう、子も変わったことにする
  const nodes = { ...scene.nodes }
  for (const childId of node.children) {
    const child = nodes[childId]
    if (child) nodes[childId] = { ...child, x: tidy(child.x - box.x), y: tidy(child.y - box.y) }
  }
  nodes[id] = { ...node, x: tidy(target.x - offset.x), y: tidy(target.y - offset.y), width, height }
  return { ...scene, nodes }
}
