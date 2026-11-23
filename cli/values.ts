import { isShadow, solid } from '../src/document/paint.ts'
import type { Effect, PathContour, PathPoint, SceneNode } from '../src/document/types.ts'
import { parseDashes } from '../src/editor/dashes.ts'
import { DEFAULT_SHADOW } from '../src/editor/operations/paints.ts'
import type { NodePatch } from '../src/editor/operations/tree.ts'
import { UsageError } from './args.ts'

// set / add の「名前=値」を、ノードへの patch に直す。
// 値の型は、そのノードがいま持っている値の型に合わせる（text=123 は文字列のまま）。
// 入れ子の項目は . でつなぐ（layout.gap=8、sizing.width=fill）。配列の要素は番号でつなぐ（effects.0.blur=4）。
// よく使うものには略記がある: fill=色 / stroke=色（単色 1 つの塗り・線にする。null で外す）、
// shadow.blur=4 など（最初の影。なければ editor のパネルと同じ既定の影 DEFAULT_SHADOW を付けてから変える）、shadow=null（影を外す）、
// blur=8 / backgroundBlur=8（レイヤーのぼかし・背景のぼかし。最初のその効果を変えるか足す。null か 0 で外す）、
// cornerRadius=0,8,8,0（角丸を 4 隅ばらばらに。左上・右上・右下・左下の順）、dash=4,2（破線。null で実線）、radius=8（パスの全部の輪郭の頂点の角の丸め。頂点ごとなら全部の輪郭の通し番号の順にカンマで並べる）、
// radius.1=8（N 番目の輪郭だけ。0 が最初の輪郭 points、1 からが contours）。
// どんな値を入れても、コマンドごとに kdr の検証を通すので、壊れたファイルは書き出さない。

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
  // 破線のずれ・線の角の形の略記（strokeDashOffset=・strokeJoin= と同じ。読み込みの検証が値を確かめる）
  if (head === 'dashOffset' && rest.length === 0 && Object.hasOwn(node, 'strokeDashOffset')) return ['strokeDashOffset', parseValue(raw, 0, path)]
  if (head === 'join' && rest.length === 0 && Object.hasOwn(node, 'strokeJoin')) return ['strokeJoin', raw.trim()]
  const currentEffects = () => (Object.hasOwn(draft, 'effects') ? draft.effects : node.effects) as Effect[]
  if (head === 'shadow') {
    // 影の略記は、ぼかしを除いた最初の影に当てる
    const current = currentEffects()
    const at = current.findIndex(isShadow)
    if (rest.length === 0) {
      if (raw !== 'null') throw new UsageError(`${path}: shadow は null（外す）か shadow.blur=4 のように指定してください`)
      return ['effects', current.filter((effect) => !isShadow(effect))]
    }
    const first = structuredClone(at === -1 ? DEFAULT_SHADOW : current[at]) as unknown as Record<string, unknown>
    const next = setIn(first, rest, raw, path) as unknown as Effect
    return ['effects', at === -1 ? [next, ...current] : current.with(at, next)]
  }
  if ((head === 'blur' || head === 'backgroundBlur') && rest.length === 0) {
    const type = head === 'blur' ? 'layer-blur' : 'background-blur'
    const current = currentEffects()
    const at = current.findIndex((effect) => effect.type === type)
    const value = raw === 'null' ? 0 : parseValue(raw, 0, path)
    if (typeof value !== 'number' || !(value >= 0)) throw new UsageError(`${path}: 0 以上の数を指定してください（null で外す）`)
    if (value === 0) return ['effects', current.filter((effect) => effect.type !== type)]
    const effect: Effect = { type, blur: value, visible: true }
    return ['effects', at === -1 ? [...current, effect] : current.with(at, effect)]
  }
  return null
}

/**
 * パスの頂点の角の丸め（radius= / radius.N=）を、輪郭の項目（points・contours）の patch に直す。パスでなければ null。
 * radius= は全部の輪郭の頂点、radius.N= は N 番目の輪郭（0 が points、1 からが contours）だけ。
 * 数値 1 つなら対象の頂点すべて、カンマで並べれば頂点ごと（対象の輪郭の通し番号の順。0 は丸めない）
 */
function expandRadius(node: SceneNode, path: string, raw: string, draft: Record<string, unknown>): Record<string, unknown> | null {
  const [head, ...rest] = path.split('.')
  if (head !== 'radius' || rest.length > 1 || node.type !== 'path') return null
  const first = (Object.hasOwn(draft, 'points') ? draft.points : node.points) as PathPoint[]
  const others = (Object.hasOwn(draft, 'contours') ? draft.contours : node.contours) as PathContour[]
  const all = [first, ...others.map((contour) => contour.points)]
  let targets = all.map((_, i) => i)
  if (rest.length === 1) {
    const index = Number(rest[0])
    if (!/^\d+$/.test(rest[0]) || index >= all.length) {
      throw new UsageError(`${path}: 輪郭の番号は 0〜${all.length - 1} です（0 が最初の輪郭）`)
    }
    targets = [index]
  }
  const count = targets.reduce((sum, i) => sum + all[i].length, 0)
  const values = raw.split(',').map((part) => parseValue(part, 0, path))
  if (values.some((value) => typeof value !== 'number' || !(value >= 0))) throw new UsageError(`${path}: 0 以上の数を指定してください`)
  if (values.length !== 1 && values.length !== count) {
    throw new UsageError(`${path}: 数値 1 つか、頂点の数（${count}）だけ並べてください`)
  }
  let at = 0
  const rounded = all.map((points, i) => {
    if (!targets.includes(i)) return points
    return points.map((point) => {
      const { radius: _, ...plain } = point
      const radius = (values.length === 1 ? values[0] : values[at]) as number
      at++
      return radius > 0 ? { ...plain, radius } : plain
    })
  })
  const patch: Record<string, unknown> = {}
  if (targets.includes(0)) patch.points = rounded[0]
  if (targets.some((i) => i > 0)) patch.contours = others.map((contour, i) => ({ ...contour, points: rounded[i + 1] }))
  return patch
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
    const radius = expandRadius(node, path, raw, draft)
    if (radius) {
      Object.assign(draft, radius)
      continue
    }
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
