import {
  type InstanceNode,
  OVERRIDE_KEYS,
  derivedId,
  findMain,
  instanceOf,
  isMain,
} from '../document/component.ts'
import { getAbsoluteBounds, getNodesBounds, tidy } from '../document/geometry.ts'
import { type ColorFormat, formatColor } from './colors.ts'
import { type Distance, measureBetween } from './distances.ts'
import { sizeLimited, stretchedAxes, wraps } from '../document/autoLayout.ts'
import { isVariantSet, parseVariantName, variantProperties, variantSetOf } from '../document/variants.ts'
import type { AutoLayout, DesignDocument, Gradient, NodeId, Override, Scene, SceneNode, Shadow } from '../document/types.ts'
import { CAP_LABELS, FIT_LABELS, OVERRIDE_LABELS, SIZE_MODE_LABELS, alignLabels } from '../ui/labels.ts'

// viewer で見せる、ノードの設定の一覧と CSS。どちらもドキュメントを読むだけで、変更はしない。

/** color を付けると、値の横に色見本を出す。nodes を付けると、それらのノードを選ぶボタンを出す */
export type InspectRow = { label: string; value: string; color?: string; nodes?: NodeId[] }
export type InspectSection = { title: string; rows: InspectRow[] }

const DIRECTIONS = { horizontal: '横', vertical: '縦' }
const JUSTIFY = { start: '先頭', center: '中央', end: '末尾', 'space-between': '均等' }
const TEXT_ALIGN = { left: '左', center: '中央', right: '右' }

/** CSS の長さの単位 */
export type Unit = 'px' | 'rem'

/** CSS の書き方。remBase は 1rem が何 px か */
export type CodeStyle = { unit: Unit; remBase: number; color: ColorFormat }
export const DEFAULT_CODE_STYLE: CodeStyle = { unit: 'px', remBase: 16, color: 'hex' }

/** 小数 2 桁まで。計算で出る細かい端数は見せない */
function num(value: number): string {
  return String(tidy(value))
}

function percent(ratio: number): string {
  return `${num(ratio * 100)}%`
}

/** ノードの設定を、見出しごとにまとめる。その種類のノードにない項目や、既定のままで意味のない項目は出さない */
export function inspectNode(
  doc: DesignDocument,
  scene: Scene,
  id: NodeId,
  format: ColorFormat = 'hex',
): InspectSection[] {
  const node = scene.nodes[id]
  const hex = (color: string) => formatColor(color, format, { upper: true })
  const sections: InspectSection[] = []
  const add = (title: string, rows: (InspectRow | false | null)[]) => {
    const shown = rows.filter((row) => row !== false && row !== null)
    if (shown.length > 0) sections.push({ title, rows: shown })
  }

  const stretched = stretchedAxes(scene, node)
  // 親いっぱいに伸ばしている向きは、値のあとに書き添える
  const fillNote = (on: boolean) => (on ? '（親いっぱい）' : '')
  add('位置とサイズ', [
    { label: 'X', value: num(node.x) },
    { label: 'Y', value: num(node.y) },
    { label: '幅', value: `${num(node.width)}${fillNote(stretched.width)}` },
    { label: '高さ', value: `${num(node.height)}${fillNote(stretched.height)}` },
    ...limitRows(scene, node),
    inFlexParent(scene, node.id) && node.layoutPositioning === 'absolute' && { label: '配置', value: '並びから外す' },
    node.rotation !== 0 && { label: '回転', value: `${num(node.rotation)}°` },
    'cornerRadius' in node && node.cornerRadius > 0 && { label: '角丸', value: num(node.cornerRadius) },
    node.opacity < 1 && { label: '不透明度', value: percent(node.opacity) },
  ])

  if (node.type === 'frame' && node.layout) {
    const { layout } = node
    add('オートレイアウト', [
      { label: '向き', value: DIRECTIONS[layout.direction] },
      { label: '間隔', value: num(layout.gap) },
      { label: '余白', value: paddingText(layout) },
      { label: '揃え', value: alignLabels(layout.direction)[layout.align] },
      { label: '寄せ', value: JUSTIFY[layout.justify] },
      wraps(scene, node) && { label: '折り返し', value: `する（行の間隔 ${num(layout.crossGap)}）` },
      { label: '幅', value: SIZE_MODE_LABELS[layout.widthMode] },
      { label: '高さ', value: SIZE_MODE_LABELS[layout.heightMode] },
    ])
  }

  if (node.type === 'text') {
    add('テキスト', [
      { label: '内容', value: node.text },
      { label: '書体', value: node.fontFamily },
      { label: 'サイズ', value: num(node.fontSize) },
      { label: '太さ', value: String(node.fontWeight) },
      {
        label: '行の高さ',
        value: `${num(node.lineHeight)}（${num(node.fontSize * node.lineHeight)}px）`,
      },
      { label: '行揃え', value: TEXT_ALIGN[node.textAlign] },
      { label: '折り返し', value: node.autoWidth ? 'しない' : '幅に合わせる' },
    ])
  }

  if ('fillGradient' in node && node.fillGradient) {
    add('塗り', [
      { label: 'グラデーション', value: `${num(node.fillGradient.angle)}°` },
      ...node.fillGradient.stops.map((stop) => ({
        label: percent(stop.offset),
        value: hex(stop.color),
        color: stop.color,
      })),
    ])
  } else if ('fill' in node && node.fill !== null) {
    add('塗り', [{ label: '色', value: hex(node.fill), color: node.fill }])
  }

  if ('stroke' in node && node.stroke !== null && node.strokeWidth > 0) {
    add('線', [
      { label: '色', value: hex(node.stroke), color: node.stroke },
      { label: '太さ', value: num(node.strokeWidth) },
      'startCap' in node && node.startCap !== 'none' && { label: '始点', value: CAP_LABELS[node.startCap] },
      'endCap' in node && node.endCap !== 'none' && { label: '終点', value: CAP_LABELS[node.endCap] },
    ])
  }

  if ('shadow' in node && node.shadow) {
    const { shadow } = node
    add('影', [
      { label: '横', value: num(shadow.x) },
      { label: '縦', value: num(shadow.y) },
      { label: 'ぼかし', value: num(shadow.blur) },
      {
        label: '色',
        // HEX のときは、色と濃さを分けて出す（濃さは別の値として持っている）
        value:
          format === 'hex'
            ? `${hex(shadow.color)} ${percent(shadow.opacity)}`
            : formatColor(shadow.color, format, { alpha: shadow.opacity }),
        color: shadow.color,
      },
    ])
  }

  if (node.type === 'image') {
    const asset = doc.assets[node.assetId]
    add('画像', [
      { label: '収め方', value: FIT_LABELS[node.fit] },
      asset !== undefined && { label: '形式', value: asset.mime.replace('image/', '').toUpperCase() },
    ])
  }

  if (isMain(node)) {
    const set = variantSetOf(scene, node.id)
    add('コンポーネント', [
      { label: '種類', value: set ? 'バリアント' : '元' },
      set !== null && { label: 'まとまり', value: set.name },
      ...variantRows(node.name),
    ])
  }
  if (isVariantSet(scene, node.id)) {
    add('コンポーネント', [
      { label: '種類', value: 'バリアントのまとまり' },
      ...variantProperties(scene, node.id).map(({ name, values }) => ({ label: name, value: values.join(' / ') })),
    ])
  }
  const instance = instanceOf(scene, id)
  if (instance) {
    const main = findMain(doc, instance.component.id)
    const own = instance.id === id
    add('コンポーネント', [
      { label: '種類', value: own ? 'インスタンス' : 'インスタンスの中身' },
      !own && { label: 'インスタンス', value: instance.name },
      main !== null && variantSetOf(main.page, main.node.id) === null && { label: '元の名前', value: main.node.name },
      // バリアントのインスタンスは、まとまりの名前と、選んでいるプロパティの値
      ...(main === null ? [] : variantInstanceRows(main.page, main.node)),
      // 中身は、そのノード自身が元と違えている項目だけを出す。インスタンス全体の分は、下の一覧で出す
      !own && overrideRow('上書き', overridesOn(scene, instance, main?.node.id).get(id)),
    ])
    if (own) {
      add(
        '上書き',
        [...overridesOn(scene, instance, main?.node.id)].map(([target, override]) =>
          overrideRow(scene.nodes[target].name, override),
        ),
      )
    }
  }

  return sections
}

/**
 * インスタンスの上書きを、当たっているノード（インスタンス自身か、その中身）の id ごとにまとめる。
 * 上書きは元の側の id で持っているので、写しの id に直す。当たる先がないものは捨てる。
 */
function overridesOn(scene: Scene, instance: InstanceNode, mainId: NodeId | undefined): Map<NodeId, Override> {
  const found = new Map<NodeId, Override>()
  for (const [sourceId, override] of Object.entries(instance.component.overrides)) {
    const target = sourceId === mainId ? instance.id : derivedId(instance.id, sourceId)
    if (Object.hasOwn(scene.nodes, target)) found.set(target, override)
  }
  return found
}

/** 元と違えている項目の名前を並べた行。何も違えていなければ null */
function overrideRow(label: string, override: Override | undefined): InspectRow | null {
  const keys = OVERRIDE_KEYS.filter((key) => override?.[key] !== undefined)
  return keys.length === 0 ? null : { label, value: keys.map((key) => OVERRIDE_LABELS[key]).join('・') }
}

/**
 * ノードの見た目を CSS で表す。実装するときの手がかりにするためのもので、
 * 直線とパスは CSS で形を描けないので、SVG に指定するプロパティ（stroke など）で表す。
 */
export function nodeCss(scene: Scene, id: NodeId, options: Partial<CodeStyle> = {}): string {
  const style = { ...DEFAULT_CODE_STYLE, ...options }
  const color = (value: string) => formatColor(value, style.color)
  const node = scene.nodes[id]
  const parent = node.parentId === null ? null : scene.nodes[node.parentId]
  const lines: string[] = []
  const add = (property: string, value: string) => lines.push(`${property}: ${value};`)
  const px = (value: number) => length(value, style)

  // 自動で並べるフレームの子は、親が位置を決める（並びから外したものを除く）。ページ直下のものは、置き場所を決めない
  const absolute =
    parent?.type === 'frame' && (!parent.layout || node.layoutPositioning === 'absolute')
  const holdsAbsolute =
    node.type === 'frame' &&
    node.children.some((child) => !node.layout || scene.nodes[child].layoutPositioning === 'absolute')
  if (absolute) {
    add('position', 'absolute')
    add('left', px(node.x))
    add('top', px(node.y))
  } else if (holdsAbsolute) {
    // 子を absolute で置くための基準にする
    add('position', 'relative')
  }

  if (node.type === 'frame' && node.layout) {
    const { layout } = node
    const flex = {
      start: 'flex-start',
      center: 'center',
      end: 'flex-end',
      'space-between': 'space-between',
    }
    const wrapping = wraps(scene, node)
    add('display', 'flex')
    add('flex-direction', layout.direction === 'horizontal' ? 'row' : 'column')
    if (wrapping) add('flex-wrap', 'wrap')
    if (layout.align !== 'start') add('align-items', flex[layout.align])
    // 折り返すとき、行のまとまりも揃え方に従って置く（既定の stretch だと行の間に隙間ができる）
    if (wrapping) add('align-content', flex[layout.align])
    if (layout.justify !== 'start') add('justify-content', flex[layout.justify])
    if (wrapping && layout.crossGap !== layout.gap) {
      // gap は「行の間隔 列の間隔」の順
      const [row, column] =
        layout.direction === 'horizontal' ? [layout.crossGap, layout.gap] : [layout.gap, layout.crossGap]
      add('gap', `${px(row)} ${px(column)}`)
    } else if (layout.gap !== 0) add('gap', px(layout.gap))
    const padding = paddingCss(layout, px)
    if (padding !== null) add('padding', padding)
  }

  // 中身で決まる大きさは書かない
  const hugWidth =
    node.type === 'frame' ? node.layout?.widthMode === 'hug' : node.type === 'text' && node.autoWidth
  const hugHeight = node.type === 'frame' ? node.layout?.heightMode === 'hug' : node.type === 'text'
  // 親いっぱいに伸ばす向きは、大きさの代わりに伸ばし方を書く
  const stretched = stretchedAxes(scene, node)
  if (parent?.type === 'frame' && parent.layout) {
    const mainStretched = parent.layout.direction === 'horizontal' ? stretched.width : stretched.height
    const crossStretched = parent.layout.direction === 'horizontal' ? stretched.height : stretched.width
    if (mainStretched) add('flex', '1 0 0')
    if (crossStretched) add('align-self', 'stretch')
  }
  if (!hugWidth && !stretched.width) add('width', px(node.width))
  if (!hugHeight && !stretched.height) add('height', px(node.height))
  // 大きさの下限・上限は、大きさを自動で決める向きでだけ書く
  const limited = sizeLimited(scene, node)
  for (const [property, value, axis] of [
    ['min-width', node.minWidth, 'width'],
    ['max-width', node.maxWidth, 'width'],
    ['min-height', node.minHeight, 'height'],
    ['max-height', node.maxHeight, 'height'],
  ] as const) {
    if (value !== null && limited[axis]) add(property, px(value))
  }
  if (node.rotation !== 0) add('transform', `rotate(${num(node.rotation)}deg)`)
  if (node.opacity < 1) add('opacity', num(node.opacity))

  if (node.type === 'text') {
    add('color', color(node.fill))
    add('font-family', node.fontFamily)
    add('font-size', px(node.fontSize))
    add('font-weight', String(node.fontWeight))
    add('line-height', num(node.lineHeight))
    if (node.textAlign !== 'left') add('text-align', node.textAlign)
    if (node.autoWidth) add('white-space', 'nowrap')
  } else if (node.type === 'image') {
    add('object-fit', node.fit === 'stretch' ? 'fill' : node.fit)
  } else if (node.type === 'line' || node.type === 'path') {
    // SVG の fill にはグラデーションを直接書けないので、始まりの色で代える
    if (node.type === 'path') add('fill', node.fill === null ? 'none' : color(node.fill))
    add('stroke', node.stroke === null ? 'none' : color(node.stroke))
    if (node.stroke !== null) add('stroke-width', px(node.strokeWidth))
  } else {
    if (node.fillGradient) add('background', gradientCss(node.fillGradient, style))
    else if (node.fill !== null) add('background', color(node.fill))
    if (node.stroke !== null && node.strokeWidth > 0) {
      // 線は枠の辺の上に、内と外へ半分ずつ引く（描画と同じ）。border だと box-sizing しだいで内か外に寄り、
      // 中身の置き場所も狭まるので、場所を取らない outline を、太さの半分だけ内側へずらして使う
      add('outline', `${px(node.strokeWidth)} solid ${color(node.stroke)}`)
      add('outline-offset', px(-node.strokeWidth / 2))
    }
  }

  if (node.type === 'ellipse') add('border-radius', '50%')
  else if ('cornerRadius' in node && node.cornerRadius > 0) add('border-radius', px(node.cornerRadius))
  if ('shadow' in node && node.shadow) {
    // パスの影は、枠ではなく形に沿って落ちる
    if (node.type === 'path') add('filter', `drop-shadow(${shadowCss(node.shadow, style)})`)
    else add('box-shadow', shadowCss(node.shadow, style))
  }
  if (node.type === 'frame' && node.clipContent && node.children.length > 0) add('overflow', 'hidden')

  return lines.join('\n')
}

/**
 * ドキュメントの角度は 0° が左から右、90° が上から下。CSS は 0deg が下から上、90deg が左から右なので、90° ずれる。
 * 色が変わる区間の長さは、描画（canvas/render.ts）も CSS も「枠の角がちょうど両端の色になる長さ」で同じ。
 */
function gradientCss(gradient: Gradient, style: CodeStyle): string {
  const stops = gradient.stops.map((stop) => `${formatColor(stop.color, style.color)} ${percent(stop.offset)}`)
  return `linear-gradient(${num((((gradient.angle + 90) % 360) + 360) % 360)}deg, ${stops.join(', ')})`
}

/** 自動で並べるフレームの子か */
function inFlexParent(scene: Scene, id: NodeId): boolean {
  const parentId = scene.nodes[id].parentId
  const parent = parentId === null ? null : scene.nodes[parentId]
  return parent?.type === 'frame' && parent.layout !== null
}

/** 余白の値。4 辺が同じなら 1 つ、上下と左右がそれぞれ同じなら「上下 左右」、そうでなければ上・右・下・左 */
function paddingValues(layout: AutoLayout): number[] {
  const { paddingTop: top, paddingRight: right, paddingBottom: bottom, paddingLeft: left } = layout
  if (top === bottom && left === right) return top === left ? [top] : [top, right]
  return [top, right, bottom, left]
}

function paddingText(layout: AutoLayout): string {
  return paddingValues(layout).map(num).join(' ')
}

/** バリアントの名前を、プロパティごとの行にしたもの。バリアントの形の名前でなければ空 */
function variantRows(name: string): InspectRow[] {
  return (parseVariantName(name) ?? []).map(([key, value]) => ({ label: key, value }))
}

/** バリアントの元 main のインスタンスに出す行（まとまりの名前と、プロパティの値） */
function variantInstanceRows(page: Scene, main: SceneNode): InspectRow[] {
  const set = variantSetOf(page, main.id)
  return set ? [{ label: 'コンポーネント', value: set.name }, ...variantRows(main.name)] : []
}

/** 大きさの下限・上限の行。決めていて、効く向きのものだけ */
function limitRows(scene: Scene, node: SceneNode): InspectRow[] {
  const limited = sizeLimited(scene, node)
  const rows: [string, number | null, 'width' | 'height'][] = [
    ['最小の幅', node.minWidth, 'width'],
    ['最大の幅', node.maxWidth, 'width'],
    ['最小の高さ', node.minHeight, 'height'],
    ['最大の高さ', node.maxHeight, 'height'],
  ]
  return rows.flatMap(([label, value, axis]) => (value !== null && limited[axis] ? [{ label, value: num(value) }] : []))
}

function paddingCss(layout: AutoLayout, px: (value: number) => string): string | null {
  const values = paddingValues(layout)
  return values.every((value) => value === 0) ? null : values.map(px).join(' ')
}

/** CSS の box-shadow の値 */
export function shadowCss(shadow: Shadow, style: CodeStyle = DEFAULT_CODE_STYLE): string {
  const color = formatColor(shadow.color, style.color, { alpha: shadow.opacity })
  return `${length(shadow.x, style)} ${length(shadow.y, style)} ${length(shadow.blur, style)} ${color}`
}

/** rem は、基準が 16px なら 1px = 0.0625rem なので、小数 4 桁まで出す */
function length(value: number, style: Pick<CodeStyle, 'unit' | 'remBase'>): string {
  if (value === 0) return '0'
  return style.unit === 'rem' ? `${Math.round((value / style.remBase) * 10000) / 10000}rem` : `${num(value)}px`
}

/**
 * いくつも選んでいるときの一覧: 全体を囲む矩形と、2 つなら、その間隔（1 つめから 2 つめまで）。
 * 間隔は、キャンバスに引く線と同じもの（measureBetween）。
 */
export function inspectSelection(scene: Scene, ids: readonly NodeId[]): InspectSection[] {
  const bounds = getNodesBounds(scene, ids)
  if (!bounds) return []
  const sections: InspectSection[] = [
    {
      title: '全体',
      rows: [
        { label: 'X', value: num(bounds.x) },
        { label: 'Y', value: num(bounds.y) },
        { label: '幅', value: num(bounds.width) },
        { label: '高さ', value: num(bounds.height) },
      ],
    },
  ]
  if (ids.length === 2) {
    const distances = measureBetween(getAbsoluteBounds(scene, ids[0]), getAbsoluteBounds(scene, ids[1]))
    const horizontal = distances.filter((distance) => distance.from.y === distance.to.y)
    const vertical = distances.filter((distance) => distance.from.y !== distance.to.y)
    // 重なっていれば、同じ向きに 2 本（左右の辺どうし、上下の辺どうし）出る
    const rows = (list: Distance[], label: string, sides: [string, string]) =>
      list.map((distance, index) => ({
        label: list.length === 2 ? `${label}（${sides[index]}）` : label,
        value: num(distance.distance),
      }))
    const all = [...rows(horizontal, '横', ['左', '右']), ...rows(vertical, '縦', ['上', '下'])]
    sections.push({ title: '間隔', rows: all.length > 0 ? all : [{ label: '横・縦', value: '0' }] })
  }
  return sections
}
