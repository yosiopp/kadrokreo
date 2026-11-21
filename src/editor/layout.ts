import {
  type Bounds,
  type Point,
  getNodesBounds,
  nodeMatrix,
  tidy,
  toLocal,
  transformRect,
} from '../document/geometry.ts'
import { clampSize, stretchedAxes, wraps } from '../document/autoLayout.ts'
import type { AutoLayout, FrameNode, NodeId, Scene, SceneNode, Sizing } from '../document/types.ts'
import { createFrame } from './nodes.ts'
import {
  type NodePatch,
  insertNode,
  moveNode,
  patchNodes,
  sortByDocumentOrder,
  topLevelIds,
  updateNode,
} from './operations.ts'

// オートレイアウト。フレームの子を children の順に並べ、必要ならフレームの大きさを中身に合わせる。
// 並べた結果は各ノードの x / y / width / height に書き込むので、描画や viewer はこの設定を知らなくてよい。
// ストアが、ページを変更するたびに relayout を通す。

/** テキストの大きさを中身に合わせ直す関数（components.ts の FitText と同じ形） */
type FitText = <T extends Scene>(scene: T, ids: readonly NodeId[]) => T

/** 伸ばすと大きさが変わり、子の並べ直しや、テキストの測り直しが要る。落ち着くまで繰り返す回数の上限 */
const MAX_PASSES = 4

/**
 * 自動で並べるフレームをすべて並べ直す。何も動かなければ同じ参照を返す。
 * fitText を渡すと、親いっぱいに伸ばして幅が変わったテキストの高さを測り直す。
 */
export function relayout<T extends Scene>(scene: T, fitText?: FitText): T {
  let current = scene
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = relayoutOnce(current, fitText)
    if (next === current) break
    current = next
  }
  return current
}

function relayoutOnce<T extends Scene>(scene: T, fitText: FitText | undefined): T {
  // 子のフレームを先に並べる（中身に合わせた大きさが、親の並びに影響する）
  const frames: NodeId[] = []
  const visit = (ids: readonly NodeId[]) => {
    for (const id of ids) {
      const node = scene.nodes[id]
      if (node.type !== 'frame') continue
      visit(node.children)
      if (node.layout) frames.push(id)
    }
  }
  visit(scene.rootIds)
  const arranged = frames.reduce((next, id) => layoutFrame(next, id), scene)
  if (!fitText || arranged === scene) return arranged
  // 伸ばして幅が変わった、折り返すテキスト
  const resized = Object.values(arranged.nodes).flatMap((node) =>
    node.type === 'text' && node.sizing.width !== 'hug' && scene.nodes[node.id].width !== node.width ? [node.id] : [],
  )
  return resized.length > 0 ? fitText(arranged, resized) : arranged
}

/** 親の座標系で、子を囲む矩形。回っている子は、囲む矩形の大きさで場所を取る */
function boxOf(node: SceneNode): Bounds {
  return transformRect(nodeMatrix(node), { x: 0, y: 0, width: node.width, height: node.height })
}

/** フレームの子のうち、並べる対象になるもの。非表示の子と、並びから外した子は場所を取らない */
function visibleItems(scene: Scene, frame: FrameNode): { node: SceneNode; box: Bounds }[] {
  return frame.children
    .map((childId) => scene.nodes[childId])
    .filter((node) => node.visible && node.layoutPositioning !== 'absolute')
    .map((node) => ({ node, box: boxOf(node) }))
}

type LayoutItem = { node: SceneNode; box: Bounds; fillMain: boolean; fillCross: boolean }

/** 折り返すかどうかを決めるときの、数え間違いの遊び（端数で 1 つだけ次の行へ落ちないように） */
const WRAP_EPSILON = 0.01

function layoutFrame<T extends Scene>(scene: T, id: NodeId): T {
  const frame = scene.nodes[id]
  if (frame.type !== 'frame' || !frame.layout) return scene
  const { direction, gap, crossGap, align, justify } = frame.layout
  const horizontal = direction === 'horizontal'
  // 並べる向き（main）と、それに直交する向き（cross）で考える
  const mainAxis = horizontal ? 'width' : 'height'
  const crossAxis = horizontal ? 'height' : 'width'
  const main = (size: { width: number; height: number }) => size[mainAxis]
  const cross = (size: { width: number; height: number }) => size[crossAxis]
  const { paddingTop: top, paddingRight: right, paddingBottom: bottom, paddingLeft: left } = frame.layout
  const padStart = horizontal ? left : top
  const padEnd = horizontal ? right : bottom
  const crossStart = horizontal ? top : left
  const crossEnd = horizontal ? bottom : right
  const hugMain = frame.sizing[mainAxis] === 'hug'
  const hugCross = frame.sizing[crossAxis] === 'hug'
  // 中身に合わせる向きは、行の長さに限りがないので折り返さない
  const wrap = wraps(frame)

  const items: LayoutItem[] = visibleItems(scene, frame).map((item) => {
    const axes = stretchedAxes(scene, item.node)
    return { ...item, fillMain: axes[mainAxis], fillCross: axes[crossAxis] }
  })
  const frameMainBefore = main(frame)
  const innerMainBefore = frameMainBefore - padStart - padEnd

  // 行に分ける。伸ばすものは、下限（なければ 0）の大きさとして数える（CSS の flex: 1 0 0 と同じ）
  const basis = (item: LayoutItem) => (item.fillMain ? clampSize(item.node, mainAxis, 0) : main(item.box))
  const lines: LayoutItem[][] = []
  let used = 0
  for (const item of items) {
    const line = lines.at(-1)
    const size = basis(item)
    if (line && !(wrap && used + gap + size > innerMainBefore + WRAP_EPSILON)) {
      line.push(item)
      used += gap + size
    } else {
      lines.push([item])
      used = size
    }
  }

  // 並べる向きの大きさ。伸ばすものは、行ごとに、ほかの子と間隔を除いた残りを分け合う
  const mainSize = new Map<NodeId, number>()
  for (const line of lines) {
    const fills = line.filter((item) => item.fillMain)
    const fixed = line.reduce((sum, item) => sum + (item.fillMain ? 0 : main(item.box)), 0)
    const shares = distribute(
      innerMainBefore - gap * (line.length - 1) - fixed,
      fills.map((item) => item.node),
      mainAxis,
    )
    for (const item of line) mainSize.set(item.node.id, item.fillMain ? shares[fills.indexOf(item)] : main(item.box))
  }
  const lineMain = (line: LayoutItem[]) =>
    line.reduce((sum, item) => sum + (mainSize.get(item.node.id) ?? 0), 0) + gap * Math.max(0, line.length - 1)
  // 中身に合わせるときは折り返さないので、行は 1 つ
  const frameMain = hugMain
    ? clampSize(frame, mainAxis, (lines[0] ? lineMain(lines[0]) : 0) + padStart + padEnd)
    : frameMainBefore

  // 直交する向き。直交する向きに伸ばすものは、ほかの子の大きさに合わせるので、中身の大きさには数えない
  // （全部がそうなら、全部で数える）
  const contentCrossOf = (line: LayoutItem[]) => {
    const sizing = line.some((item) => !item.fillCross) ? line.filter((item) => !item.fillCross) : line
    return Math.max(0, ...sizing.map((item) => cross(item.box)))
  }
  const lineCross = lines.map(contentCrossOf)
  const contentCross = wrap
    ? lineCross.reduce((sum, size) => sum + size, 0) + crossGap * Math.max(0, lines.length - 1)
    : Math.max(0, ...lineCross)
  const frameCross = hugCross ? clampSize(frame, crossAxis, contentCross + crossStart + crossEnd) : cross(frame)
  const innerCross = Math.max(1, frameCross - crossStart - crossEnd)
  // 各行の始まりと大きさ。折り返さなければ、1 つの行が余白の内側いっぱいを使う。
  // 折り返すなら、行の大きさは中身で決まり、行のまとまりを揃え方に従って置く（CSS の align-content）
  const lineStarts: number[] = []
  if (wrap) {
    const free = innerCross - contentCross
    // 均等に配るなら、余りを行の間に足す（余りがないか、行が 1 つなら先頭に寄せる。CSS の space-between と同じ）
    const between = frame.layout.alignContent === 'space-between'
    const spread = between && lines.length > 1 && free > 0 ? free / (lines.length - 1) : 0
    let at = crossStart + (between ? 0 : align === 'center' ? free / 2 : align === 'end' ? free : 0)
    for (const size of lineCross) {
      lineStarts.push(at)
      at += size + crossGap + spread
    }
  } else {
    lineStarts.push(crossStart)
    lineCross.fill(innerCross)
  }

  const patches = new Map<NodeId, NodePatch>()
  lines.forEach((line, index) => {
    const lineStart = lineStarts[index]
    const lineSize = lineCross[index]
    // 並べる向きに余った分を、寄せ方に従って配る（伸ばすものがあれば余りはない）
    const free = frameMain - padStart - padEnd - lineMain(line)
    let cursor = padStart
    let step = gap
    if (!line.some((item) => item.fillMain)) {
      if (justify === 'center') cursor += free / 2
      else if (justify === 'end') cursor += free
      else if (justify === 'space-between' && line.length > 1 && free > 0) step += free / (line.length - 1)
    }
    for (const item of line) {
      const { node, box } = item
      const sizeMain = mainSize.get(node.id) ?? main(box)
      const sizeCross = item.fillCross ? Math.max(1, clampSize(node, crossAxis, lineSize)) : cross(box)
      const crossAt =
        item.fillCross || align === 'start'
          ? lineStart
          : align === 'center'
            ? lineStart + (lineSize - sizeCross) / 2
            : lineStart + lineSize - sizeCross
      const target = horizontal ? { x: cursor, y: crossAt } : { x: crossAt, y: cursor }
      const patch: NodePatch = {
        x: tidy(node.x + target.x - box.x),
        y: tidy(node.y + target.y - box.y),
      }
      // 伸ばすものは回っていないので、囲む矩形とノードの枠が同じ
      if (item.fillMain || item.fillCross) {
        patch.x = tidy(target.x)
        patch.y = tidy(target.y)
        patch.width = Math.max(1, tidy(horizontal ? sizeMain : sizeCross))
        patch.height = Math.max(1, tidy(horizontal ? sizeCross : sizeMain))
      }
      patches.set(node.id, patch)
      cursor += sizeMain + step
    }
  })
  patches.set(id, {
    width: Math.max(1, tidy(horizontal ? frameMain : frameCross)),
    height: Math.max(1, tidy(horizontal ? frameCross : frameMain)),
  })
  return patchNodes(scene, patches.keys(), (node) => patches.get(node.id) ?? null)
}

/**
 * total を nodes で等分する。下限・上限に引っかかったものはその大きさに留め、残りをほかで分け直す
 * （CSS の flex の伸び方と同じ手順）。どれも 1 より小さくはしない
 */
function distribute(total: number, nodes: readonly SceneNode[], axis: 'width' | 'height'): number[] {
  const sizes = nodes.map(() => 0)
  const frozen = nodes.map(() => false)
  for (let round = 0; round <= nodes.length; round++) {
    const open = nodes.flatMap((_, index) => (frozen[index] ? [] : [index]))
    if (open.length === 0) break
    const rest = total - sizes.reduce((sum, size, index) => sum + (frozen[index] ? size : 0), 0)
    const share = Math.max(1, rest / open.length)
    const clamped = open.map((index) => Math.max(1, clampSize(nodes[index], axis, share)))
    const violation = clamped.reduce((sum, size) => sum + size - share, 0)
    if (Math.abs(violation) < 1e-9) {
      open.forEach((index, k) => (sizes[index] = clamped[k]))
      break
    }
    // 下限で広がった分が多ければ下限に、上限で縮んだ分が多ければ上限に掛かったものを留める
    open.forEach((index, k) => {
      if (violation > 0 ? clamped[k] > share : clamped[k] < share) {
        sizes[index] = clamped[k]
        frozen[index] = true
      }
    })
  }
  return sizes
}

const DEFAULT_LAYOUT: AutoLayout = {
  direction: 'horizontal',
  gap: 10,
  paddingTop: 10,
  paddingRight: 10,
  paddingBottom: 10,
  paddingLeft: 10,
  align: 'start',
  justify: 'start',
  wrap: false,
  crossGap: 10, alignContent: 'auto',
}

/**
 * フレームを自動で並べるようにする。見た目がなるべく変わらないよう、
 * いまの子の並び方から向き・順番・間隔・余白を決める。
 */
export function enableAutoLayout<T extends Scene>(scene: T, id: NodeId): T {
  const frame = scene.nodes[id]
  if (frame?.type !== 'frame' || frame.layout) return scene

  const items = visibleItems(scene, frame)
  // 大きさは中身に合わせる。親いっぱいに伸ばしている向きはそのまま
  const sizing = {
    width: frame.sizing.width === 'fill' ? 'fill' : 'hug',
    height: frame.sizing.height === 'fill' ? 'fill' : 'hug',
  } as const
  if (items.length === 0) return updateNode(scene, id, { layout: DEFAULT_LAYOUT, sizing })

  // 子の中心が、横と縦のどちらに広がっているかで向きを決める
  const centers = items.map(({ box }) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 }))
  const spread = (axis: 'x' | 'y') =>
    Math.max(...centers.map((c) => c[axis])) - Math.min(...centers.map((c) => c[axis]))
  const horizontal = spread('x') >= spread('y')
  const axis = horizontal ? 'x' : 'y'
  const size = horizontal ? 'width' : 'height'

  // いまの位置の順に並べる。非表示の子は、元の順のまま後ろへ回す
  const sorted = items.toSorted((a, b) => a.box[axis] - b.box[axis])
  const hidden = frame.children.filter((childId) => !scene.nodes[childId].visible)
  const children = [...sorted.map((item) => item.node.id), ...hidden]

  // 間隔は、隣り合う子の隙間の平均。重なっていれば 0
  const gaps = sorted.slice(1).map((item, i) => item.box[axis] - (sorted[i].box[axis] + sorted[i].box[size]))
  const gap = gaps.length > 0 ? Math.max(0, Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)) : 10
  // 余白は、いまの子を囲む矩形とフレームの辺との隙間
  const left = Math.min(...items.map((item) => item.box.x))
  const top = Math.min(...items.map((item) => item.box.y))
  const right = frame.width - Math.max(...items.map((item) => item.box.x + item.box.width))
  const bottom = frame.height - Math.max(...items.map((item) => item.box.y + item.box.height))

  const layout: AutoLayout = {
    ...DEFAULT_LAYOUT,
    direction: horizontal ? 'horizontal' : 'vertical',
    gap,
    crossGap: gap,
    paddingTop: Math.max(0, Math.round(top)),
    paddingRight: Math.max(0, Math.round(right)),
    paddingBottom: Math.max(0, Math.round(bottom)),
    paddingLeft: Math.max(0, Math.round(left)),
  }
  const next = { ...frame, children, layout, sizing } satisfies FrameNode
  return relayout({ ...scene, nodes: { ...scene.nodes, [id]: next } })
}

/**
 * 選んだノードを、自動で並べる新しいフレームにまとめる。
 * フレームは、まとめたノードのうち最も手前にあったものの位置に入る。
 */
export function wrapInAutoLayout<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  name: string,
): { scene: T; id: NodeId | null } {
  const targets = sortByDocumentOrder(scene, topLevelIds(scene, ids))
  const bounds = getNodesBounds(scene, targets)
  if (!bounds) return { scene, id: null }

  // 同じ親の中でまとめる。親が混ざっていたら、最も手前のノードの親に合わせる
  const front = scene.nodes[targets[targets.length - 1]]
  const parentId = front.parentId
  const siblings = parentId === null ? scene.rootIds : (scene.nodes[parentId] as FrameNode).children
  const origin = toLocal(scene, parentId, bounds)
  const frame: FrameNode = {
    ...createFrame({ x: origin.x, y: origin.y, width: bounds.width, height: bounds.height }),
    name,
    // まとめるだけの枠なので、塗らず、はみ出しも隠さない
    fills: [],
    clipContent: false,
  }

  let next = insertNode(scene, frame, parentId, siblings.indexOf(front.id) + 1)
  for (const id of targets) next = moveNode(next, id, frame.id)
  return { scene: enableAutoLayout(next, frame.id), id: frame.id }
}

/**
 * 自動で並べるフレームの中へ、ポインタの位置に応じた順番で入れる（並べ替える）。
 * point はページ座標。
 */
export function placeInLayout<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  parentId: NodeId,
  point: Point,
): T {
  const parent = scene.nodes[parentId]
  if (parent?.type !== 'frame' || !parent.layout) return scene
  const horizontal = parent.layout.direction === 'horizontal'
  const axis = horizontal ? 'x' : 'y'
  const size = horizontal ? 'width' : 'height'
  const crossAxis = horizontal ? 'y' : 'x'
  const crossSize = horizontal ? 'height' : 'width'
  const local = toLocal(scene, parentId, point)

  const moving = sortByDocumentOrder(scene, topLevelIds(scene, ids))
  const others = parent.children.filter((id) => !moving.includes(id))
  const flow = others.flatMap((id) => {
    const node = scene.nodes[id]
    return node.visible && node.layoutPositioning !== 'absolute' ? [{ id, box: boxOf(node) }] : []
  })
  // 折り返していれば、並びを行に分ける（前のものより先頭の側へ戻ったところで次の行）。
  // ポインタのある行より前の行のものと、同じ行でポインタより手前に中心があるものの後ろへ入れる
  const lines: (typeof flow)[] = []
  for (const item of flow) {
    const line = lines.at(-1)
    const previous = line?.at(-1)
    const wrapped = parent.layout.wrap && previous !== undefined && item.box[axis] <= previous.box[axis]
    if (line && !wrapped) line.push(item)
    else lines.push([item])
  }
  const lineEnd = (line: typeof flow) => Math.max(...line.map((item) => item.box[crossAxis] + item.box[crossSize]))
  const found = lines.findIndex((line) => local[crossAxis] <= lineEnd(line))
  const pointerLine = found === -1 ? lines.length - 1 : found
  const before = lines.flatMap((line, index) => {
    if (index > pointerLine) return []
    const passed = index < pointerLine ? line : line.filter((item) => item.box[axis] + item.box[size] / 2 < local[axis])
    return passed.map((item) => item.id)
  })
  const anchor = before.at(-1)
  // 1 つずつ anchor の直後へ入れていく。まだ動かしていないノードが間に残っていても順番が狂わないよう、
  // anchor の位置は毎回数え直す
  return moving.reduce((next, id, placed) => {
    const siblings = (next.nodes[parentId] as FrameNode).children.filter((other) => other !== id)
    const start = anchor === undefined ? 0 : siblings.indexOf(anchor) + 1
    return moveNode(next, id, parentId, start + placed)
  }, scene)
}

/**
 * ids を、axis の向きに親いっぱいまで伸ばす（value が false なら固定の大きさに戻す）。親が自動で並べていないものは変えない。
 * 伸ばせるように、親がその向きを中身に合わせているなら固定にする。
 * テキストを横に伸ばすと幅に合わせて折り返す（sizing.width が hug でなくなるため）。テキストの高さは伸ばさない
 */
export function setLayoutFill<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  axis: 'width' | 'height',
  value: boolean,
): T {
  return ids.reduce((next, id) => {
    const node = next.nodes[id]
    const parent = node?.parentId === null || !node ? null : next.nodes[node.parentId]
    if (!node || parent?.type !== 'frame' || !parent.layout) return next
    if (node.type === 'text' && axis === 'height') return next
    if (!value) {
      return node.sizing[axis] === 'fill' ? updateNode(next, id, { sizing: { ...node.sizing, [axis]: 'fixed' } }) : next
    }
    let changed = updateNode(next, id, { sizing: { ...node.sizing, [axis]: 'fill' } })
    const along = (parent.layout.direction === 'horizontal') === (axis === 'width')
    if (along && parent.sizing[axis] === 'hug') {
      changed = updateNode(changed, parent.id, { sizing: { ...parent.sizing, [axis]: 'fixed' } })
    }
    return changed
  }, scene)
}

/** id が、自動で並べるフレームの並びに加わっている子なら、その親 */
export function flowParent(scene: Scene, id: NodeId): FrameNode | null {
  const node = scene.nodes[id]
  const parent = node?.parentId === null || !node ? null : scene.nodes[node.parentId]
  if (parent?.type !== 'frame' || !parent.layout || node.layoutPositioning === 'absolute') return null
  return parent
}

/**
 * 自動で並べるフレームの中で、ids を 1 つ前（step = -1）か後ろ（step = 1）へ並べ替える。
 * 非表示の子や並びから外した子は飛ばして数える。ids がみな同じフレームの並びに加わっていなければ変えない。
 * 端にあるものがあれば、まとめて動かせないので変えない。
 */
export function moveInLayout<T extends Scene>(scene: T, ids: readonly NodeId[], step: -1 | 1): T {
  const parents = new Set(ids.map((id) => flowParent(scene, id)?.id ?? null))
  const parentId = parents.size === 1 ? [...parents][0] : null
  if (parentId === null) return scene
  const parent = scene.nodes[parentId] as FrameNode
  const flow = parent.children.filter((id) => {
    const node = scene.nodes[id]
    return node.visible && node.layoutPositioning !== 'absolute'
  })
  const selected = new Set(ids)
  // 並びの中で、選んだものとそれ以外を入れ替えた新しい順番を作る
  const order = [...flow]
  const indices = order.flatMap((id, index) => (selected.has(id) ? [index] : []))
  if (indices.length === 0) return scene
  if ((step < 0 && indices[0] === 0) || (step > 0 && indices.at(-1) === order.length - 1)) return scene
  for (const index of step < 0 ? indices : indices.toReversed()) {
    const target = index + step
    ;[order[index], order[target]] = [order[target], order[index]]
  }
  // 並びに加わっていない子は、もとの位置のまま、並びに加わる子だけを新しい順に入れ直す
  let cursor = 0
  const children = parent.children.map((id) => (flow.includes(id) ? order[cursor++] : id))
  return { ...scene, nodes: { ...scene.nodes, [parentId]: { ...parent, children } } }
}

/**
 * ids を自動で並べるフレームの並びから外す（value が 'absolute'）か、並びに戻す（'auto'）。
 * 外すときは、いまの位置のまま置く。親が自動で並べていないものは変えない
 */
export function setLayoutPositioning<T extends Scene>(
  scene: T,
  ids: readonly NodeId[],
  value: 'auto' | 'absolute',
): T {
  return ids.reduce((next, id) => {
    const node = next.nodes[id]
    const parent = node?.parentId === null || !node ? null : next.nodes[node.parentId]
    if (parent?.type !== 'frame' || !parent.layout) return next
    // 並びから外したものは、親いっぱいに伸ばさない
    const unfill = (sizing: SceneNode['sizing']['width']) => (sizing === 'fill' ? 'fixed' : sizing)
    return updateNode(next, id, {
      layoutPositioning: value,
      ...(value === 'absolute' ? { sizing: { width: unfill(node.sizing.width), height: unfill(node.sizing.height) } } : {}),
    })
  }, scene)
}

/**
 * 自動で並べるフレーム ids を折り返すようにする（value が false ならやめる）。
 * 並べる向きを中身に合わせていると折り返す場所がないので、その向きを固定にする（既存のデザインツールと同じ）
 */
export function setLayoutWrap<T extends Scene>(scene: T, ids: readonly NodeId[], value: boolean): T {
  return patchNodes(scene, ids, (node) => {
    if (node.type !== 'frame' || !node.layout) return null
    const axis = node.layout.direction === 'horizontal' ? 'width' : 'height'
    const fixed = value && node.sizing[axis] === 'hug' ? { sizing: { ...node.sizing, [axis]: 'fixed' as const } } : {}
    return { layout: { ...node.layout, wrap: value }, ...fixed }
  })
}

/** ids のうち自動で並べているフレームだけ、設定の一部を書き換える */
export function patchLayouts<T extends Scene>(scene: T, ids: readonly NodeId[], patch: Partial<AutoLayout>): T {
  return patchNodes(scene, ids, (node) =>
    node.type === 'frame' && node.layout ? { layout: { ...node.layout, ...patch } } : null,
  )
}

/** フレーム ids を自動で並べるようにする（enabled が false ならやめる）。フレームでないものは変えない */
export function setAutoLayoutEnabled<T extends Scene>(scene: T, ids: readonly NodeId[], enabled: boolean): T {
  return ids.reduce(
    (next, id) =>
      enabled ? enableAutoLayout(next, id) : next.nodes[id]?.type === 'frame' ? disableAutoLayout(next, id) : next,
    scene,
  )
}

/**
 * 自動で並べるフレーム ids の、axis の向きの大きさの決め方を変える（中身に合わせる・固定・親いっぱい）。
 * 親いっぱいは setLayoutFill を通す（親の設定も合わせるため）
 */
export function setFrameSizing<T extends Scene>(scene: T, ids: readonly NodeId[], axis: 'width' | 'height', value: Sizing): T {
  if (value === 'fill') return setLayoutFill(scene, ids.filter((id) => scene.nodes[id]?.type === 'frame'), axis, true)
  return patchNodes(scene, ids, (node) =>
    node.type === 'frame' && node.layout && node.sizing[axis] !== value ? { sizing: { ...node.sizing, [axis]: value } } : null,
  )
}

/** 自動で並べるのをやめる。中身に合わせていた向きは、いまの大きさで固定にする */
function disableAutoLayout<T extends Scene>(scene: T, id: NodeId): T {
  const node = scene.nodes[id]
  const unhug = (sizing: SceneNode['sizing']['width']) => (sizing === 'hug' ? 'fixed' : sizing)
  return updateNode(scene, id, { layout: null, sizing: { width: unhug(node.sizing.width), height: unhug(node.sizing.height) } })
}
