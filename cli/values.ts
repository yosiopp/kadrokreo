import { LAYOUT_DEFAULTS } from '../src/document/kdr.ts'
import { isShadow, solid } from '../src/document/paint.ts'
import type { AutoLayout, Effect, PathContour, PathPoint, SceneNode, VariableCollection, VariableId } from '../src/document/types.ts'
import { BINDINGS, acceptsBinding, canBind, isBindingKey, resolveVariable, variableIndex } from '../src/document/variables.ts'
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
// radius.1=8（N 番目の輪郭だけ。0 が最初の輪郭 points、1 からが contours）、
// width=fill / height=hug（大きさの決め方 sizing。数値なら、その大きさで固定にする）、lineHeight=24px（px で書いた行の高さを fontSize に対する倍率に直す）、
// letterSpacing=0.05em（em で書いた字間を px に直す。px は 2px でも 2 でも同じ）、
// フレームの layout=row|column（自動で並べる。余白も間隔も 0 から始める）と、並べ方の項目（gap=8 padding="12 40" align=center など。layout.gap=8 と同じ）。
// 色の値には var(変数の名前) で色の変数を指せる（fill=var(color/primary)、shadow.color=var(…)、fills.0.color=var(…)）。色を直接書けばつながりは外れる。
// 数値・文字・真偽の項目（document/variables.ts の BINDINGS。cornerRadius=var(radius/md)、gap=var(space/md)、text=var(copy/title)）も同じ。
// 同じ語彙を、マークアップ（kdr build / place。markup.ts）の属性にも使う。
// どんな値を入れても、コマンドごとに kdr の検証を通すので、壊れたファイルは書き出さない。

/** 略記を、本来の項目の「名前=値」に直す。直せないもの（そのノードにない項目）はそのまま返す */
function expandShorthand(
  node: SceneNode,
  path: string,
  raw: string,
  draft: Record<string, unknown>,
  collections: readonly VariableCollection[],
): [string, unknown] | null {
  const [head, ...rest] = path.split('.')
  if ((head === 'fill' || head === 'stroke') && rest.length === 0) {
    const key = head === 'fill' ? 'fills' : 'strokes'
    if (!Object.hasOwn(node, key)) return null
    const bound = colorVariableRef(collections, raw, path)
    if (bound) return [key, [{ ...solid(bound.color)[0], variable: bound.id }]]
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
    const next = setIn(first, rest, raw, path, collections) as unknown as Effect
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

/** フレームの並べ方の項目。layout. を付けずに書ける */
const LAYOUT_KEYS = new Set([
  'direction',
  'gap',
  'padding',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'align',
  'justify',
  'wrap',
  'crossGap',
  'alignContent',
])

const DIRECTIONS: Record<string, AutoLayout['direction']> = { row: 'horizontal', column: 'vertical', horizontal: 'horizontal', vertical: 'vertical' }

/**
 * 大きさと並べ方の略記を、項目の patch に直す。当てはまらなければ null。
 *   layout=row|column   フレームを自動で並べる（すでに並べていれば向きだけ変える）。余白も間隔も 0 から始め、大きさは中身に合わせる
 *   width=fill|hug      大きさの決め方（sizing）。数値なら、その大きさで固定にする（テキストの高さはいつも中身で決まる）
 *   lineHeight=24px     行の高さを px で（fontSize に対する倍率に直す）
 *   letterSpacing=0.05em  字間を em で（その時点の fontSize を掛けて px に直す。あとで fontSize を変えても px のまま）。2px は 2 と同じ
 */
function expandSizing(node: SceneNode, path: string, raw: string, draft: Record<string, unknown>): Record<string, unknown> | null {
  const value = raw.trim()
  const sizing = () => (Object.hasOwn(draft, 'sizing') ? draft.sizing : node.sizing) as SceneNode['sizing']
  if (path === 'layout' && node.type === 'frame' && Object.hasOwn(DIRECTIONS, value)) {
    const current = (Object.hasOwn(draft, 'layout') ? draft.layout : node.layout) as AutoLayout | null
    if (current) return { layout: { ...current, direction: DIRECTIONS[value] } }
    const { width, height } = sizing()
    return {
      layout: { ...LAYOUT_DEFAULTS, direction: DIRECTIONS[value] } satisfies AutoLayout,
      sizing: { width: width === 'fill' ? 'fill' : 'hug', height: height === 'fill' ? 'fill' : 'hug' },
    }
  }
  if (path === 'width' || path === 'height') {
    if (value === 'fill' || value === 'hug') return { sizing: { ...sizing(), [path]: value } }
    const size = parseValue(raw, 0, path)
    const fixed = sizing()[path] === 'fixed' || (node.type === 'text' && path === 'height')
    return fixed ? { [path]: size } : { [path]: size, sizing: { ...sizing(), [path]: 'fixed' } }
  }
  if (path === 'lineHeight' && node.type === 'text' && /px$/i.test(value)) {
    const px = Number(value.slice(0, -2))
    const fontSize = (Object.hasOwn(draft, 'fontSize') ? draft.fontSize : node.fontSize) as number
    if (value.length === 2 || !Number.isFinite(px) || !(px > 0) || !(fontSize > 0)) throw new UsageError(`${path}: 24px のように正の数で指定してください: ${raw}`)
    return { lineHeight: px / fontSize }
  }
  if (path === 'letterSpacing' && node.type === 'text' && /(px|em)$/i.test(value)) {
    const amount = Number(value.slice(0, -2))
    if (value.length === 2 || !Number.isFinite(amount)) throw new UsageError(`${path}: 2px や 0.05em のように数で指定してください: ${raw}`)
    const fontSize = (Object.hasOwn(draft, 'fontSize') ? draft.fontSize : node.fontSize) as number
    return { letterSpacing: /em$/i.test(value) ? amount * fontSize : amount }
  }
  return null
}

/**
 * ほかの値の読み方を決める項目を先にする（layout=row があれば gap= などより先、fontSize= は lineHeight=24px や letterSpacing=0.05em より先）。
 * ほかは書いた順のまま
 */
export function orderAssignments<T extends readonly [string, string]>(assignments: readonly T[]): T[] {
  const first = (entry: T) => entry[0] === 'layout' || entry[0] === 'fontSize'
  return [...assignments.filter(first), ...assignments.filter((entry) => !first(entry))]
}

/** そのノードの種類が持たない項目や、木構造に関わる項目は変えられない */
const READONLY = new Set(['id', 'type', 'parentId', 'children', 'component'])

export function parseValue(raw: string, current: unknown, key: string): unknown {
  // 文字の項目（名前・文言・書体名など）は、書いたままの文字にする（「[下書き]」のような名前を JSON として読まない。null を取る文字の項目はないので、「null」もそのまま）
  if (typeof current === 'string') return raw
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
export function buildPatch(
  node: SceneNode,
  assignments: readonly [string, string][],
  collections: readonly VariableCollection[] = [],
): NodePatch {
  const draft: Record<string, unknown> = {}
  const source = node as unknown as Record<string, unknown>
  for (const [written, raw] of orderAssignments(assignments)) {
    // フレームの並べ方の項目は、layout. を付けたものとして読む
    const path = node.type === 'frame' && LAYOUT_KEYS.has(written) ? `layout.${written}` : written
    if (isBindingKey(path) && bindValue(node, draft, path, raw, collections)) continue
    // padding=var(名前) は 4 辺ともつなぐ
    if (path === 'layout.padding' && VARIABLE_REF.test(raw.trim())) {
      for (const side of ['layout.paddingTop', 'layout.paddingRight', 'layout.paddingBottom', 'layout.paddingLeft'] as const) bindValue(node, draft, side, raw, collections)
      continue
    }
    const sizing = expandSizing(node, path, raw, draft)
    if (sizing) {
      Object.assign(draft, sizing)
      continue
    }
    const radius = expandRadius(node, path, raw, draft)
    if (radius) {
      Object.assign(draft, radius)
      continue
    }
    const shorthand = expandShorthand(node, path, raw, draft, collections)
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
        head === 'layout' ? `${path}: 先に layout=row|column か auto-layout で自動で並べるようにしてください` : `${path}: ${head} が空です`,
      )
    }
    draft[head] = setIn(structuredClone(base) as Record<string, unknown>, rest, raw, path, collections)
  }
  return draft as NodePatch
}

function setIn(
  target: Record<string, unknown>,
  keys: readonly string[],
  raw: string,
  path: string,
  collections: readonly VariableCollection[],
): Record<string, unknown> {
  const [key, ...rest] = keys
  // 塗り・グラデーションの色・影の色: var(名前) なら変数につなぎ、色を直接書けばつながりを外す
  if (key === 'color' && rest.length === 0 && typeof target.color === 'string') {
    const bound = colorVariableRef(collections, raw, path)
    if (bound) Object.assign(target, { color: bound.color, variable: bound.id })
    else {
      target.color = raw
      delete target.variable
    }
    return target
  }
  // layout.padding は 4 辺まとめて。空白かカンマで区切れば、CSS と同じ順（上下 左右 / 上 左右 下 / 上 右 下 左）
  if (key === 'padding' && rest.length === 0 && Object.hasOwn(target, 'paddingTop')) {
    const values = raw.trim().split(/[\s,]+/).map((part) => parseValue(part, 0, path))
    if (values.length > 4) throw new UsageError(`${path}: 数値は 1〜4 個です（上 右 下 左の順）: ${raw}`)
    const [top, right = top, bottom = top, left = right] = values
    Object.assign(target, { paddingTop: top, paddingRight: right, paddingBottom: bottom, paddingLeft: left })
    return target
  }
  if (!Object.hasOwn(target, key)) throw new UsageError(`${path}: ${key} という項目はありません`)
  if (rest.length === 0) target[key] = parseValue(raw, target[key], path)
  else {
    const child = target[key]
    if (child === null || typeof child !== 'object') throw new UsageError(`${path}: ${key} が空です`)
    target[key] = setIn(child as Record<string, unknown>, rest, raw, path, collections)
  }
  return target
}

const VARIABLE_REF = /^var\((.+)\)$/

/**
 * var(名前) で指した色の変数と、その値（最初のモード。ノードの位置のモードでの値には、後始末が解決し直す）。var( で始まらなければ null。
 * 名前は「変数の名前」か、同じ名前が複数のコレクションにあるときは「コレクションの名前:変数の名前」
 */
export function colorVariableRef(
  collections: readonly VariableCollection[],
  raw: string,
  path: string,
): { id: VariableId; color: string } | null {
  const match = VARIABLE_REF.exec(raw.trim())
  if (!match) return null
  const variable = findVariableByRef(collections, match[1].trim(), path)
  if (variable.type !== 'color') throw new UsageError(`${path}: ${variable.name} は色の変数ではありません`)
  const color = resolveVariable(variableIndex(collections), variable.id, (collection) => collection.modes[0].id)
  return { id: variable.id, color: typeof color === 'string' ? color : '#000000' }
}

/** 変数の名前（か「コレクションの名前:変数の名前」）で変数を探す。無い・どれか決まらないときは UsageError */
export function findVariableByRef(collections: readonly VariableCollection[], ref: string, path = ref) {
  const hits = collections.flatMap((collection) => collection.variables.filter((variable) => variable.name === ref))
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new UsageError(`${path}: ${ref} という変数が複数のコレクションにあります（コレクションの名前:変数の名前 で指定してください）`)
  const colon = ref.indexOf(':')
  if (colon > 0) {
    const collection = collections.find((item) => item.name === ref.slice(0, colon))
    const variable = collection?.variables.find((item) => item.name === ref.slice(colon + 1))
    if (variable) return variable
  }
  throw new UsageError(`${path}: ${ref} という変数がありません（kdr vars で一覧できます）`)
}

/**
 * 数値・文字・真偽の項目への var(名前)。変数の値を入れ、つながりを draft.bindings に書く（true を返す）。
 * var( でなければ、つないでいる項目なら値を直接書くのでつながりを外し、false を返す（値はふだんどおり読む）
 */
function bindValue(
  node: SceneNode,
  draft: Record<string, unknown>,
  key: keyof typeof BINDINGS,
  raw: string,
  collections: readonly VariableCollection[],
): boolean {
  const current = (Object.hasOwn(draft, 'bindings') ? draft.bindings : node.bindings) as Record<string, VariableId> | undefined
  const match = VARIABLE_REF.exec(raw.trim())
  if (!match) {
    if (current && Object.hasOwn(current, key)) {
      const rest = { ...current }
      delete rest[key]
      // 空になれば項目ごと外す（undefined は書き出しでも同期の比べでも「無い」と同じ）
      draft.bindings = Object.keys(rest).length > 0 ? rest : undefined
    }
    return false
  }
  const variable = findVariableByRef(collections, match[1].trim(), key)
  if (variable.type !== BINDINGS[key]) throw new UsageError(`${key}: ${variable.name} は ${BINDINGS[key]} の変数ではありません`)
  // 同じコマンドで先に書いた項目（layout=row など）も見る
  const merged = { ...node, ...draft } as SceneNode
  if (!canBind(merged, key)) throw new UsageError(`${node.type} には ${key} がありません${key.startsWith('layout.') ? '（先に layout=row|column で自動で並べる）' : ''}`)
  const value = resolveVariable(variableIndex(collections), variable.id, (collection) => collection.modes[0].id)
  if (!acceptsBinding(key, value)) throw new UsageError(`${key}: ${variable.name} の値 ${String(value)} は入れられません`)
  if (key.startsWith('layout.')) {
    draft.layout = { ...(merged as { layout: Record<string, unknown> }).layout, [key.slice(7)]: value }
  } else draft[key] = value
  draft.bindings = { ...current, [key]: variable.id }
  return true
}
