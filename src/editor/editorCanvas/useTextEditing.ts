import { useRef, useState } from 'react'
import { hitTest } from '../../canvas/hitTest.ts'
import { measureTextNode } from '../../canvas/measure.ts'
import { owningInstance } from '../../document/component.ts'
import { type Point, toLocal } from '../../document/geometry.ts'
import type { NodeId, TextNode } from '../../document/types.ts'
import { findFrameAt } from '../hitTest.ts'
import { createText } from '../nodes.ts'
import { insertNode, removeNodes, updateNode } from '../operations.ts'
import type { EditorStore } from '../store.ts'
import type { Tool } from '../tools.ts'
import { nextName } from './handles.ts'

/** draft は新規作成中のテキスト。確定するまでドキュメントには入れない */
export type Editing = { id: NodeId; draft: { node: TextNode; parentId: NodeId | null } | null }

/** キャンバスの上でテキストを打つ・作る。文字はプレビューとして入れ、編集を終えたときに確定する */
export function useTextEditing(store: EditorStore, onToolChange: (tool: Tool) => void) {
  const editingRef = useRef<Editing | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)

  function changeEditing(next: Editing | null) {
    editingRef.current = next
    setEditing(next)
  }

  /** いまあるテキストの編集に入る */
  function editText(id: NodeId) {
    changeEditing({ id, draft: null })
  }

  /** width を渡すと、その幅で折り返すテキストになる */
  function startNewText(world: Point, width?: number) {
    const page = store.getState().page
    // 既存のテキストの上をクリックしたら、新しく作らずそれを編集する
    const hit = hitTest(page, world)
    if (hit && page.nodes[hit].type === 'text') {
      store.select([hit])
      editText(hit)
      return
    }
    const template: TextNode = {
      ...createText({ x: 0, y: 0, width: width ?? 0, height: 0 }),
      name: nextName(page, 'text'),
      autoWidth: width === undefined,
    }
    const size = measureTextNode(template)
    const parentId = findFrameAt(page, world)
    const local = toLocal(page, parentId, world)
    // クリックで作ったときは、その位置が 1 行目の中央に来るように置く
    const lift = width === undefined ? (template.fontSize * template.lineHeight) / 2 : 0
    const node: TextNode = {
      ...template,
      ...size,
      x: Math.round(local.x),
      y: Math.round(local.y - lift),
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
      const node = store.getState().page.nodes[current.id]
      if (node?.type !== 'text') return
      const size = measureTextNode({ ...node, text })
      store.preview((base) => updateNode(base, current.id, { text, ...size }))
    }
  }

  function finishEditing() {
    const current = editingRef.current
    if (!current) return
    changeEditing(null)
    const node = store.getState().page.nodes[current.id]
    if (node?.type === 'text' && node.text.trim() !== '') {
      store.commitPreview()
    } else {
      // 空のテキストは残さない。インスタンスの中身は消せないので、元の文言に戻すだけ
      store.cancelPreview()
      const removable = !current.draft && !owningInstance(store.getState().page, current.id)
      if (removable) store.apply((page) => removeNodes(page, [current.id]))
    }
    onToolChange('select')
  }

  return { editing, editingRef, editText, startNewText, onTextInput, finishEditing }
}
