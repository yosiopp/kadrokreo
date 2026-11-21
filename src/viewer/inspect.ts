import {
  type InstanceNode,
  OVERRIDE_KEYS,
  derivedId,
  findMain,
  instanceOf,
  isMain,
} from '../document/component.ts'
import { getCorners, getNodesBounds, tidy } from '../document/geometry.ts'
import { type ColorFormat, formatColor } from './colors.ts'
import type { CodeFormat } from './codeFormat.ts'
import { type Distance, measureCorners } from './distances.ts'
import { followsConstraints, sizeLimited, stretchedAxes, wraps } from '../document/autoLayout.ts'
import { isVariantSet, parseVariantName, variantProperties, variantSetOf } from '../document/variants.ts'
import type { AutoLayout, DesignDocument, Effect, LinearGradient, NodeId, Override, Paint, Scene, SceneNode } from '../document/types.ts'
import { hasStroke, paintColor } from '../document/paint.ts'
import { isLine } from '../document/path.ts'
import { ALIGN_CONTENT_LABELS, CAP_LABELS, CONSTRAINT_LABELS, FIT_LABELS, OVERRIDE_LABELS, SIZING_LABELS, alignLabels } from '../ui/labels.ts'

// viewer で見せる、ノードの設定の一覧と CSS。どちらもドキュメントを読むだけで、変更はしない。

/** color を付けると、値の横に色見本を出す。nodes を付けると、それらのノードを選ぶボタンを出す */
export type InspectRow = { label: string; value: string; color?: string; nodes?: NodeId[] }
export type InspectSection = { title: string; rows: InspectRow[] }

const DIRECTIONS = { horizontal: '横', vertical: '縦' }
const JUSTIFY = { start: '先頭', center: '中央', end: '末尾', 'space-between': '均等' }
const TEXT_ALIGN = { left: '左', center: '中央', right: '右' }

/** CSS の長さの単位 */
export type Unit = 'px' | 'rem'

/** CSS の書き方。remBase は 1rem が何 px か。format はコードの出力形式（markup.ts の nodeCode / nodeMarkup が使う） */
export type CodeStyle = { unit: Unit; remBase: number; color: ColorFormat; format: CodeFormat }
export const DEFAULT_CODE_STYLE: CodeStyle = { unit: 'px', remBase: 16, color: 'hex', format: 'html' }

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
    ...constraintRows(scene, node),
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
      wraps(node) && { label: '折り返し', value: `する（行の間隔 ${num(layout.crossGap)}）` },
      wraps(node) && layout.alignContent !== 'auto' && { label: '行の配置', value: ALIGN_CONTENT_LABELS[layout.alignContent] },
      { label: '幅', value: SIZING_LABELS[node.sizing.width] },
      { label: '高さ', value: SIZING_LABELS[node.sizing.height] },
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
      {
        label: '折り返し',
        value:
          node.sizing.width !== 'hug' ? '幅に合わせる' : node.maxWidth !== null ? `最大の幅（${num(node.maxWidth)}）で` : 'しない',
      },
    ])
  }

  // 塗りが重なっていれば、上（手前）のものから並べる
  const paintRows = (paints: readonly Paint[]): InspectRow[] =>
    paints.toReversed().flatMap((paint) =>
      paint.type === 'solid'
        ? [{ label: '色', value: hex(paint.color), color: paint.color }]
        : [
            { label: 'グラデーション', value: `${num(paint.angle)}°` },
            ...paint.stops.map((stop) => ({ label: percent(stop.offset), value: hex(stop.color), color: stop.color })),
          ],
    )
  if ('fills' in node) add('塗り', paintRows(node.fills))

  if ('strokes' in node && hasStroke(node)) {
    add('線', [
      ...paintRows(node.strokes),
      { label: '太さ', value: num(node.strokeWidth) },
      'startCap' in node && node.startCap !== 'none' && { label: '始点', value: CAP_LABELS[node.startCap] },
      'endCap' in node && node.endCap !== 'none' && { label: '終点', value: CAP_LABELS[node.endCap] },
    ])
  }

  if ('effects' in node) {
    add(
      '影',
      node.effects.flatMap((shadow) => [
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
      ]),
    )
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
      // 入れ子のインスタンスを別のコンポーネントに差し替えていれば、差し替えた先
      !own && swappedRow(doc, overridesOn(scene, instance, main?.node.id).get(id)),
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

/** 入れ子のインスタンスの差し替え先の行。バリアントなら「まとまりの名前（バリアントの名前）」。差し替えていなければ null */
function swappedRow(doc: DesignDocument, override: Override | undefined): InspectRow | null {
  const swapped = override?.componentId === undefined ? null : findMain(doc, override.componentId)
  if (!swapped) return null
  const set = variantSetOf(swapped.page, swapped.node.id)
  return { label: '差し替えた元', value: set ? `${set.name}（${swapped.node.name}）` : swapped.node.name }
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
  // 親の辺への追従（constraints）で決めた大きさは、width / height の代わりに書く
  const sizedBy = { width: false, height: false }
  if (absolute && parent.type === 'frame') {
    add('position', 'absolute')
    for (const axis of ['horizontal', 'vertical'] as const) {
      const [startProp, endProp, sizeProp] = axis === 'horizontal' ? ['left', 'right', 'width'] as const : ['top', 'bottom', 'height'] as const
      const start = axis === 'horizontal' ? node.x : node.y
      const size = node[sizeProp]
      const whole = parent[sizeProp]
      switch (node.constraints[axis]) {
        case 'start':
          add(startProp, px(start))
          break
        case 'end':
          add(endProp, px(whole - start - size))
          break
        case 'stretch':
          add(startProp, px(start))
          add(endProp, px(whole - start - size))
          sizedBy[sizeProp] = true
          break
        case 'center': {
          // 親の中心からのずれ
          const offset = tidy(start - whole / 2)
          add(startProp, offset === 0 ? '50%' : `calc(50% ${offset < 0 ? '-' : '+'} ${px(Math.abs(offset))})`)
          break
        }
        case 'scale':
          add(startProp, percent(whole === 0 ? 0 : start / whole))
          if (whole !== 0) {
            add(sizeProp, percent(size / whole))
            sizedBy[sizeProp] = true
          }
          break
      }
    }
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
    const wrapping = wraps(node)
    add('display', 'flex')
    add('flex-direction', layout.direction === 'horizontal' ? 'row' : 'column')
    if (wrapping) add('flex-wrap', 'wrap')
    if (layout.align !== 'start') add('align-items', flex[layout.align])
    // 折り返すとき、行のまとまりも揃え方に従って置く（既定の stretch だと行の間に隙間ができる）
    if (wrapping) add('align-content', layout.alignContent === 'space-between' ? 'space-between' : flex[layout.align])
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
  const hugWidth = (node.type === 'frame' && node.layout !== null) || node.type === 'text' ? node.sizing.width === 'hug' : false
  const hugHeight = (node.type === 'frame' && node.layout !== null) || node.type === 'text' ? node.sizing.height === 'hug' : false
  // 親いっぱいに伸ばす向きは、大きさの代わりに伸ばし方を書く
  const stretched = stretchedAxes(scene, node)
  if (parent?.type === 'frame' && parent.layout) {
    const mainStretched = parent.layout.direction === 'horizontal' ? stretched.width : stretched.height
    const crossStretched = parent.layout.direction === 'horizontal' ? stretched.height : stretched.width
    if (mainStretched) add('flex', '1 0 0')
    if (crossStretched) add('align-self', 'stretch')
  }
  if (!hugWidth && !stretched.width && !sizedBy.width) add('width', px(node.width))
  if (!hugHeight && !stretched.height && !sizedBy.height) add('height', px(node.height))
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
    const top = node.fills.at(-1)
    if (top?.type === 'linear') {
      // 文字のグラデーションは、背景を文字の形で切り抜いて表す
      add('background', gradientCss(top, style))
      add('background-clip', 'text')
      add('color', 'transparent')
    } else if (top) add('color', color(top.color))
    add('font-family', node.fontFamily)
    add('font-size', px(node.fontSize))
    add('font-weight', String(node.fontWeight))
    add('line-height', num(node.lineHeight))
    if (node.textAlign !== 'left') add('text-align', node.textAlign)
    // 中身に合わせる幅は、上限があればそこで折り返す（max-width は上で書いている）
    if (node.sizing.width === 'hug') {
      if (node.maxWidth === null) add('white-space', 'nowrap')
      else add('width', 'max-content')
    }
  } else if (node.type === 'image') {
    add('object-fit', node.fit === 'stretch' ? 'fill' : node.fit)
  } else if (node.type === 'path') {
    // SVG の fill や stroke にはグラデーションを直接書けないので、いちばん上の塗りの始まりの色で代える
    const fill = node.fills.at(-1)
    const stroke = node.strokes.at(-1)
    if (!isLine(node)) add('fill', fill ? color(paintColor(fill)) : 'none')
    add('stroke', stroke ? color(paintColor(stroke)) : 'none')
    if (stroke) add('stroke-width', px(node.strokeWidth))
  } else {
    const background = backgroundCss(node.fills, style)
    if (background !== null) add('background', background)
    const stroke = node.strokes.at(-1)
    if (stroke && hasStroke(node)) {
      // 線は枠の辺の上に、内と外へ半分ずつ引く（描画と同じ）。border だと box-sizing しだいで内か外に寄り、
      // 中身の置き場所も狭まるので、場所を取らない outline を、太さの半分だけ内側へずらして使う。
      // outline は色を 1 つしか持てないので、いちばん上の線の色（グラデーションなら始まりの色）で代える
      add('outline', `${px(node.strokeWidth)} solid ${color(paintColor(stroke))}`)
      add('outline-offset', px(-node.strokeWidth / 2))
    }
  }

  if (node.type === 'ellipse') add('border-radius', '50%')
  else if ('cornerRadius' in node && node.cornerRadius > 0) add('border-radius', px(node.cornerRadius))
  if ('effects' in node && node.effects.length > 0) {
    // CSS は先に書いた影が手前。効果は先頭が奥なので、逆に並べる
    const shadows = node.effects.toReversed().map((shadow) => shadowCss(shadow, style))
    // パスの影は、枠ではなく形に沿って落ちる
    if (node.type === 'path') add('filter', shadows.map((shadow) => `drop-shadow(${shadow})`).join(' '))
    else add('box-shadow', shadows.join(', '))
  }
  if (node.type === 'frame' && node.clipContent && node.children.length > 0) add('overflow', 'hidden')

  return lines.join('\n')
}

/**
 * ドキュメントの角度は 0° が左から右、90° が上から下。CSS は 0deg が下から上、90deg が左から右なので、90° ずれる。
 * 色が変わる区間の長さは、描画（canvas/render.ts）も CSS も「枠の角がちょうど両端の色になる長さ」で同じ。
 */
function gradientCss(gradient: LinearGradient, style: CodeStyle): string {
  const stops = gradient.stops.map((stop) => `${formatColor(stop.color, style.color)} ${percent(stop.offset)}`)
  return `linear-gradient(${num((((gradient.angle + 90) % 360) + 360) % 360)}deg, ${stops.join(', ')})`
}

/**
 * 塗りを CSS の background で表す。塗りがなければ null。
 * CSS は先に書いたものが手前で、色だけの層は一番下にしか置けないので、重ねる単色は同じ色のグラデーションにする
 */
function backgroundCss(fills: readonly Paint[], style: CodeStyle): string | null {
  if (fills.length === 0) return null
  return fills
    .toReversed()
    .map((paint, i, all) => {
      if (paint.type === 'linear') return gradientCss(paint, style)
      const color = formatColor(paint.color, style.color)
      return i === all.length - 1 ? color : `linear-gradient(${color}, ${color})`
    })
    .join(', ')
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

/** 親の辺への追従の行。追従する子で、左・上（既定）でないときだけ */
function constraintRows(scene: Scene, node: SceneNode): InspectRow[] {
  const parent = node.parentId === null ? undefined : scene.nodes[node.parentId]
  const { horizontal, vertical } = node.constraints
  if (!followsConstraints(parent, node) || (horizontal === 'start' && vertical === 'start')) return []
  return [{ label: '親の辺に固定', value: `横 ${CONSTRAINT_LABELS.horizontal[horizontal]}・縦 ${CONSTRAINT_LABELS.vertical[vertical]}` }]
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
export function shadowCss(shadow: Effect, style: CodeStyle = DEFAULT_CODE_STYLE): string {
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
 * 間隔は、キャンバスに引く線と同じもの（measureCorners）。2 つが同じ向きに回っていれば、その向きの横・縦で測る。
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
    const { angle, distances, outlines } = measureCorners(getCorners(scene, ids[0]), getCorners(scene, ids[1]))
    const horizontal = distances.filter((distance) => distance.axis === 'x')
    const vertical = distances.filter((distance) => distance.axis === 'y')
    // 重なっていれば、同じ向きに 2 本（左右の辺どうし、上下の辺どうし）出る
    const rows = (list: Distance[], label: string, sides: [string, string]) =>
      list.map((distance, index) => ({
        label: list.length === 2 ? `${label}（${sides[index]}）` : label,
        value: num(distance.distance),
      }))
    const all = [...rows(horizontal, '横', ['左', '右']), ...rows(vertical, '縦', ['上', '下'])]
    // どの向きで測ったのかを書き添える
    const basis: InspectRow | null =
      angle !== 0
        ? { label: '測る向き', value: `辺に沿う（${num(angle)}°）` }
        : outlines.length > 0
          ? { label: '測る向き', value: '回した図形は囲む矩形で' }
          : null
    sections.push({
      title: '間隔',
      rows: [...(all.length > 0 ? all : [{ label: '横・縦', value: '0' }]), ...(basis ? [basis] : [])],
    })
  }
  return sections
}
