import { useEffect, useReducer, useRef, useState } from 'react'
import { type CanvasPointer, CanvasView } from '../canvas/CanvasView.tsx'
import type { Camera } from '../canvas/camera.ts'
import { isTextInput } from '../canvas/dom.ts'
import { type Viewport, worldToScreen } from '../canvas/viewport.ts'
import {
  type Bounds,
  type Point,
  boundsFromPoints,
  getAbsoluteBounds,
  getAbsolutePosition,
  getContentBounds,
  getNodesBounds,
} from '../document/geometry.ts'
import type { DesignDocument, LineNode, NodeId, SceneNode, TextNode } from '../document/types.ts'
import { TextEditor } from './TextEditor.tsx'
import { findFrameAt, hitTest, hitTestFrameLabel, nodesInMarquee } from './hitTest.ts'
import { fitTextNodes, measureFrameLabel, measureTextNode } from './measure.ts'
import { createEllipse, createFrame, createLine, createRect, createText } from './nodes.ts'
import {
  type Fragment,
  type ReorderDirection,
  copyFragment,
  insertNode,
  pasteFragment,
  removeNodes,
  reorderNodes,
  reparentNodes,
  resizeNodes,
  translateNodes,
  updateNode,
} from './operations.ts'
import { HANDLES, type Handle, handleCursor, handlePoint, resizeBounds } from './resize.ts'
import { type Guide, findGuides, snapMove, snapResize } from './snap.ts'
import type { EditorState, EditorStore } from './store.ts'

export type Tool = 'select' | 'frame' | 'rect' | 'ellipse' | 'line' | 'text'

type Props = {
  store: EditorStore
  camera: Camera
  state: EditorState
  tool: Tool
  onToolChange: (tool: Tool) => void
  /** クリップボードから画像が貼り付けられた */
  onPasteImages: (files: File[]) => void
}

type Gesture =
  // ノードの上で押しただけの状態。少し動かすと move になる
  | { kind: 'press'; screen: Point; world: Point; collapseTo: NodeId | null }
  | { kind: 'move'; world: Point; ids: NodeId[]; from: Bounds; guides: Guide[] }
  | { kind: 'resize'; world: Point; handle: Handle; from: Bounds; ids: NodeId[]; guides: Guide[] }
  | { kind: 'marquee'; world: Point; current: Point; base: NodeId[] }
  | {
      kind: 'create'
      screen: Point
      world: Point
      node: SceneNode
      parentId: NodeId | null
      dragged: boolean
    }
  | { kind: 'text'; screen: Point; world: Point }
  // 直線の端をつかんでいる。fixed は動かさない側の端（ページ座標）
  | { kind: 'endpoint'; id: NodeId; fixed: Point }

/** draft は新規作成中のテキスト。確定するまでドキュメントには入れない */
type Editing = { id: NodeId; draft: { node: TextNode; parentId: NodeId | null } | null }

const ACCENT = '#0d99ff'
const GUIDE = '#f24822'
const SNAP_DISTANCE = 6
const DRAG_THRESHOLD = 4
const HANDLE_SIZE = 8
const NAMES = {
  frame: 'Frame',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  text: 'Text',
  image: 'Image',
} as const

function toScreenBounds(viewport: Viewport, bounds: Bounds): Bounds {
  return {
    ...worldToScreen(viewport, bounds),
    width: bounds.width * viewport.zoom,
    height: bounds.height * viewport.zoom,
  }
}

/** 小さく映っているときは辺のハンドルを出さない。角と重なってつかめなくなるため */
function visibleHandles(screen: Bounds): Handle[] {
  return HANDLES.filter((handle) => {
    if (handle.length === 2) return true
    return handle === 'n' || handle === 's' ? screen.width >= 24 : screen.height >= 24
  })
}

function roundPoint(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) }
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 直線の両端（ページ座標） */
function lineEnds(doc: DesignDocument, line: LineNode): [Point, Point] {
  const { x, y, width, height } = getAbsoluteBounds(doc, line.id)
  return line.direction === 'down'
    ? [{ x, y }, { x: x + width, y: y + height }]
    : [{ x, y: y + height }, { x: x + width, y }]
}

/** from から to へ引く直線の枠と向き */
function lineBetween(from: Point, to: Point): Bounds & Pick<LineNode, 'direction'> {
  const sameSign = (to.x - from.x) * (to.y - from.y) >= 0
  return { ...boundsFromPoints(from, to), direction: sameSign ? 'down' : 'up' }
}

/** from から見た to の向きを 45° 刻みに揃える */
function constrainAngle(from: Point, to: Point): Point {
  const step = Math.PI / 4
  const angle = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / step) * step
  const length = distance(from, to)
  return roundPoint({ x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length })
}

function nextName(doc: DesignDocument, type: SceneNode['type']): string {
  const count = Object.values(doc.nodes).filter((node) => node.type === type).length
  return `${NAMES[type]} ${count + 1}`
}

export function EditorCanvas({ store, camera, state, tool, onToolChange, onPasteImages }: Props) {
  const gestureRef = useRef<Gesture | null>(null)
  const editingRef = useRef<Editing | null>(null)
  const clipboardRef = useRef<{ fragment: Fragment; pastes: number } | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [hover, setHover] = useState<NodeId | null>(null)
  const [cursor, setCursor] = useState('default')
  const [, redraw] = useReducer((n: number) => n + 1, 0)

  function changeEditing(next: Editing | null) {
    editingRef.current = next
    setEditing(next)
  }

  /** 選択中のうち動かせるもの */
  function movableIds(): NodeId[] {
    const { document: doc, selection } = store.getState()
    return selection.filter((id) => !doc.nodes[id].locked)
  }

  /** 直線を 1 本だけ選んでいるとき。枠のハンドルの代わりに、両端をつかんで動かせる */
  function selectedLine(): LineNode | null {
    if (tool !== 'select' || editingRef.current) return null
    const { document: doc, selection } = store.getState()
    const node = selection.length === 1 ? doc.nodes[selection[0]] : null
    return node?.type === 'line' && !node.locked ? node : null
  }

  /** screen にある直線の端。あれば、動かさない側の端を返す */
  function endpointAt(screen: Point): { id: NodeId; fixed: Point } | null {
    const line = selectedLine()
    if (!line) return null
    const ends = lineEnds(store.getState().document, line)
    for (const [index, end] of ends.entries()) {
      if (distance(worldToScreen(camera.getViewport(), end), screen) <= HANDLE_SIZE) {
        return { id: line.id, fixed: ends[1 - index] }
      }
    }
    return null
  }

  /** リサイズハンドルを出す対象 */
  function resizeTarget(): { ids: NodeId[]; bounds: Bounds } | null {
    if (tool !== 'select' || editingRef.current || selectedLine()) return null
    const ids = movableIds()
    const bounds = getNodesBounds(store.getState().document, ids)
    return bounds && { ids, bounds }
  }

  /**
   * 吸着先になる矩形（ページ座標）。parentId の子と、parentId のフレーム自身。
   * 動かしている最中のノードは除く。
   */
  function snapTargets(parentId: NodeId | null, exclude: ReadonlySet<NodeId>): Bounds[] {
    const doc = store.getState().document
    const parent = parentId === null ? null : doc.nodes[parentId]
    const siblings = parent?.type === 'frame' ? parent.children : doc.rootIds
    const targets = siblings
      .filter((id) => !exclude.has(id) && doc.nodes[id].visible)
      .map((id) => getAbsoluteBounds(doc, id))
    if (parent) targets.push(getAbsoluteBounds(doc, parent.id))
    return targets
  }

  function handleAt(screen: Point): Handle | null {
    const target = resizeTarget()
    if (!target) return null
    const bounds = toScreenBounds(camera.getViewport(), target.bounds)
    // 角を先に調べる
    const handles = visibleHandles(bounds).toSorted((a, b) => b.length - a.length)
    for (const handle of handles) {
      const p = handlePoint(bounds, handle)
      if (Math.abs(p.x - screen.x) <= HANDLE_SIZE && Math.abs(p.y - screen.y) <= HANDLE_SIZE) {
        return handle
      }
    }
    return null
  }

  function pick(pointer: CanvasPointer): NodeId | null {
    const doc = store.getState().document
    const viewport = camera.getViewport()
    return (
      hitTestFrameLabel(doc, viewport, pointer.screen, measureFrameLabel) ??
      hitTest(doc, pointer.world, 3 / viewport.zoom)
    )
  }

  /** shape はページ座標の枠。直線なら向きも含む */
  function previewCreate(
    gesture: Extract<Gesture, { kind: 'create' }>,
    shape: Bounds & Partial<Pick<LineNode, 'direction'>>,
  ) {
    // 直線は水平・垂直に引けるよう、幅や高さが 0 でもよい
    const minSize = gesture.node.type === 'line' ? 0 : 1
    store.preview((base) => {
      const origin =
        gesture.parentId === null ? { x: 0, y: 0 } : getAbsolutePosition(base, gesture.parentId)
      const node = {
        ...gesture.node,
        ...shape,
        x: shape.x - origin.x,
        y: shape.y - origin.y,
        width: Math.max(minSize, shape.width),
        height: Math.max(minSize, shape.height),
      }
      return insertNode(base, node, gesture.parentId)
    })
  }

  /** width を渡すと、その幅で折り返すテキストになる */
  function startNewText(world: Point, width?: number) {
    const doc = store.getState().document
    // 既存のテキストの上をクリックしたら、新しく作らずそれを編集する
    const hit = hitTest(doc, world)
    if (hit && doc.nodes[hit].type === 'text') {
      store.select([hit])
      changeEditing({ id: hit, draft: null })
      return
    }
    const template: TextNode = {
      ...createText({ x: 0, y: 0, width: width ?? 0, height: 0 }),
      name: nextName(doc, 'text'),
      autoWidth: width === undefined,
    }
    const size = measureTextNode(template)
    const parentId = findFrameAt(doc, world)
    const origin = parentId === null ? { x: 0, y: 0 } : getAbsolutePosition(doc, parentId)
    // クリックで作ったときは、その位置が 1 行目の中央に来るように置く
    const lift = width === undefined ? (template.fontSize * template.lineHeight) / 2 : 0
    const node: TextNode = {
      ...template,
      ...size,
      x: Math.round(world.x - origin.x),
      y: Math.round(world.y - origin.y - lift),
    }
    store.preview((base) => insertNode(base, node, parentId))
    store.select([node.id])
    changeEditing({ id: node.id, draft: { node, parentId } })
  }

  function onTextInput(text: string) {
    const current = editingRef.current
    if (!current) return
    if (current.draft) {
      const { node, parentId } = current.draft
      const next = { ...node, text, ...measureTextNode({ ...node, text }) }
      store.preview((base) => insertNode(base, next, parentId))
      store.select([node.id])
    } else {
      const node = store.getState().document.nodes[current.id]
      if (node?.type !== 'text') return
      const size = measureTextNode({ ...node, text })
      store.preview((base) => updateNode(base, current.id, { text, ...size }))
    }
  }

  function finishEditing() {
    const current = editingRef.current
    if (!current) return
    changeEditing(null)
    const node = store.getState().document.nodes[current.id]
    if (node?.type === 'text' && node.text.trim() !== '') {
      store.commitPreview()
    } else {
      // 空のテキストは残さない
      store.cancelPreview()
      if (!current.draft) store.apply((doc) => removeNodes(doc, [current.id]))
    }
    onToolChange('select')
  }

  function onPointerDown(pointer: CanvasPointer) {
    if (editingRef.current) {
      // 編集中のクリックは確定だけして、選択などは行わない
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      finishEditing()
      return
    }
    setHover(null)
    const { document: doc, selection } = store.getState()

    if (tool === 'text') {
      gestureRef.current = { kind: 'text', screen: pointer.screen, world: pointer.world }
      return
    }
    if (tool !== 'select') {
      const world = roundPoint(pointer.world)
      const create = {
        frame: createFrame,
        rect: createRect,
        ellipse: createEllipse,
        line: createLine,
      }[tool]
      gestureRef.current = {
        kind: 'create',
        screen: pointer.screen,
        world,
        node: { ...create({ x: 0, y: 0, width: 1, height: 1 }), name: nextName(doc, tool) },
        parentId: findFrameAt(doc, world),
        dragged: false,
      }
      return
    }

    const endpoint = endpointAt(pointer.screen)
    if (endpoint) {
      gestureRef.current = { kind: 'endpoint', ...endpoint }
      return
    }

    const handle = handleAt(pointer.screen)
    const target = handle && resizeTarget()
    if (handle && target) {
      gestureRef.current = {
        kind: 'resize',
        world: pointer.world,
        handle,
        from: target.bounds,
        ids: target.ids,
        guides: [],
      }
      return
    }

    const hit = pick(pointer)
    if (!hit) {
      if (!pointer.shiftKey) store.select([])
      gestureRef.current = {
        kind: 'marquee',
        world: pointer.world,
        current: pointer.world,
        base: pointer.shiftKey ? selection : [],
      }
      return
    }

    let collapseTo: NodeId | null = null
    if (pointer.shiftKey) {
      const selected = selection.includes(hit)
      store.select(selected ? selection.filter((id) => id !== hit) : [...selection, hit])
      if (selected) return
    } else if (selection.includes(hit)) {
      // 複数選択の 1 つを押した場合、ドラッグなら全体を動かし、クリックだけならそれ 1 つに絞る
      collapseTo = hit
    } else {
      store.select([hit])
    }
    gestureRef.current = { kind: 'press', screen: pointer.screen, world: pointer.world, collapseTo }
  }

  function onPointerMove(pointer: CanvasPointer) {
    let gesture = gestureRef.current
    if (!gesture) {
      if (tool !== 'select' || editingRef.current) return
      const handle = handleAt(pointer.screen)
      const endpoint = endpointAt(pointer.screen)
      setCursor(handle ? handleCursor(handle) : endpoint ? 'crosshair' : 'default')
      setHover(handle || endpoint ? null : pick(pointer))
      return
    }

    if (gesture.kind === 'endpoint') {
      const { id, fixed } = gesture
      const end = pointer.shiftKey ? constrainAngle(fixed, pointer.world) : roundPoint(pointer.world)
      const shape = lineBetween(fixed, end)
      store.preview((base) => {
        const node = base.nodes[id]
        const abs = getAbsolutePosition(base, id)
        return updateNode(base, id, {
          ...shape,
          x: node.x + shape.x - abs.x,
          y: node.y + shape.y - abs.y,
        })
      })
      return
    }

    if (gesture.kind === 'press') {
      if (distance(pointer.screen, gesture.screen) < DRAG_THRESHOLD) return
      const ids = movableIds()
      const from = getNodesBounds(store.getState().document, ids)
      if (!from) {
        gestureRef.current = null
        return
      }
      gesture = gestureRef.current = { kind: 'move', world: gesture.world, ids, from, guides: [] }
    }

    if (gesture.kind === 'move') {
      const { ids } = gesture
      let dx = Math.round(pointer.world.x - gesture.world.x)
      let dy = Math.round(pointer.world.y - gesture.world.y)
      if (pointer.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0
        else dx = 0
      }
      const exclude = new Set(ids)
      // ポインタの下にあるフレームの中へ入れる（フレームの外へ出せばページ直下に戻る）
      const parentId = findFrameAt(store.getState().document, pointer.world, exclude)

      // 近くの図形や親フレームの端・中央に吸着する。Cmd / Ctrl を押している間は吸着しない
      const targets = pointer.modKey ? [] : snapTargets(parentId, exclude)
      const snap = snapMove(
        { ...gesture.from, x: gesture.from.x + dx, y: gesture.from.y + dy },
        targets,
        SNAP_DISTANCE / camera.getViewport().zoom,
      )
      // Shift で向きを固定しているときは、固定した向きには吸着させない
      if (!pointer.shiftKey || dx !== 0) dx = Math.round(dx + snap.dx)
      if (!pointer.shiftKey || dy !== 0) dy = Math.round(dy + snap.dy)
      gesture.guides = findGuides(
        { ...gesture.from, x: gesture.from.x + dx, y: gesture.from.y + dy },
        targets,
      )

      store.preview((base) => reparentNodes(translateNodes(base, ids, dx, dy), ids, parentId))
    } else if (gesture.kind === 'resize') {
      const { ids, from, handle } = gesture
      const doc = store.getState().document
      // 画像は歪まないよう、Shift を押さない限り縦横比を保つ
      const onlyImages = ids.every((id) => doc.nodes[id].type === 'image')
      const keepAspect = pointer.shiftKey !== onlyImages
      let to = resizeBounds(
        from,
        handle,
        pointer.world.x - gesture.world.x,
        pointer.world.y - gesture.world.y,
        keepAspect,
      )
      const exclude = new Set(ids)
      const targets = pointer.modKey ? [] : snapTargets(doc.nodes[ids[0]].parentId, exclude)
      if (!keepAspect) to = snapResize(to, handle, targets, SNAP_DISTANCE / camera.getViewport().zoom)
      const target = to
      store.preview((base) => fitTextNodes(resizeNodes(base, ids, from, target), ids))
      const resized = getNodesBounds(store.getState().document, ids)
      gesture.guides = resized ? findGuides(resized, targets, handle) : []
    } else if (gesture.kind === 'marquee') {
      gesture.current = pointer.world
      const hits = nodesInMarquee(
        store.getState().document,
        boundsFromPoints(gesture.world, gesture.current),
      )
      store.select([...new Set([...gesture.base, ...hits])])
    } else if (gesture.kind === 'create') {
      if (!gesture.dragged && distance(pointer.screen, gesture.screen) < DRAG_THRESHOLD) return
      gesture.dragged = true
      if (gesture.node.type === 'line') {
        // Shift で水平・垂直・45° に揃える
        const to = pointer.shiftKey
          ? constrainAngle(gesture.world, pointer.world)
          : roundPoint(pointer.world)
        previewCreate(gesture, lineBetween(gesture.world, to))
        return
      }
      let end = roundPoint(pointer.world)
      if (pointer.shiftKey) {
        const dx = end.x - gesture.world.x
        const dy = end.y - gesture.world.y
        const side = Math.max(Math.abs(dx), Math.abs(dy))
        end = {
          x: gesture.world.x + (dx < 0 ? -side : side),
          y: gesture.world.y + (dy < 0 ? -side : side),
        }
      }
      previewCreate(gesture, boundsFromPoints(gesture.world, end))
    }
  }

  function onPointerUp(pointer: CanvasPointer) {
    const gesture = gestureRef.current
    gestureRef.current = null
    if (!gesture) return

    switch (gesture.kind) {
      case 'press':
        if (gesture.collapseTo) store.select([gesture.collapseTo])
        break
      case 'move':
      case 'resize':
      case 'endpoint':
        store.commitPreview()
        break
      case 'marquee':
        redraw()
        break
      case 'create':
        // ドラッグせずクリックしただけなら既定の大きさで置く
        if (!gesture.dragged) {
          const height = gesture.node.type === 'line' ? 0 : 100
          previewCreate(gesture, { ...gesture.world, width: 100, height })
        }
        store.commitPreview()
        store.select([gesture.node.id])
        onToolChange('select')
        break
      case 'text': {
        // ドラッグして作ると、その幅で折り返すテキストになる
        const end = pointer.world
        const dragged = distance(pointer.screen, gesture.screen) >= DRAG_THRESHOLD
        const width = Math.round(Math.abs(end.x - gesture.world.x))
        if (dragged && width >= 1) {
          const origin = { x: Math.min(gesture.world.x, end.x), y: Math.min(gesture.world.y, end.y) }
          startNewText(origin, width)
        } else {
          startNewText(gesture.world)
        }
        break
      }
    }
  }

  function cancelGesture() {
    gestureRef.current = null
    store.cancelPreview()
    redraw()
  }

  function onDoubleClick(pointer: CanvasPointer) {
    if (tool !== 'select' || editingRef.current) return
    const doc = store.getState().document
    const hit = hitTest(doc, pointer.world, 3 / camera.getViewport().zoom)
    if (hit && doc.nodes[hit].type === 'text') {
      store.select([hit])
      changeEditing({ id: hit, draft: null })
    }
  }

  function paste(fragment: Fragment, offset: number) {
    let ids: NodeId[] = []
    store.apply((doc) => {
      const result = pasteFragment(doc, fragment, offset)
      ids = result.ids
      return result.document
    })
    store.select(ids)
  }

  function onKeyDown(event: KeyboardEvent) {
    if (isTextInput(event.target) || event.isComposing) return
    const { document: doc, selection } = store.getState()
    const key = event.key.toLowerCase()

    if (key === 'escape') {
      if (gestureRef.current) cancelGesture()
      else if (tool !== 'select') onToolChange('select')
      else store.select([])
      return
    }
    // ドラッグ中に削除などが割り込むと、プレビュー中の変更と食い違う
    if (gestureRef.current) return

    const reorder = (direction: ReorderDirection) =>
      store.apply((base) => reorderNodes(base, selection, direction))
    const remove = () => store.apply((base) => removeNodes(base, movableIds()))
    const zoom = camera.getViewport().zoom

    if (event.metaKey || event.ctrlKey) {
      switch (key) {
        case 'z':
          if (event.shiftKey) store.redo()
          else store.undo()
          break
        case 'y':
          store.redo()
          break
        case 'a':
          store.select(doc.rootIds.filter((id) => doc.nodes[id].visible && !doc.nodes[id].locked))
          break
        case 'd':
          if (selection.length > 0) paste(copyFragment(doc, selection), 10)
          break
        case ']':
          reorder('forward')
          break
        case '[':
          reorder('backward')
          break
        case '0':
          camera.zoomTo(1)
          break
        case '=':
        case '+':
        case ';':
          camera.zoomTo(zoom * 1.25)
          break
        case '-':
          camera.zoomTo(zoom / 1.25)
          break
        default:
          return
      }
      event.preventDefault()
      return
    }
    if (event.altKey) return

    const step = event.shiftKey ? 10 : 1
    const nudge = (dx: number, dy: number) =>
      store.apply((base) => translateNodes(base, movableIds(), dx, dy))
    const tools: Record<string, Tool> = {
      v: 'select',
      f: 'frame',
      r: 'rect',
      o: 'ellipse',
      l: 'line',
      t: 'text',
    }

    if (event.shiftKey && event.code === 'Digit1') camera.fit(getContentBounds(doc))
    else if (event.shiftKey && event.code === 'Digit0') camera.zoomTo(1)
    else if (Object.hasOwn(tools, key)) onToolChange(tools[key])
    else if (key === 'delete' || key === 'backspace') remove()
    else if (key === ']') reorder('front')
    else if (key === '[') reorder('back')
    else if (key === 'arrowleft') nudge(-step, 0)
    else if (key === 'arrowright') nudge(step, 0)
    else if (key === 'arrowup') nudge(0, -step)
    else if (key === 'arrowdown') nudge(0, step)
    else if (key === 'enter' && selection.length === 1 && doc.nodes[selection[0]].type === 'text') {
      changeEditing({ id: selection[0], draft: null })
    } else return
    event.preventDefault()
  }

  // コピーと貼り付けはブラウザの clipboard イベントで受ける。キー入力で受けると、
  // OS のクリップボードにある画像を貼り付けられない
  function onCopy(event: ClipboardEvent) {
    if (isTextInput(event.target) || gestureRef.current) return
    const { document: doc, selection } = store.getState()
    if (selection.length === 0) return
    clipboardRef.current = { fragment: copyFragment(doc, selection), pastes: 0 }
    // OS のクリップボードも置き換える（中身はレイヤー名）。古い画像が残っていると、
    // 貼り付けでそちらが優先されてしまう
    const names = clipboardRef.current.fragment.rootIds.map((id) => doc.nodes[id].name)
    event.clipboardData?.setData('text/plain', names.join('\n'))
    event.preventDefault()
    if (event.type === 'cut') store.apply((base) => removeNodes(base, movableIds()))
  }

  function onPaste(event: ClipboardEvent) {
    if (isTextInput(event.target) || gestureRef.current) return
    const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'))
    event.preventDefault()
    if (images.length > 0) {
      onPasteImages(images)
    } else if (clipboardRef.current) {
      const clipboard = clipboardRef.current
      clipboard.pastes += 1
      paste(clipboard.fragment, clipboard.pastes * 10)
    }
  }

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('copy', onCopy)
    window.addEventListener('cut', onCopy)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('copy', onCopy)
      window.removeEventListener('cut', onCopy)
      window.removeEventListener('paste', onPaste)
    }
  })

  function drawOverlay(ctx: CanvasRenderingContext2D, viewport: Viewport) {
    const { document: doc, selection } = state
    const gesture = gestureRef.current
    ctx.strokeStyle = ACCENT
    ctx.lineWidth = 1

    const outline = (bounds: Bounds) => {
      const b = toScreenBounds(viewport, bounds)
      ctx.strokeRect(
        Math.round(b.x) + 0.5,
        Math.round(b.y) + 0.5,
        Math.round(b.width),
        Math.round(b.height),
      )
    }

    // 直線は枠ではなく線そのものをなぞる
    const outlineNode = (id: NodeId) => {
      const node = doc.nodes[id]
      if (node.type !== 'line') return outline(getAbsoluteBounds(doc, id))
      const [from, to] = lineEnds(doc, node).map((end) => worldToScreen(viewport, end))
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(to.x, to.y)
      ctx.stroke()
    }

    if (hover && !gesture && doc.nodes[hover] && !selection.includes(hover)) {
      ctx.lineWidth = 2
      outlineNode(hover)
      ctx.lineWidth = 1
    }
    for (const id of selection) outlineNode(id)

    const line = selectedLine()
    if (line && doc.nodes[line.id]?.type === 'line') {
      ctx.fillStyle = '#ffffff'
      for (const end of lineEnds(doc, doc.nodes[line.id] as LineNode)) {
        const p = worldToScreen(viewport, end)
        const x = Math.round(p.x - HANDLE_SIZE / 2) + 0.5
        const y = Math.round(p.y - HANDLE_SIZE / 2) + 0.5
        ctx.fillRect(x, y, HANDLE_SIZE, HANDLE_SIZE)
        ctx.strokeRect(x, y, HANDLE_SIZE, HANDLE_SIZE)
      }
    }

    const target = resizeTarget()
    if (target && gesture?.kind !== 'move') {
      if (selection.length > 1) outline(target.bounds)
      const screen = toScreenBounds(viewport, target.bounds)
      ctx.fillStyle = '#ffffff'
      for (const handle of visibleHandles(screen)) {
        const p = handlePoint(screen, handle)
        const x = Math.round(p.x - HANDLE_SIZE / 2) + 0.5
        const y = Math.round(p.y - HANDLE_SIZE / 2) + 0.5
        ctx.fillRect(x, y, HANDLE_SIZE, HANDLE_SIZE)
        ctx.strokeRect(x, y, HANDLE_SIZE, HANDLE_SIZE)
      }

      // 選択範囲の大きさを下に出す
      const label = `${Math.round(target.bounds.width)} × ${Math.round(target.bounds.height)}`
      ctx.font = '11px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const width = ctx.measureText(label).width + 10
      const centerX = screen.x + screen.width / 2
      const top = screen.y + screen.height + 8
      ctx.fillStyle = ACCENT
      ctx.beginPath()
      ctx.roundRect(centerX - width / 2, top, width, 18, 4)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.fillText(label, centerX, top + 9.5)
    }

    if (gesture?.kind === 'move' || gesture?.kind === 'resize') {
      ctx.strokeStyle = GUIDE
      ctx.beginPath()
      for (const guide of gesture.guides) {
        const along = guide.axis === 'x' ? 'y' : 'x'
        const from = worldToScreen(viewport, { x: 0, y: 0, [guide.axis]: guide.position, [along]: guide.from })
        const to = worldToScreen(viewport, { x: 0, y: 0, [guide.axis]: guide.position, [along]: guide.to })
        ctx.moveTo(Math.round(from.x) + 0.5, Math.round(from.y) + 0.5)
        ctx.lineTo(Math.round(to.x) + 0.5, Math.round(to.y) + 0.5)
      }
      ctx.stroke()
      ctx.strokeStyle = ACCENT
    }

    if (gesture?.kind === 'marquee') {
      const b = toScreenBounds(viewport, boundsFromPoints(gesture.world, gesture.current))
      ctx.fillStyle = 'rgba(13, 153, 255, 0.12)'
      ctx.fillRect(b.x, b.y, b.width, b.height)
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.width, b.height)
    }
  }

  return (
    <CanvasView
      document={state.document}
      camera={camera}
      hiddenId={editing?.id}
      cursor={tool === 'select' ? cursor : tool === 'text' ? 'text' : 'crosshair'}
      drawOverlay={drawOverlay}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancelGesture}
      onDoubleClick={onDoubleClick}
    >
      {editing && (
        <TextEditor
          key={editing.id}
          document={state.document}
          camera={camera}
          id={editing.id}
          selectAll={editing.draft === null}
          onInput={onTextInput}
          onDone={finishEditing}
        />
      )}
    </CanvasView>
  )
}
