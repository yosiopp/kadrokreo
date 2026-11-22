import { solid } from '../src/document/paint.ts'
import type { Effect, PathPoint, SceneNode } from '../src/document/types.ts'
import { parseDashes } from '../src/editor/dashes.ts'
import type { NodePatch } from '../src/editor/operations/tree.ts'
import { UsageError } from './args.ts'

// set / add の「名前=値」を、ノードへの patch に直す。
// 値の型は、そのノードがいま持っている値の型に合わせる（text=123 は文字列のまま）。
// 入れ子の項目は . でつなぐ（layout.gap=8、sizing.width=fill）。配列の要素は番号でつなぐ（effects.0.blur=4）。
// よく使うものには略記がある: fill=色 / stroke=色（単色 1 つの塗り・線にする。null で外す）、
// shadow.blur=4 など（最初の影。なければ既定の影を付けてから変える）、shadow=null（影を外す）、
// cornerRadius=0,8,8,0（角丸を 4 隅ばらばらに。左上・右上・右下・左下の順）、dash=4,2（破線。null で実線）、radius=8（パスの頂点の角の丸め。頂点ごとならカンマで並べる）。
// どんな値を入れても、コマンドごとに kdr の検証を通すので、壊れたファイルは書き出さない。

const DEFAULT_SHADOW: Effect = { type: 'drop-shadow', x: 0, y: 4, blur: 8, color: '#000000', opacity: 0.25, visible: true }

/** 略記を、本来の項目の「名前=値」に直す。直せないもの（そのノードにない項目）はそのまま返す */
function expandShorthand(node: SceneNode, path: string, raw: string, draft: Record<string, unknown>): [string, unknown] | null {
  const [head, ...rest] = path.split('.')
  if ((head === 'fill' || head === 'stroke') && rest.length === 0) {
    const key = head === 'fill' ? 'fills' : 'strokes'
    if (!Object.hasOwn(node, key)) return null
    const color = raw === 'null' ? null : raw
    return [key, solid(color)]
  }
  if (head === 'cornerRadius' && rest.length === 0 && Object.hasOwn(node, 'cornerRadius') && !raw.trim().startsWith('[')) {
    // 4 隅ばらばらは「左上,右上,右下,左下」。いまが 4 隅の配列でも、数値 1 つで揃えられる
    const values = raw.split(',').map((part) => parseValue(part, 0, path) as number)
    if (values.length === 1) return [head, values[0]]
    if (values.length !== 4) throw new UsageError(`${path}: 数値 1 つか、左上,右上,右下,左下 の 4 つを指定してください`)
    return [head, values]
  }
  if (head === 'dash' && rest.length === 0 && Object.hasOwn(node, 'strokeDashes')) {
    // 破線。「線の長さ,間隔」（3 つ以上も可。stroke-dasharray と同じ並び）。null・none・0 で実線
    const dashes = parseDashes(raw)
    if (dashes === null) throw new UsageError(`${path}: 0 以上の数をカンマで並べてください（null で実線）`)
    return ['strokeDashes', dashes]
  }
  if (head === 'radius' && rest.length === 0 && node.type === 'path') {
    // パスの頂点の角の丸め。数値 1 つなら全部の頂点、カンマで並べれば頂点ごと（0 は丸めない）
    const current = (Object.hasOwn(draft, 'points') ? draft.points : node.points) as PathPoint[]
    const values = raw.split(',').map((part) => parseValue(part, 0, path))
    if (values.some((value) => typeof value !== 'number' || !(value >= 0))) throw new UsageError(`${path}: 0 以上の数を指定してください`)
    if (values.length !== 1 && values.length !== current.length) {
      throw new UsageError(`${path}: 数値 1 つか、頂点の数（${current.length}）だけ並べてください`)
    }
    return [
      'points',
      current.map((point, i) => {
        const { radius: _, ...rest } = point
        const radius = (values.length === 1 ? values[0] : values[i]) as number
        return radius > 0 ? { ...rest, radius } : rest
      }),
    ]
  }
  if (head === 'shadow' && Object.hasOwn(node, 'effects')) {
    if (rest.length === 0) {
      if (raw !== 'null') throw new UsageError(`${path}: shadow は null（外す）か shadow.blur=4 のように指定してください`)
      return ['effects', []]
    }
    const current = (Object.hasOwn(draft, 'effects') ? draft.effects : (node as { effects: Effect[] }).effects) as Effect[]
    const first = structuredClone(current[0] ?? DEFAULT_SHADOW) as unknown as Record<string, unknown>
    return ['effects', [setIn(first, rest, raw, path), ...current.slice(1)]]
  }
  return null
}

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
    const shorthand = expandShorthand(node, path, raw, draft)
    if (shorthand) {
      draft[shorthand[0]] = shorthand[1]
      continue
    }
    const [head, ...rest] = path.split('.')
    if (READONLY.has(head)) throw new UsageError(`${path} は set では変えられません`)
    if (!Object.hasOwn(source, head)) throw new UsageError(`${node.type} には ${head} がありません`)
    if (rest.length === 0) {
      draft[head] = parseValue(raw, source[head], path)
      continue
    }
    // 入れ子: いまの値（同じコマンドで先に変えたものを含む）を写して、その中を変える
    const base = (Object.hasOwn(draft, head) ? draft[head] : source[head]) as unknown
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
