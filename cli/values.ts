import type { SceneNode, Shadow } from '../src/document/types.ts'
import type { NodePatch } from '../src/editor/operations.ts'
import { UsageError } from './args.ts'

// set / add の「名前=値」を、ノードへの patch に直す。
// 値の型は、そのノードがいま持っている値の型に合わせる（text=123 は文字列のまま）。
// 入れ子の項目は . でつなぐ（layout.gap=8、shadow.blur=4、layoutFill.width=true）。
// どんな値を入れても、コマンドごとに kdr の検証を通すので、壊れたファイルは書き出さない。

const DEFAULT_SHADOW: Shadow = { x: 0, y: 4, blur: 8, color: '#000000', opacity: 0.25 }

/** そのノードの種類が持たない項目や、木構造に関わる項目は変えられない */
const READONLY = new Set(['id', 'type', 'parentId', 'children', 'component'])

export function parseValue(raw: string, current: unknown, key: string): unknown {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      throw new UsageError(`${key}: JSON として読めません: ${raw}`)
    }
  }
  if (raw === 'null') return null
  if (typeof current === 'number') {
    const value = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(value)) throw new UsageError(`${key}: 数値ではありません: ${raw}`)
    return value
  }
  if (typeof current === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    throw new UsageError(`${key}: true か false を指定してください: ${raw}`)
  }
  // いまの値が null の項目（fill など）は、数値や真偽値に見えても文字列にはしない
  if (current === null && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

/** assignments をまとめて 1 つの patch にする */
export function buildPatch(node: SceneNode, assignments: readonly [string, string][]): NodePatch {
  const draft: Record<string, unknown> = {}
  const source = node as unknown as Record<string, unknown>
  for (const [path, raw] of assignments) {
    const [head, ...rest] = path.split('.')
    if (READONLY.has(head)) throw new UsageError(`${path} は set では変えられません`)
    if (!Object.hasOwn(source, head)) throw new UsageError(`${node.type} には ${head} がありません`)
    if (rest.length === 0) {
      draft[head] = parseValue(raw, source[head], path)
      continue
    }
    // 入れ子: いまの値（同じコマンドで先に変えたものを含む）を写して、その中を変える
    let base = (Object.hasOwn(draft, head) ? draft[head] : source[head]) as unknown
    if (base === null && head === 'shadow') base = DEFAULT_SHADOW
    if (base === null || typeof base !== 'object') {
      throw new UsageError(
        head === 'layout' ? `${path}: 先に auto-layout で自動で並べるようにしてください` : `${path}: ${head} が空です`,
      )
    }
    draft[head] = setIn(structuredClone(base) as Record<string, unknown>, rest, raw, path)
  }
  return draft as NodePatch
}

function setIn(target: Record<string, unknown>, keys: readonly string[], raw: string, path: string): Record<string, unknown> {
  const [key, ...rest] = keys
  // layout.padding は 4 辺まとめて
  if (key === 'padding' && rest.length === 0 && Object.hasOwn(target, 'paddingTop')) {
    const value = parseValue(raw, 0, path)
    for (const side of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) target[side] = value
    return target
  }
  if (!Object.hasOwn(target, key)) throw new UsageError(`${path}: ${key} という項目はありません`)
  if (rest.length === 0) target[key] = parseValue(raw, target[key], path)
  else {
    const child = target[key]
    if (child === null || typeof child !== 'object') throw new UsageError(`${path}: ${key} が空です`)
    target[key] = setIn(child as Record<string, unknown>, rest, raw, path)
  }
  return target
}
