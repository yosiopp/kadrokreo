import { useEffect, useReducer, useRef, useState } from 'react'
import { type CanvasPointer, CanvasView } from '../canvas/CanvasView.tsx'
import type { Camera } from '../canvas/camera.ts'
import { isTextInput } from '../canvas/dom.ts'
import { LINE_HEIGHT } from '../canvas/text.ts'
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
import type { DesignDocument, NodeId, SceneNode, TextNode } from '../document/types.ts'
import { TextEditor } from './TextEditor.tsx'
import { findFrameAt, hitTest, hitTestFrameLabel, nodesInMarquee } from './hitTest.ts'
import { measureFrameLabel, measureTextNode } from './measure.ts'
import { createEllipse, createFrame, createRect, createText } from './nodes.ts'
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
import type { EditorState, EditorStore } from './store.ts'

export type Tool = 'select' | 'frame' | 'rect' | 'ellipse' | 'text'

type Props = {
  store: EditorStore
  camera: Camera
  state: EditorState
  tool: Tool
  onToolChange: (tool: Tool) => void
}

type Gesture =
  // ノードの上で押しただけの状態。少し動かすと move になる
  | { kind: 'press'; screen: Point; world: Point; collapseTo: NodeId | null }
  | { kind: 'move'; world: Point; ids: NodeId[] }
  | { kind: 'resize'; world: Point; handle: Handle; from: Bounds; ids: NodeId[] }
  | { kind: 'marquee'; world: Point; current: Point; base: NodeId[] }
  | {
      kind: 'create'
      screen: Point
      world: Point
      node: SceneNode
      parentId: NodeId | null
      dragged: boolean
    }
  | { kind: 'text'; world: Point }

/** draft は新規作成中のテキスト。確定するまでドキュメントには入れない */
type Editing = { id: NodeId; draft: { node: TextNode; parentId: NodeId | null } | null }

const ACCENT = '#0d99ff'
const DRAG_THRESHOLD = 4
const HANDLE_SIZE = 8
const NAMES = { frame: 'Frame', rect: 'Rectangle', ellipse: 'Ellipse', text: 'Text' } as const

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

function nextName(doc: DesignDocument, type: SceneNode['type']): string {
  const count = Object.values(doc.nodes).filter((node) => node.type === type).length
  return `${NAMES[type]} ${count + 1}`
}

export function EditorCanvas({ store, camera, state, tool, onToolChange }: Props) {
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

  /** リサイズハンドルを出す対象。テキストは中身で大きさが決まるのでハンドルを出さない */
  function resizeTarget(): { ids: NodeId[]; bounds: Bounds } | null {
    if (tool !== 'select' || editingRef.current) return null
    const doc = store.getState().document
    const ids = movableIds()
    if (ids.every((id) => doc.nodes[id].type === 'text')) return null
    return { ids, bounds: getNodesBounds(doc, ids)! }
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

  function previewCreate(gesture: Extract<Gesture, { kind: 'create' }>, bounds: Bounds) {
    store.preview((base) => {
      const origin =
        gesture.parentId === null ? { x: 0, y: 0 } : getAbsolutePosition(base, gesture.parentId)
      const node = {
        ...gesture.node,
        x: bounds.x - origin.x,
        y: bounds.y - origin.y,
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height),
      }
      return insertNode(base, node, gesture.parentId)
    })
  }

  function startNewText(world: Point) {
    const doc = store.getState().document
    // 既存のテキストの上をクリックしたら、新しく作らずそれを編集する
    const hit = hitTest(doc, world)
    if (hit && doc.nodes[hit].type === 'text') {
      store.select([hit])
      changeEditing({ id: hit, draft: null })
      return
    }
    const template = { ...createText({ x: 0, y: 0, width: 0, height: 0 }), name: nextName(doc, 'text') }
    const size = measureTextNode(template)
    const parentId = findFrameAt(doc, world)
    const origin = parentId === null ? { x: 0, y: 0 } : getAbsolutePosition(doc, parentId)
    // クリックした位置が 1 行目の中央に来るように置く
    const node: TextNode = {
      ...template,
      ...size,
      x: Math.round(world.x - origin.x),
      y: Math.round(world.y - origin.y - (template.fontSize * LINE_HEIGHT) / 2),
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
      gestureRef.current = { kind: 'text', world: pointer.world }
      return
    }
    if (tool !== 'select') {
      const world = roundPoint(pointer.world)
      const create = { frame: createFrame, rect: createRect, ellipse: createEllipse }[tool]
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

    const handle = handleAt(pointer.screen)
    const target = handle && resizeTarget()
    if (handle && target) {
      gestureRef.current = {
        kind: 'resize',
        world: pointer.world,
        handle,
        from: target.bounds,
        ids: target.ids,
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
      setCursor(handle ? handleCursor(handle) : 'default')
      setHover(handle ? null : pick(pointer))
      return
    }

    if (gesture.kind === 'press') {
      if (distance(pointer.screen, gesture.screen) < DRAG_THRESHOLD) return
      const ids = movableIds()
      if (ids.length === 0) {
        gestureRef.current = null
        return
      }
      gesture = gestureRef.current = { kind: 'move', world: gesture.world, ids }
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
      store.preview((base) => {
        const moved = translateNodes(base, ids, dx, dy)
        // ポインタの下にあるフレームの中へ入れる（フレームの外へ出せばページ直下に戻る）
        return reparentNodes(moved, ids, findFrameAt(moved, pointer.world, exclude))
      })
    } else if (gesture.kind === 'resize') {
      const { ids, from } = gesture
      const to = resizeBounds(
        from,
        gesture.handle,
        pointer.world.x - gesture.world.x,
        pointer.world.y - gesture.world.y,
        pointer.shiftKey,
      )
      store.preview((base) => resizeNodes(base, ids, from, to))
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

  function onPointerUp() {
    const gesture = gestureRef.current
    gestureRef.current = null
    if (!gesture) return

    switch (gesture.kind) {
      case 'press':
        if (gesture.collapseTo) store.select([gesture.collapseTo])
        break
      case 'move':
      case 'resize':
        store.commitPreview()
        break
      case 'marquee':
        redraw()
        break
      case 'create':
        // ドラッグせずクリックしただけなら既定の大きさで置く
        if (!gesture.dragged) previewCreate(gesture, { ...gesture.world, width: 100, height: 100 })
        store.commitPreview()
        store.select([gesture.node.id])
        onToolChange('select')
        break
      case 'text':
        startNewText(gesture.world)
        break
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
    const copy = () => {
      if (selection.length > 0) {
        clipboardRef.current = { fragment: copyFragment(doc, selection), pastes: 0 }
      }
    }
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
        case 'c':
          copy()
          break
        case 'x':
          copy()
          remove()
          break
        case 'v':
          if (clipboardRef.current) {
            const clipboard = clipboardRef.current
            clipboard.pastes += 1
            paste(clipboard.fragment, clipboard.pastes * 10)
          }
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
    const tools: Record<string, Tool> = { v: 'select', f: 'frame', r: 'rect', o: 'ellipse', t: 'text' }

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

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
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

    if (hover && !gesture && doc.nodes[hover] && !selection.includes(hover)) {
      ctx.lineWidth = 2
      outline(getAbsoluteBounds(doc, hover))
      ctx.lineWidth = 1
    }
    for (const id of selection) outline(getAbsoluteBounds(doc, id))

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
