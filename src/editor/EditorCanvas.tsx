import { useEffect, useReducer, useRef, useState } from 'react'
import { type CanvasPointer, CanvasView } from '../canvas/CanvasView.tsx'
import type { Camera } from '../canvas/camera.ts'
import { hitTest } from '../canvas/hitTest.ts'
import { HIT_TOLERANCE, pickNode } from '../canvas/pick.ts'
import { type Viewport, worldToScreen } from '../canvas/viewport.ts'
import { isInstance, owningInstance } from '../document/component.ts'
import { type Point, applyMatrix, getNodesBounds, toLocal } from '../document/geometry.ts'
import { pathFromPoints } from '../document/path.ts'
import type { LineNode, NodeId, PathNode, SceneNode } from '../document/types.ts'
import { TextEditor } from './TextEditor.tsx'
import { withoutCopies } from './components.ts'
import { type Gesture, createGesture, dragGesture, previewCreate, rotateGesture } from './editorCanvas/drag.ts'
import {
  DRAG_THRESHOLD,
  HANDLE_SIZE,
  type SelectionBox,
  constrainAngle,
  distance,
  editablePoints,
  handleAt,
  nextName,
  rotateHandleAt,
  roundPoint,
  selectionBoxOf,
} from './editorCanvas/handles.ts'
import { drawEditorOverlay } from './editorCanvas/overlay.ts'
import { useShortcuts } from './editorCanvas/useShortcuts.ts'
import { useTextEditing } from './editorCanvas/useTextEditing.ts'
import { findFrameAt } from './hitTest.ts'
import { createPath } from './nodes.ts'
import { insertNode } from './operations.ts'
import { handleCursor } from './resize.ts'
import type { EditorState, EditorStore } from './store.ts'
import type { Tool } from './tools.ts'

// 選択枠・ハンドルの計算、ドラッグ中のプレビュー、重ねて描く印、キーボード、テキストの編集は editorCanvas/ にある。
// ここはポインタの押す・離すから、どのジェスチャーを始めるかを決める

type Props = {
  store: EditorStore
  camera: Camera
  state: EditorState
  tool: Tool
  onToolChange: (tool: Tool) => void
  /** クリップボードから画像が貼り付けられた */
  onPasteImages: (files: File[]) => void
}

export function EditorCanvas({ store, camera, state, tool, onToolChange, onPasteImages }: Props) {
  const gestureRef = useRef<Gesture | null>(null)
  // ペンツールで描いている途中の頂点（ページ座標）。cursor はポインタの位置
  const penRef = useRef<{ points: Point[]; cursor: Point | null } | null>(null)
  // 頂点を編集中のパス。ダブルクリックで入る
  const vertexEditRef = useRef<NodeId | null>(null)
  const [hover, setHover] = useState<NodeId | null>(null)
  const [cursor, setCursor] = useState('default')
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const { editing, editingRef, editText, startNewText, onTextInput, finishEditing } = useTextEditing(
    store,
    onToolChange,
  )

  // ツールを切り替えたら、描きかけのパスや頂点の編集は終える
  useEffect(() => {
    if (tool !== 'pen') penRef.current = null
    if (tool !== 'select') vertexEditRef.current = null
  }, [tool])

  // 別のものを選んだら、頂点の編集は終える
  useEffect(() => {
    const editing = vertexEditRef.current
    if (editing && (state.selection.length !== 1 || state.selection[0] !== editing)) {
      vertexEditRef.current = null
    }
  }, [state.selection])

  /** 選択中のうち、インスタンスの中身（写し）でないもの。動かす・消す・複製するといった操作の対象になる */
  function ownIds(): NodeId[] {
    const { page, selection } = store.getState()
    return withoutCopies(page, selection)
  }

  /** 選択中のうち動かせるもの */
  function movableIds(): NodeId[] {
    const { page } = store.getState()
    return ownIds().filter((id) => !page.nodes[id].locked)
  }

  /** 選択ツールで、文字を編集中でなく、1 つだけ選んでいるときの、そのノード */
  function soleSelected(): SceneNode | null {
    if (tool !== 'select' || editingRef.current) return null
    const { page, selection } = store.getState()
    return selection.length === 1 ? (page.nodes[selection[0]] ?? null) : null
  }

  /** 直線を 1 本だけ選んでいるとき。枠のハンドルの代わりに、両端をつかんで動かせる */
  function selectedLine(): LineNode | null {
    const node = soleSelected()
    if (node?.type !== 'line' || node.locked) return null
    return owningInstance(store.getState().page, node.id) ? null : node
  }

  /** 頂点を編集中のパス。そのパスだけを選んでいる間だけ有効 */
  function editedPath(): PathNode | null {
    const node = soleSelected()
    return node?.type === 'path' && node.id === vertexEditRef.current && !node.locked ? node : null
  }

  /** 点をつかんで形を変えられるノード。直線は選ぶだけで、パスは頂点の編集に入ると対象になる */
  function pointTarget(): LineNode | PathNode | null {
    return selectedLine() ?? editedPath()
  }

  /** screen にある、つかめる点 */
  function pointAt(screen: Point): { id: NodeId; index: number } | null {
    const node = pointTarget()
    if (!node) return null
    const points = editablePoints(store.getState().page, node)
    for (const [index, point] of points.entries()) {
      if (distance(worldToScreen(camera.getViewport(), point), screen) <= HANDLE_SIZE) {
        return { id: node.id, index }
      }
    }
    return null
  }

  /** ペンツールで描いた頂点をパスとして確定する */
  function finishPen(closed: boolean) {
    const draft = penRef.current
    penRef.current = null
    redraw()
    if (!draft || draft.points.length < 2) return

    const page = store.getState().page
    const parentId = findFrameAt(page, draft.points[0])
    const shape = pathFromPoints(draft.points.map((point) => toLocal(page, parentId, point)))
    const node = { ...createPath(shape, closed), name: nextName(page, 'path') }
    store.apply((base) => insertNode(base, node, parentId))
    store.select([node.id])
    onToolChange('select')
  }

  /** リサイズと回転のハンドルを出す枠 */
  function selectionBox(): SelectionBox | null {
    if (tool !== 'select' || editingRef.current || pointTarget()) return null
    return selectionBoxOf(store.getState().page, movableIds())
  }

  function pick(pointer: CanvasPointer): NodeId | null {
    return pickNode(store.getState().page, camera.getViewport(), pointer)
  }

  /** ペンツールでクリックした。頂点を足すか、最初の頂点なら閉じた形にして確定する */
  function penClick(pointer: CanvasPointer) {
    const draft = (penRef.current ??= { points: [], cursor: null })
    const last = draft.points.at(-1)
    // 最初の頂点をクリックすると、閉じた形になる
    if (draft.points.length >= 2) {
      const first = worldToScreen(camera.getViewport(), draft.points[0])
      if (distance(first, pointer.screen) <= HANDLE_SIZE) return finishPen(true)
    }
    const point = pointer.shiftKey && last ? constrainAngle(last, pointer.world) : roundPoint(pointer.world)
    // ダブルクリックの 2 回目など、同じ場所には重ねて打たない
    if (!last || last.x !== point.x || last.y !== point.y) draft.points.push(point)
    redraw()
  }

  function onPointerDown(pointer: CanvasPointer) {
    if (editingRef.current) {
      // 編集中のクリックは確定だけして、選択などは行わない
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      finishEditing()
      return
    }
    setHover(null)
    const { page, selection } = store.getState()

    if (tool === 'text') {
      gestureRef.current = { kind: 'text', screen: pointer.screen, world: pointer.world }
      return
    }
    if (tool === 'pen') return penClick(pointer)
    if (tool !== 'select') {
      gestureRef.current = createGesture(page, tool, pointer)
      return
    }

    const grabbed = pointAt(pointer.screen)
    if (grabbed) {
      gestureRef.current = { kind: 'point', ...grabbed }
      return
    }

    const viewport = camera.getViewport()
    const box = selectionBox()
    if (box && rotateHandleAt(viewport, box, pointer.screen)) {
      const pivot = applyMatrix(box.matrix, { x: box.size.width / 2, y: box.size.height / 2 })
      gestureRef.current = rotateGesture(page, box.ids, pivot, pointer.world)
      return
    }

    const handle = handleAt(viewport, box, pointer.screen)
    if (handle && box?.oriented) {
      gestureRef.current = {
        kind: 'reshape',
        world: pointer.world,
        handle,
        id: box.oriented,
        rotation: box.rotation,
        size: box.size,
      }
      return
    }
    if (handle && box) {
      gestureRef.current = {
        kind: 'resize',
        world: pointer.world,
        handle,
        from: box.bounds,
        ids: box.ids,
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
      if (tool === 'pen' && penRef.current) {
        penRef.current.cursor = pointer.world
        redraw()
        return
      }
      if (tool !== 'select' || editingRef.current) return
      const viewport = camera.getViewport()
      const box = selectionBox()
      const handle = handleAt(viewport, box, pointer.screen)
      const endpoint = pointAt(pointer.screen)
      const rotating = rotateHandleAt(viewport, box, pointer.screen)
      const rotation = box?.rotation ?? 0
      setCursor(
        rotating ? 'grab' : handle ? handleCursor(handle, rotation) : endpoint ? 'crosshair' : 'default',
      )
      setHover(rotating || handle || endpoint ? null : pick(pointer))
      return
    }

    if (gesture.kind === 'press') {
      if (distance(pointer.screen, gesture.screen) < DRAG_THRESHOLD) return
      const ids = movableIds()
      const from = getNodesBounds(store.getState().page, ids)
      if (!from) {
        gestureRef.current = null
        return
      }
      gesture = gestureRef.current = { kind: 'move', world: gesture.world, ids, from, guides: [] }
    }

    dragGesture(store, gesture, pointer, camera.getViewport().zoom)
    // 回している最中は、角度の表示を描き直す
    if (gesture.kind === 'rotate') redraw()
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
      case 'reshape':
      case 'rotate':
      case 'point':
        store.commitPreview()
        redraw()
        break
      case 'marquee':
        redraw()
        break
      case 'create':
        // ドラッグせずクリックしただけなら既定の大きさで置く
        if (!gesture.dragged) {
          const at = roundPoint(toLocal(store.getState().page, gesture.parentId, gesture.world))
          previewCreate(store, gesture, { ...at, width: 100, height: gesture.node.type === 'line' ? 0 : 100 })
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
    if (tool === 'pen') return finishPen(false)
    if (tool !== 'select' || editingRef.current) return
    const page = store.getState().page
    const tolerance = HIT_TOLERANCE / camera.getViewport().zoom
    const top = hitTest(page, pointer.world, { tolerance })
    if (!top) return
    // インスタンスは、ダブルクリックで中身を選べる（文言や色を、そのインスタンスだけ変えられる）
    const inner = isInstance(page.nodes[top])
    const hit = inner ? (hitTest(page, pointer.world, { tolerance, deep: true }) ?? top) : top
    if (page.nodes[hit].type === 'text') {
      store.select([hit])
      editText(hit)
    } else if (inner) {
      store.select([hit])
    } else if (page.nodes[hit].type === 'path') {
      // パスは頂点の編集に入る。別のものを選ぶか Esc で抜ける
      store.select([hit])
      vertexEditRef.current = hit
      redraw()
    }
  }

  /** Esc（ペンで描いている途中なら Enter も）で、いまの操作を 1 段だけ抜ける */
  function onCancelKey(key: string): boolean {
    if (key === 'enter' && !penRef.current) return false
    if (gestureRef.current) cancelGesture()
    else if (penRef.current) finishPen(false)
    else if (tool !== 'select') onToolChange('select')
    else if (editedPath()) {
      vertexEditRef.current = null
      redraw()
    } else store.select([])
    return true
  }

  useShortcuts({
    store,
    camera,
    dragging: () => gestureRef.current !== null,
    onCancelKey,
    ownIds,
    movableIds,
    onToolChange,
    editText,
    onPasteImages,
  })

  function drawOverlay(ctx: CanvasRenderingContext2D, viewport: Viewport) {
    drawEditorOverlay(ctx, viewport, {
      page: state.page,
      selection: state.selection,
      hover,
      gesture: gestureRef.current,
      pointed: pointTarget(),
      editedId: editedPath()?.id,
      pen: penRef.current,
      box: selectionBox(),
    })
  }

  return (
    <CanvasView
      scene={state.page}
      assets={state.document.assets}
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
          scene={state.page}
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
