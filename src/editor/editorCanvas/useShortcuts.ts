import { useEffect, useRef } from 'react'
import type { Camera } from '../../canvas/camera.ts'
import { isTextInput } from '../../canvas/dom.ts'
import { getContentBounds, getNodesBounds } from '../../document/geometry.ts'
import type { NodeId, PageId } from '../../document/types.ts'
import { makeComponent } from '../components.ts'
import { flowParent, moveInLayout, wrapInAutoLayout } from '../layout.ts'
import { type ReorderDirection, reorderNodes } from '../operations/arrange.ts'
import { type Fragment, copyFragment, duplicateNodes } from '../operations/clipboard.ts'
import { moveNodesToPage, pasteIntoPage } from '../operations/document.ts'
import { type FlipDirection, flipNodes, translateNodes } from '../operations/transform.ts'
import type { BooleanOp } from '../../document/pathBoolean.ts'
import { canBoolean } from '../../document/booleanNode.ts'
import { BOOLEAN_LABELS, MAX_PATH_POINTS, applyMask, booleanPaths, joinPaths, splitPaths } from '../operations/paths.ts'
import { removeNodes } from '../operations/tree.ts'
import { createBooleanNode, flattenBooleanNodes } from '../operations/booleanNodes.ts'
import { outlineStrokes, outlineTexts } from '../operations/outline.ts'
import { attachTextToPath, detachTextFromPath, textPathTargets } from '../operations/textPath.ts'
import { fitTextNodes } from '../measure.ts'
import type { EditorStore } from '../store.ts'
import { isSvgFile, looksLikeSvg } from '../importSvg.ts'
import type { Tool } from '../tools.ts'
import { nextName } from './handles.ts'
import { getViewSettings, setViewSettings } from '../viewSettings.ts'

/** 埋め込んだ書体で描かないテキストを、アウトライン化・ブーリアン演算に入れなかったときの説明 */
const UNEMBEDDED_TEXT_OUTLINE = 'kdr に埋め込んでいない書体のテキストは、文字の形が分からないのでアウトライン化しませんでした。書体ファイルを追加して（何も選んでいないときのプロパティの「書体」）そのテキストに当ててから、もう一度試してください。'
const UNEMBEDDED_TEXT_BOOLEAN = 'kdr に埋め込んでいない書体のテキストは、文字の形が分からないのでブーリアン演算に入れませんでした。書体ファイルを追加して（何も選んでいないときのプロパティの「書体」）そのテキストに当てると入れられます。'

type Options = {
  store: EditorStore
  camera: Camera
  /** ドラッグの途中か。途中なら削除や貼り付けを受け付けない（プレビュー中の変更と食い違う） */
  dragging: () => boolean
  /** Esc（ペンで描いている途中なら Enter も）を押した。扱ったら true を返す */
  onCancelKey: (key: string) => boolean
  /** Delete / Backspace を押した。ノードの削除より先に呼ぶ（パスの頂点の削除など）。扱ったら true を返す */
  onDeleteKey: () => boolean
  /** 矢印キーを押した。ノードを動かすより先に呼ぶ（パスの頂点を動かすなど）。扱ったら true を返す */
  onNudgeKey: (dx: number, dy: number) => boolean
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
  /** 操作ができなかった理由などを知らせる */
  onMessage: (message: string) => void
}

/**
 * ブーリアン演算のキー。Alt + Shift で元を残す演算のノードを作り（既存のデザインツールと同じ）、
 * ⌘/Ctrl も足すとパスに焼き込む（元の図形が消える方に、押すキーを 1 つ多くする）
 */
const BOOLEAN_KEYS: Record<string, BooleanOp> = { KeyU: 'union', KeyS: 'subtract', KeyI: 'intersect', KeyX: 'exclude' }

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  f: 'frame',
  r: 'rect',
  o: 'ellipse',
  l: 'line',
  p: 'pen',
  t: 'text',
}

/** キーボードと右クリックメニューの両方から呼ぶ操作 */
export type CanvasCommands = ReturnType<typeof useShortcuts>

/**
 * キャンバスのキーボードショートカットと、コピー・切り取り・貼り付け。
 * 同じ操作を右クリックメニューからも呼べるよう、操作をまとめて返す
 */
export function useShortcuts(options: Options) {
  const clipboardRef = useRef<{ fragment: Fragment; pastes: number } | null>(null)
  const { store, camera, dragging, ownIds, movableIds } = options

  /** いまのページへ貼り付けて、貼り付けたものを選択する */
  function paste(fragment: Fragment, offset: number) {
    const pageId = store.getState().page.id
    const result = store.applyDocumentWith((document) => pasteIntoPage(document, pageId, fragment, offset))
    store.select(result?.ids ?? [])
  }

  /** 選択中のノードを、使っている画像ごと切り出す */
  function copySelection(): Fragment {
    const { document, page } = store.getState()
    return copyFragment(page, document.assets, ownIds())
  }

  const reorder = (direction: ReorderDirection) =>
    store.apply((base) => reorderNodes(base, ownIds(), direction))
  const remove = () => store.apply((base) => removeNodes(base, movableIds()))
  /** 選んでいるものを、選択範囲の中心を通る線で左右・上下に裏返す */
  const flip = (direction: FlipDirection) => store.apply((base) => flipNodes(base, movableIds(), direction))

  /** 複製して、元のすぐ上（重なり順で 1 つ前面）に少しずらして置き、複製したものを選ぶ */
  function duplicate() {
    const targets = ownIds()
    if (targets.length === 0) return
    const result = store.applyWith((base) => duplicateNodes(base, targets, 10))
    store.select(result?.ids ?? [])
  }

  /** 選んでいるフレームをコンポーネントにする */
  const componentize = () => store.apply((base) => ownIds().reduce((next, id) => makeComponent(next, id), base))

  /** マスクとして使う（選んだものがどれもマスクなら、やめる）。まとめたフレームかマスクにしたものを選ぶ */
  function mask() {
    const selected = store.applyWith((base) => applyMask(base, movableIds(), 'Mask group'))?.id
    if (selected) store.select([selected])
  }

  /** 選んだ矩形・楕円・パスを 1 つのパスにまとめる */
  function join() {
    const joined = store.applyWith((base) => joinPaths(base, movableIds()))?.id
    if (joined) store.select([joined])
  }

  /** 選んだ矩形・楕円・パスにブーリアン演算をかけて 1 つのパスにする。結果が空・頂点が多すぎるときは何も変えずに知らせる */
  function booleanOp(op: BooleanOp) {
    const { id, error } = store.applyWith((base) => booleanPaths(base, movableIds(), op)) ?? {}
    if (id) store.select([id])
    else if (error === 'empty') options.onMessage(`${BOOLEAN_LABELS[op]}の結果が空になるので、何も変えませんでした。`)
    else if (error === 'too-many') options.onMessage(`${BOOLEAN_LABELS[op]}の結果の頂点が ${MAX_PATH_POINTS.toLocaleString()} を超えるので、何も変えませんでした。`)
    else if (unembeddedTextSelected()) options.onMessage(UNEMBEDDED_TEXT_BOOLEAN)
  }

  /** 埋め込んだ書体で描かない（演算に入らない）テキストを選んでいるか */
  function unembeddedTextSelected(): boolean {
    const { page } = store.getState()
    return movableIds().some((id) => page.nodes[id]?.type === 'text' && !canBoolean(page.nodes[id]))
  }

  /** 選んだもの（埋め込んだ書体で描かないテキストを除く）を、元の図形を子に残すブーリアン演算のノードにまとめ、それを選ぶ */
  function booleanNode(op: BooleanOp) {
    const created = store.applyWith((base) => createBooleanNode(base, movableIds(), op))?.id
    if (created) store.select([created])
    if (unembeddedTextSelected()) options.onMessage(UNEMBEDDED_TEXT_BOOLEAN)
  }

  /** 選んだブーリアン演算のノードを、結果の形のパスに焼き込む */
  function flattenBoolean() {
    const { ids: flat = [], error } = store.applyWith((base) => flattenBooleanNodes(base, movableIds())) ?? {}
    if (flat.length > 0) store.select(flat)
    if (error === 'empty') options.onMessage('結果が空のブーリアン演算は、平らにしませんでした。')
    else if (error === 'too-many') options.onMessage(`結果の頂点が ${MAX_PATH_POINTS.toLocaleString()} を超えるブーリアン演算は、平らにしませんでした。`)
  }

  /** 選んだ図形の線を、線の形のパスにする（塗りのある図形は残して、手前に置く） */
  function outlineStroke() {
    const { ids: outlines = [], error } = store.applyWith((base) => outlineStrokes(base, movableIds())) ?? {}
    if (outlines.length > 0) store.select(outlines)
    if (error === 'too-many') options.onMessage(`線の形の頂点が ${MAX_PATH_POINTS.toLocaleString()} を超える図形は、輪郭にしませんでした。`)
  }

  /** 選んだテキストを、文字の形のパスにする（埋め込んだ書体で描くものだけ） */
  function outlineText() {
    const result = store.applyWith((base) => outlineTexts(base, movableIds()))
    if (!result) return
    if (result.ids.length > 0) store.select(result.ids)
    const notes: string[] = []
    if (result.unembedded.length > 0) notes.push(UNEMBEDDED_TEXT_OUTLINE)
    if (result.missing > 0) notes.push(`書体に無い文字（${result.missing.toLocaleString()} 字）は形にできないので除きました。`)
    if (result.tooMany.length > 0) notes.push(`文字の形の頂点が ${MAX_PATH_POINTS.toLocaleString()} を超えるテキストは、アウトライン化しませんでした。`)
    if (notes.length > 0) options.onMessage(notes.join('\n'))
  }

  /** 選んだテキストを、一緒に選んだ図形の線に沿わせる（テキスト 1 つと図形 1 つのとき）。テキストを選ぶ */
  function attachTextPath() {
    const targets = textPathTargets(store.getState().page, movableIds())
    if (!targets) return
    store.apply((base) => attachTextToPath(base, targets.text, targets.guide))
    store.select([targets.text])
  }

  /** 選んだ線に沿うテキストを、線から外してふつうに並べる */
  function detachTextPath() {
    const ids = movableIds()
    store.apply((base) => fitTextNodes(detachTextFromPath(base, ids), ids))
  }

  /** 選んだパスを輪郭ごとのパスに分ける */
  function split() {
    const parts = store.applyWith((base) => splitPaths(base, movableIds()))?.ids ?? []
    if (parts.length > 0) store.select(parts)
  }

  /** 選んだものを、自動で並べるフレームにまとめる */
  function wrap() {
    const frameId = store.applyWith((base) => wrapInAutoLayout(base, movableIds(), nextName(base, 'frame')))?.id
    if (frameId) store.select([frameId])
  }

  /** 選んでいるものが画面いっぱいに映るようにする（何も選んでいなければ全体を表示） */
  function zoomToSelection() {
    const { page, selection } = store.getState()
    const bounds = getNodesBounds(page, selection)
    if (bounds) camera.zoomToBounds(bounds)
    else camera.fit(getContentBounds(page))
  }

  /** 選んでいるものを別のページへ移す。表示しているページはそのまま（移したものは見えなくなる） */
  function moveToPage(pageId: PageId) {
    const ids = ownIds()
    const from = store.getState().page.id
    if (ids.length > 0) store.applyDocument((document) => moveNodesToPage(document, from, ids, pageId))
  }

  /** 右クリックメニューのコピー。OS のクリップボードにはレイヤー名を入れる（古い画像が貼り付けで優先されないように） */
  function copy() {
    if (ownIds().length === 0) return
    clipboardRef.current = { fragment: copySelection(), pastes: 0 }
    const { page } = store.getState()
    const names = clipboardRef.current.fragment.rootIds.map((id) => page.nodes[id].name)
    navigator.clipboard?.writeText(names.join('\n')).catch(() => {})
  }

  /** 右クリックメニューの貼り付け。この画面でコピーしたものだけを貼る */
  function pasteCopied() {
    const clipboard = clipboardRef.current
    if (!clipboard) return
    clipboard.pastes += 1
    paste(clipboard.fragment, clipboard.pastes * 10)
  }

  function onKeyDown(event: KeyboardEvent) {
    if (isTextInput(event.target) || event.isComposing) return
    const { page, selection } = store.getState()
    const key = event.key.toLowerCase()

    if ((key === 'escape' || key === 'enter') && options.onCancelKey(key)) return
    if (dragging()) return

    const zoom = camera.getViewport().zoom

    if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === 'KeyK') {
      // 選んでいるフレームをコンポーネントにする（Alt を押すと key が記号になるので code で見る）
      componentize()
      event.preventDefault()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.code === 'KeyO') {
      // テキストのアウトライン化
      outlineText()
      event.preventDefault()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === 'KeyO') {
      // 線の輪郭化（既存のデザインツールと同じキー）
      outlineStroke()
      event.preventDefault()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === 'KeyM') {
      mask()
      event.preventDefault()
      return
    }
    if (event.altKey && event.shiftKey && Object.hasOwn(BOOLEAN_KEYS, event.code)) {
      // Alt を押すと key が記号になるので code で見る
      if (event.metaKey || event.ctrlKey) booleanOp(BOOLEAN_KEYS[event.code])
      else booleanNode(BOOLEAN_KEYS[event.code])
      event.preventDefault()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && key === 'e') {
      split()
      event.preventDefault()
      return
    }
    if (event.metaKey || event.ctrlKey) {
      switch (key) {
        case 'e':
          join()
          break
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
          duplicate()
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
      if (options.onNudgeKey(dx, dy)) return
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

    if (event.shiftKey && key === 'a') wrap()
    else if (event.shiftKey && key === 'h') flip('horizontal')
    else if (event.shiftKey && key === 'v') flip('vertical')
    else if (event.shiftKey && key === 'r') setViewSettings({ rulers: !getViewSettings().rulers })
    else if (event.shiftKey && key === 'g') setViewSettings({ layoutGrids: !getViewSettings().layoutGrids })
    else if (event.shiftKey && event.code === 'Digit1') camera.fit(getContentBounds(page))
    else if (event.shiftKey && event.code === 'Digit2') zoomToSelection()
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

  return {
    copy,
    paste: pasteCopied,
    canPaste: () => clipboardRef.current !== null,
    duplicate,
    remove,
    reorder,
    flip,
    wrap,
    mask,
    join,
    split,
    booleanOp,
    booleanNode,
    flattenBoolean,
    outlineStroke,
    outlineText,
    attachTextPath,
    detachTextPath,
    componentize,
    zoomToSelection,
    zoomToFit: () => camera.fit(getContentBounds(store.getState().page)),
    moveToPage,
  }
}
