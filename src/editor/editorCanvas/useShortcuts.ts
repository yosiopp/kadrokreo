import { useEffect, useRef } from 'react'
import type { Camera } from '../../canvas/camera.ts'
import { isTextInput } from '../../canvas/dom.ts'
import { getContentBounds } from '../../document/geometry.ts'
import type { NodeId } from '../../document/types.ts'
import { makeComponent } from '../components.ts'
import { flowParent, moveInLayout, wrapInAutoLayout } from '../layout.ts'
import { type ReorderDirection, reorderNodes } from '../operations/arrange.ts'
import { type Fragment, copyFragment } from '../operations/clipboard.ts'
import { pasteIntoPage } from '../operations/document.ts'
import { translateNodes } from '../operations/transform.ts'
import { removeNodes } from '../operations/tree.ts'
import type { EditorStore } from '../store.ts'
import { isSvgFile, looksLikeSvg } from '../importSvg.ts'
import type { Tool } from '../tools.ts'
import { nextName } from './handles.ts'

type Options = {
  store: EditorStore
  camera: Camera
  /** ドラッグの途中か。途中なら削除や貼り付けを受け付けない（プレビュー中の変更と食い違う） */
  dragging: () => boolean
  /** Esc（ペンで描いている途中なら Enter も）を押した。扱ったら true を返す */
  onCancelKey: (key: string) => boolean
  /** Delete / Backspace を押した。ノードの削除より先に呼ぶ（パスの頂点の削除など）。扱ったら true を返す */
  onDeleteKey: () => boolean
  /** 選択中のうち、インスタンスの中身（写し）でないもの */
  ownIds: () => NodeId[]
  /** 選択中のうち動かせるもの */
  movableIds: () => NodeId[]
  onToolChange: (tool: Tool) => void
  /** テキストの編集に入る */
  editText: (id: NodeId) => void
  /** クリップボードから画像が貼り付けられた */
  onPasteImages: (files: File[]) => void
  /** クリップボードの文字が SVG の文書のとき */
  onPasteSvg: (text: string) => void
}

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  f: 'frame',
  r: 'rect',
  o: 'ellipse',
  l: 'line',
  p: 'pen',
  t: 'text',
}

/** キャンバスのキーボードショートカットと、コピー・切り取り・貼り付け */
export function useShortcuts(options: Options) {
  const clipboardRef = useRef<{ fragment: Fragment; pastes: number } | null>(null)
  const { store, camera, dragging, ownIds, movableIds } = options

  /** いまのページへ貼り付けて、貼り付けたものを選択する */
  function paste(fragment: Fragment, offset: number) {
    const pageId = store.getState().page.id
    let ids: NodeId[] = []
    store.applyDocument((document) => {
      const result = pasteIntoPage(document, pageId, fragment, offset)
      ids = result.ids
      return result.document
    })
    store.select(ids)
  }

  /** 選択中のノードを、使っている画像ごと切り出す */
  function copySelection(): Fragment {
    const { document, page } = store.getState()
    return copyFragment(page, document.assets, ownIds())
  }

  function onKeyDown(event: KeyboardEvent) {
    if (isTextInput(event.target) || event.isComposing) return
    const { page, selection } = store.getState()
    const key = event.key.toLowerCase()

    if ((key === 'escape' || key === 'enter') && options.onCancelKey(key)) return
    if (dragging()) return

    const reorder = (direction: ReorderDirection) =>
      store.apply((base) => reorderNodes(base, ownIds(), direction))
    const remove = () => store.apply((base) => removeNodes(base, movableIds()))
    const zoom = camera.getViewport().zoom

    if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === 'KeyK') {
      // 選んでいるフレームをコンポーネントにする（Alt を押すと key が記号になるので code で見る）
      store.apply((base) => ownIds().reduce((next, id) => makeComponent(next, id), base))
      event.preventDefault()
      return
    }
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
          store.select(page.rootIds.filter((id) => page.nodes[id].visible && !page.nodes[id].locked))
          break
        case 'd':
          if (ownIds().length > 0) paste(copySelection(), 10)
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
    const nudge = (dx: number, dy: number) => {
      const ids = movableIds()
      // 自動で並べるフレームの並びの中では、位置はフレームが決めるので、並べる向きの矢印で順番を入れ替える
      const parent = ids.length > 0 ? flowParent(page, ids[0]) : null
      if (parent) {
        const horizontal = parent.layout!.direction === 'horizontal'
        const along = horizontal ? dx : dy
        if (along !== 0) store.apply((base) => moveInLayout(base, ids, along < 0 ? -1 : 1))
        return
      }
      store.apply((base) => translateNodes(base, ids, dx, dy))
    }

    if (event.shiftKey && key === 'a') {
      // 選んだものを、自動で並べるフレームにまとめる
      let frameId: NodeId | null = null
      store.apply((base) => {
        const result = wrapInAutoLayout(base, movableIds(), nextName(base, 'frame'))
        frameId = result.id
        return result.scene
      })
      if (frameId) store.select([frameId])
    } else if (event.shiftKey && event.code === 'Digit1') camera.fit(getContentBounds(page))
    else if (event.shiftKey && event.code === 'Digit0') camera.zoomTo(1)
    else if (Object.hasOwn(TOOL_KEYS, key)) options.onToolChange(TOOL_KEYS[key])
    else if (key === 'delete' || key === 'backspace') {
      if (!options.onDeleteKey()) remove()
    }
    else if (key === ']') reorder('front')
    else if (key === '[') reorder('back')
    else if (key === 'arrowleft') nudge(-step, 0)
    else if (key === 'arrowright') nudge(step, 0)
    else if (key === 'arrowup') nudge(0, -step)
    else if (key === 'arrowdown') nudge(0, step)
    else if (key === 'enter' && selection.length === 1 && page.nodes[selection[0]].type === 'text') {
      options.editText(selection[0])
    } else return
    event.preventDefault()
  }

  // コピーと貼り付けはブラウザの clipboard イベントで受ける。キー入力で受けると、
  // OS のクリップボードにある画像を貼り付けられない
  function onCopy(event: ClipboardEvent) {
    if (isTextInput(event.target) || dragging()) return
    const { page } = store.getState()
    if (ownIds().length === 0) return
    clipboardRef.current = { fragment: copySelection(), pastes: 0 }
    // OS のクリップボードも置き換える（中身はレイヤー名）。古い画像が残っていると、
    // 貼り付けでそちらが優先されてしまう
    const names = clipboardRef.current.fragment.rootIds.map((id) => page.nodes[id].name)
    event.clipboardData?.setData('text/plain', names.join('\n'))
    event.preventDefault()
    if (event.type === 'cut') store.apply((base) => removeNodes(base, movableIds()))
  }

  function onPaste(event: ClipboardEvent) {
    if (isTextInput(event.target) || dragging()) return
    const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/') || isSvgFile(file))
    event.preventDefault()
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (images.length > 0) {
      options.onPasteImages(images)
    } else if (looksLikeSvg(text)) {
      options.onPasteSvg(text)
    } else if (clipboardRef.current) {
      const clipboard = clipboardRef.current
      clipboard.pastes += 1
      paste(clipboard.fragment, clipboard.pastes * 10)
    }
  }

  // 毎回登録し直して、いまの描画での関数を使う
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
}
