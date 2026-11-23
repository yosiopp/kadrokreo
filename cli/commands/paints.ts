import { type Size, normalizeAngle } from '../../src/document/geometry.ts'
import { linearFromAngle, solidPaint } from '../../src/document/paint.ts'
import { BLEND_MODES } from '../../src/document/kdr.ts'
import type { BlendMode, ColorStop, NodeId, Paint } from '../../src/document/types.ts'
import { MAX_PAINTS, MAX_STOPS, type PaintKey, convertPaint } from '../../src/editor/operations/paints.ts'
import { patchNodes } from '../../src/editor/operations/tree.ts'
import { type Step, UsageError } from '../args.ts'
import { type Command, checkStep, flag, numberOption, option, positional } from './common.ts'

// 塗りのコマンド。塗りは editor のキャンバス操作（GradientEdit）と同じく「どの配列（fills / strokes）の何番目か」で指す。
// 配列の先頭が一番下で、いちばん上に見えるのは最後の要素

const GRADIENT_TYPES = ['linear', 'radial', 'conic'] as const
type GradientType = (typeof GRADIENT_TYPES)[number]

export const gradient: Command = {
  name: 'gradient',
  kind: 'edit',
  flags: ['stroke', 'add', 'hidden'],
  usage:
    'gradient [linear|radial|conic] ノード… [--colors 色,色@50%,色…] [--stop N=色[@位置],…] [--angle 度] [--from x,y --to x,y] [--center x,y] [--radius r|rx,ry] [--focus fx,fy] [--opacity 0〜1] [--blend 描画モード] [--hidden] [--stroke] [--index N | --add]',
  summary:
    'グラデーションの塗りにする。ふつうはいちばん上の塗り（なければ足す）を置き換え、--index N は N 番目（0 が一番下、-1 がいちばん上）、--add は上に重ねる。' +
    '--stroke なら線。--colors は 2〜16 色で、@ の後に位置（0〜1 か %）。#rrggbbaa・#rgba の色は最後の桁が色ごとの透明度。位置を省いた色は前後の間に等しく並べる。' +
    '--colors を省くと、いまの塗りの色を受け継ぐ。--stop は N 番目（0 が最初、-1 が最後）の色だけを変える（「1=#ff0000」「-1=#00f8」「0=@20%」のように色・位置のどちらかだけでもよい。カンマで区切っていくつでも）。' +
    '種類を省くと、いまのグラデーションの種類のまま色や向きだけ変える。直線は --angle（0 が左から右、90 が上から下。枠の中心を通り、枠の角が両端の色になる線）か、' +
    '--from と --to（始点・終点。枠に対する割合か %）、円形は --center と --radius（枠に対する割合か %）と --angle（楕円を回す角度。時計回り）、--focus（焦点。中心からのずれを横・縦の半径に対する割合か % で。楕円の中に限る）、' +
    '角度（conic）は --center と --angle（最初の色の向き。0 が右で時計回り）。--opacity は塗りごとの不透明度、--blend は塗りの描画モード（multiply など）、--hidden はその塗りを隠す（消さずに残す）',
  run({ session }, step) {
    checkStep(step, {
      options: ['colors', 'stop', 'angle', 'from', 'to', 'center', 'radius', 'focus', 'opacity', 'blend', 'hidden', 'stroke', 'index', 'add'],
    })
    // 種類は省ける（いまのグラデーションの種類のまま）
    const first = positional(step, 0, 'ノード')
    const type = (GRADIENT_TYPES as readonly string[]).includes(first) ? (first as GradientType) : null
    const ids = session.resolveAll(step.positionals.slice(type === null ? 0 : 1))
    if (ids.length === 0) throw new UsageError('gradient: ノードを指定してください')
    const key: PaintKey = flag(step, 'stroke') ? 'strokes' : 'fills'
    const add = flag(step, 'add')
    const index = integerOption(step, 'index')
    if (add && index !== undefined) throw new UsageError('gradient: --index と --add は一緒に使えません')
    if (add && type === null) throw new UsageError('gradient: --add のときは種類（linear / radial / conic）を指定してください')

    const colors = option(step, 'colors')
    const stops = colors === undefined ? undefined : parseStops(colors)
    const stopRaw = option(step, 'stop')
    const stopEdits = stopRaw === undefined ? [] : parseStopEdits(stopRaw)
    const angle = numberOption(step, 'angle')
    const center = pairOption(step, 'center', false)
    const from = pairOption(step, 'from', false)
    const to = pairOption(step, 'to', false)
    if (angle !== undefined && (from || to)) throw new UsageError('gradient: --angle と --from / --to は一緒に使えません')
    const radius = pairOption(step, 'radius', true)
    const opacity = numberOption(step, 'opacity')
    if (opacity !== undefined && !(opacity >= 0 && opacity <= 1)) throw new UsageError(`gradient: --opacity は 0〜1 です: ${opacity}`)
    const hidden = flag(step, 'hidden')
    const focus = pairOption(step, 'focus', false)
    if (focus && focus[0] ** 2 + focus[1] ** 2 > 1) throw new UsageError(`gradient: --focus は楕円の中（fx² + fy² ≤ 1）です: ${option(step, 'focus')}`)
    const blend = option(step, 'blend')
    if (blend !== undefined && !(BLEND_MODES as readonly string[]).includes(blend)) {
      throw new UsageError(`gradient: --blend は ${BLEND_MODES.join(' / ')} のどれかです: ${blend}`)
    }
    /** 種類に合わないオプションを弾く（種類を省いたときは、塗りごとにいまの種類で確かめる） */
    const checkType = (kind: GradientType) => {
      if (kind !== 'linear' && (from || to)) throw new UsageError('gradient: --from と --to は linear のときだけです')
      if (kind === 'linear' && center) throw new UsageError('gradient: --center は radial と conic のときだけです')
      if (kind !== 'radial' && radius) throw new UsageError('gradient: --radius は radial のときだけです')
      if (kind !== 'radial' && focus) throw new UsageError('gradient: --focus は radial のときだけです')
    }
    if (type !== null) checkType(type)

    /** 元の塗り（なければ null）から、作るグラデーション */
    const build = (base: Paint | null, size: Size, id: NodeId): Paint => {
      if (base === null && type === null) throw new UsageError(`gradient: ${id} に塗りがありません。種類（linear / radial / conic）と --colors を指定してください`)
      if (base === null && stops === undefined) throw new UsageError('gradient: 塗りがないノードには --colors を指定してください')
      const kind = type ?? (base!.type === 'solid' ? null : base!.type)
      if (kind === null) throw new UsageError(`gradient: ${id} の塗りはグラデーションではありません。種類（linear / radial / conic）を指定してください`)
      if (type === null) checkType(kind)
      let paint = convertPaint(base ?? solidPaint('#000000'), kind)
      if (paint.type === 'solid') throw new Error('unreachable')
      if (stops) paint = { ...paint, stops }
      if (stopEdits.length > 0) paint = { ...paint, stops: applyStopEdits(paint.stops, stopEdits, id) }
      if (opacity !== undefined) paint = { ...paint, opacity }
      if (hidden) paint = { ...paint, visible: false }
      if (blend !== undefined) paint = { ...paint, blendMode: blend as BlendMode }
      if (paint.type === 'linear' && angle !== undefined) paint = { ...paint, ...linearFromAngle(normalizeAngle(angle), size) }
      if (paint.type === 'linear' && from) paint = { ...paint, x1: from[0], y1: from[1] }
      if (paint.type === 'linear' && to) paint = { ...paint, x2: to[0], y2: to[1] }
      if (paint.type === 'conic' && angle !== undefined) paint = { ...paint, angle: normalizeAngle(angle) }
      if (paint.type === 'conic' && center) paint = { ...paint, cx: center[0], cy: center[1] }
      if (paint.type === 'radial') {
        if (center) paint = { ...paint, cx: center[0], cy: center[1] }
        if (radius) paint = { ...paint, rx: radius[0], ry: radius[1] }
        if (angle !== undefined) paint = { ...paint, angle: normalizeAngle(angle) }
        if (focus) paint = { ...paint, fx: focus[0], fy: focus[1] }
      }
      return paint
    }

    session.apply((page) => {
      for (const id of ids) {
        if (!(key in page.nodes[id])) {
          throw new UsageError(`gradient: ${id}（${page.nodes[id].type}）は${key === 'strokes' ? '線' : '塗り'}を持ちません`)
        }
      }
      return patchNodes(page, ids, (node) => {
        const paints = (node as unknown as Record<PaintKey, Paint[]>)[key]
        if (add || (index === undefined && paints.length === 0)) {
          if (paints.length >= MAX_PAINTS) throw new UsageError(`gradient: ${node.id} の塗りは ${MAX_PAINTS} 個までです`)
          return { [key]: [...paints, build(null, node, node.id)] }
        }
        const at = index === undefined ? paints.length - 1 : index < 0 ? paints.length + index : index
        if (at < 0 || at >= paints.length) {
          throw new UsageError(`gradient: ${node.id} に ${index} 番目の塗りがありません（${paints.length} 個）`)
        }
        return { [key]: paints.with(at, build(paints[at], node, node.id)) }
      })
    })
  },
}

function integerOption(step: Step, name: string): number | undefined {
  const value = numberOption(step, name)
  if (value !== undefined && !Number.isInteger(value)) throw new UsageError(`${step.name}: --${name} は整数です: ${value}`)
  return value
}

/** 「0.5」か「50%」を割合にする */
function fraction(raw: string, label: string): number {
  const text = raw.trim()
  const percent = text.endsWith('%')
  const value = Number(percent ? text.slice(0, -1) : text)
  if (text === '' || text === '%' || !Number.isFinite(value)) throw new UsageError(`${label} は数か % です: ${raw}`)
  return percent ? value / 100 : value
}

/** --center x,y / --focus fx,fy / --radius r|rx,ry（割合か %）。one が true なら 1 つで両方 */
function pairOption(step: Step, name: string, one: boolean): [number, number] | null {
  const raw = option(step, name)
  if (raw === undefined) return null
  const parts = raw.split(',').map((part) => fraction(part, `${step.name}: --${name}`))
  if (parts.length === 1 && one) parts.push(parts[0])
  if (parts.length !== 2) throw new UsageError(`${step.name}: --${name} は ${one ? '「r」か「rx,ry」' : '「x,y」'} の形です: ${raw}`)
  if (name === 'radius' && parts.some((part) => !(part > 0))) throw new UsageError(`${step.name}: --radius は 0 より大きい数です: ${raw}`)
  return [parts[0], parts[1]]
}

/** #rgb / #rrggbb を #rrggbb（小文字）に。#rgba / #rrggbbaa なら最後の 2 桁（1 桁）を色の不透明度にする */
function parseColor(raw: string): { color: string; opacity: number } {
  const text = raw.trim().toLowerCase()
  const long = /^#[0-9a-f]{3,4}$/.test(text) ? `#${[...text.slice(1)].map((c) => c + c).join('')}` : text
  if (/^#[0-9a-f]{6}$/.test(long)) return { color: long, opacity: 1 }
  if (/^#[0-9a-f]{8}$/.test(long)) return { color: long.slice(0, 7), opacity: Math.round((parseInt(long.slice(7), 16) / 255) * 1000) / 1000 }
  throw new UsageError(`gradient: 色は #rrggbb・#rgb（透明度つきは #rrggbbaa・#rgba）です: ${raw}`)
}

/**
 * 「#f00,#0f0@30%,#00f」を色の並びにする。位置を省いた色は、最初が 0・最後が 1、
 * 間は前後の位置のあいだに等しく並べる（CSS のグラデーションと同じ）。位置が戻るとエラー
 */
function parseStops(raw: string): ColorStop[] {
  const items = raw.split(',').map((item) => {
    const at = item.indexOf('@')
    const { color, opacity } = parseColor(at === -1 ? item : item.slice(0, at))
    const offset = at === -1 ? null : fraction(item.slice(at + 1), `gradient: ${item.trim()} の位置`)
    if (offset !== null && !(offset >= 0 && offset <= 1)) throw new UsageError(`gradient: 位置は 0〜1（0%〜100%）です: ${item.trim()}`)
    return { color, opacity, offset }
  })
  if (items.length < 2 || items.length > MAX_STOPS) throw new UsageError(`gradient: --colors は 2〜${MAX_STOPS} 色です（${items.length} 色）`)
  const offsets = items.map((item) => item.offset)
  offsets[0] ??= 0
  offsets[offsets.length - 1] ??= 1
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i] !== null) continue
    let j = i
    while (offsets[j] === null) j++
    const from = offsets[i - 1]!
    const to = offsets[j]!
    for (let k = i; k < j; k++) offsets[k] = Math.round((from + ((to - from) * (k - i + 1)) / (j - i + 1)) * 1000) / 1000
  }
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i]! < offsets[i - 1]!) throw new UsageError(`gradient: 色の位置は小さい順に並べてください: ${raw}`)
  }
  return items.map((item, i) => ({ offset: offsets[i]!, color: item.color, opacity: item.opacity }))
}

/** --stop の 1 つ。index は負なら後ろから。color / offset は変えないなら null */
type StopEdit = { index: number; color: { color: string; opacity: number } | null; offset: number | null; raw: string }

/** 「1=#f00,-1=#00f8@90%,0=@20%」を色ごとの変更にする */
function parseStopEdits(raw: string): StopEdit[] {
  return raw.split(',').map((item) => {
    const text = item.trim()
    const eq = text.indexOf('=')
    const index = Number(text.slice(0, eq))
    if (eq <= 0 || !Number.isInteger(index)) throw new UsageError(`gradient: --stop は「N=色」「N=色@位置」「N=@位置」の形です（N は 0 からの番号）: ${text}`)
    const value = text.slice(eq + 1)
    const at = value.indexOf('@')
    const colorText = at === -1 ? value : value.slice(0, at)
    if (colorText.trim() === '' && at === -1) throw new UsageError(`gradient: --stop ${text} に色も位置もありません`)
    const color = colorText.trim() === '' ? null : parseColor(colorText)
    const offset = at === -1 ? null : fraction(value.slice(at + 1), `gradient: ${text} の位置`)
    if (offset !== null && !(offset >= 0 && offset <= 1)) throw new UsageError(`gradient: 位置は 0〜1（0%〜100%）です: ${text}`)
    return { index, color, offset, raw: text }
  })
}

/** 色の並びに --stop の変更を当てる。番号が範囲の外、位置が戻るならエラー */
function applyStopEdits(stops: readonly ColorStop[], edits: readonly StopEdit[], id: NodeId): ColorStop[] {
  const next = [...stops]
  for (const edit of edits) {
    const at = edit.index < 0 ? next.length + edit.index : edit.index
    if (at < 0 || at >= next.length) throw new UsageError(`gradient: ${id} に ${edit.index} 番目の色がありません（${next.length} 色）: ${edit.raw}`)
    next[at] = {
      ...next[at],
      ...(edit.color ?? {}),
      ...(edit.offset === null ? {} : { offset: edit.offset }),
    }
  }
  if (next.some((stop, i) => i > 0 && stop.offset < next[i - 1].offset)) {
    throw new UsageError(`gradient: ${id} の色の位置が小さい順に並ばなくなります（${next.map((stop) => stop.offset).join(', ')}）`)
  }
  return next
}
