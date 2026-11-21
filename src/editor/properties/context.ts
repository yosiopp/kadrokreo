import type { NodeId, Page, SceneNode } from '../../document/types.ts'
import type { NodePatch } from '../operations.ts'
import type { EditorState, EditorStore } from '../store.ts'

/** プロパティパネルの各節が受け取る、選択の情報と変更の手段 */
export type PanelContext = {
  store: EditorStore
  state: EditorState
  page: Page
  selection: NodeId[]
  /** 選んでいるノード（1 つ以上） */
  nodes: SceneNode[]
  /** 選んでいるノードに同じ patch を当てる（テキストの大きさも合わせ直す） */
  apply: (patch: NodePatch) => void
  /** 選んでいるノードに同じ patch を、履歴に積まずに当てる */
  preview: (patch: NodePatch) => void
  /** インスタンスの中身（写し）を選んでいる */
  inner: boolean
  /** インスタンスを選んでいる */
  hasInstance: boolean
}

/** 塗りと線を持つ図形 */
export function shapesIn(nodes: readonly SceneNode[]) {
  return nodes.filter(
    (node) => node.type === 'rect' || node.type === 'ellipse' || node.type === 'frame' || node.type === 'path',
  )
}

export function textsIn(nodes: readonly SceneNode[]) {
  return nodes.filter((node) => node.type === 'text')
}

/** 複数選択で値が揃っていないことを表す */
export const MIXED = Symbol('mixed')
export type Mixed = typeof MIXED

export function common<T>(values: readonly T[]): T | Mixed {
  return values.every((value) => Object.is(value, values[0])) ? values[0] : MIXED
}

export function mapValue<T, U>(value: T | Mixed, map: (value: T) => U): U | Mixed {
  return value === MIXED ? MIXED : map(value as T)
}
