import type { DesignDocument, Gradient, NodeId, Scene, SceneNode, Shadow } from '../document/types.ts'

// viewer で見せる、ノードの設定の一覧と CSS。どちらもドキュメントを読むだけで、変更はしない。

/** color を付けると、値の横に色見本を出す */
export type InspectRow = { label: string; value: string; color?: string }
export type InspectSection = { title: string; rows: InspectRow[] }

export const TYPE_LABELS: Record<SceneNode['type'], string> = {
  frame: 'フレーム',
  rect: '長方形',
  ellipse: '楕円',
  line: '直線',
  path: 'パス',
  text: 'テキスト',
  image: '画像',
}

const DIRECTIONS = { horizontal: '横', vertical: '縦' }
const JUSTIFY = { start: '先頭', center: '中央', end: '末尾', 'space-between': '均等' }
const MODES = { hug: '中身に合わせる', fixed: '固定' }
const TEXT_ALIGN = { left: '左', center: '中央', right: '右' }
const FIT = { cover: '枠を埋めて切り抜く', contain: '全体を収める', stretch: '引き伸ばす' }
const CAPS = { none: 'なし', arrow: '矢印' }

/** 小数 2 桁まで。計算で出る細かい端数は見せない */
function num(value: number): string {
  return String(Math.round(value * 100) / 100)
}

function percent(ratio: number): string {
  return `${num(ratio * 100)}%`
}

function hex(color: string): string {
  return color.toUpperCase()
}

/** ノードの設定を、見出しごとにまとめる。その種類のノードにない項目や、既定のままで意味のない項目は出さない */
export function inspectNode(doc: DesignDocument, scene: Scene, id: NodeId): InspectSection[] {
  const node = scene.nodes[id]
  const sections: InspectSection[] = []
  const add = (title: string, rows: (InspectRow | false | null)[]) => {
    const shown = rows.filter((row) => row !== false && row !== null)
    if (shown.length > 0) sections.push({ title, rows: shown })
  }

  add('位置とサイズ', [
    { label: 'X', value: num(node.x) },
    { label: 'Y', value: num(node.y) },
    { label: '幅', value: num(node.width) },
    { label: '高さ', value: num(node.height) },
    node.rotation !== 0 && { label: '回転', value: `${num(node.rotation)}°` },
    'cornerRadius' in node && node.cornerRadius > 0 && { label: '角丸', value: num(node.cornerRadius) },
    node.opacity < 1 && { label: '不透明度', value: percent(node.opacity) },
  ])

  if (node.type === 'frame' && node.layout) {
    const { layout } = node
    const vertical = layout.direction === 'vertical'
    const align = { start: vertical ? '左' : '上', center: '中央', end: vertical ? '右' : '下' }
    add('オートレイアウト', [
      { label: '向き', value: DIRECTIONS[layout.direction] },
      { label: '間隔', value: num(layout.gap) },
      { label: '余白（左右）', value: num(layout.paddingX) },
      { label: '余白（上下）', value: num(layout.paddingY) },
      { label: '揃え', value: align[layout.align] },
      { label: '寄せ', value: JUSTIFY[layout.justify] },
      { label: '幅', value: MODES[layout.widthMode] },
      { label: '高さ', value: MODES[layout.heightMode] },
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
      'startCap' in node && node.startCap !== 'none' && { label: '始点', value: CAPS[node.startCap] },
      'endCap' in node && node.endCap !== 'none' && { label: '終点', value: CAPS[node.endCap] },
    ])
  }

  if ('shadow' in node && node.shadow) {
    const { shadow } = node
    add('影', [
      { label: '横', value: num(shadow.x) },
      { label: '縦', value: num(shadow.y) },
      { label: 'ぼかし', value: num(shadow.blur) },
      { label: '色', value: `${hex(shadow.color)} ${percent(shadow.opacity)}`, color: shadow.color },
    ])
  }

  if (node.type === 'image') {
    const asset = doc.assets[node.assetId]
    add('画像', [
      { label: '収め方', value: FIT[node.fit] },
      asset !== undefined && { label: '形式', value: asset.mime.replace('image/', '').toUpperCase() },
    ])
  }

  if (node.type === 'frame' && node.component) {
    const link = node.component
    const main = link.role === 'instance' ? findMainName(doc, link.id) : null
    add('コンポーネント', [
      { label: '種類', value: link.role === 'main' ? '元' : 'インスタンス' },
      main !== null && { label: '元の名前', value: main },
    ])
  }

  return sections
}

function findMainName(doc: DesignDocument, componentId: string): string | null {
  for (const page of doc.pages) {
    for (const node of Object.values(page.nodes)) {
      if (node.type === 'frame' && node.component?.role === 'main' && node.component.id === componentId) {
        return node.name
      }
    }
  }
  return null
}

/**
 * ノードの見た目を CSS で表す。実装するときの手がかりにするためのもので、
 * 直線とパスは CSS で形を描けないので、SVG に指定するプロパティ（stroke など）で表す。
 */
export function nodeCss(scene: Scene, id: NodeId): string {
  const node = scene.nodes[id]
  const parent = node.parentId === null ? null : scene.nodes[node.parentId]
  const lines: string[] = []
  const add = (property: string, value: string) => lines.push(`${property}: ${value};`)
  const px = (value: number) => (value === 0 ? '0' : `${num(value)}px`)

  // 自動で並べるフレームの子は、親が位置を決める。ページ直下のものは、置き場所を決めない
  const absolute = parent?.type === 'frame' && !parent.layout
  if (absolute) {
    add('position', 'absolute')
    add('left', px(node.x))
    add('top', px(node.y))
  } else if (node.type === 'frame' && !node.layout && node.children.length > 0) {
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
    add('display', 'flex')
    add('flex-direction', layout.direction === 'horizontal' ? 'row' : 'column')
    if (layout.align !== 'start') add('align-items', flex[layout.align])
    if (layout.justify !== 'start') add('justify-content', flex[layout.justify])
    if (layout.gap !== 0) add('gap', px(layout.gap))
    if (layout.paddingX !== 0 || layout.paddingY !== 0) {
      add('padding', `${px(layout.paddingY)} ${px(layout.paddingX)}`)
    }
  }

  // 中身で決まる大きさは書かない
  const hugWidth =
    node.type === 'frame' ? node.layout?.widthMode === 'hug' : node.type === 'text' && node.autoWidth
  const hugHeight = node.type === 'frame' ? node.layout?.heightMode === 'hug' : node.type === 'text'
  if (!hugWidth) add('width', px(node.width))
  if (!hugHeight) add('height', px(node.height))
  if (node.rotation !== 0) add('transform', `rotate(${num(node.rotation)}deg)`)
  if (node.opacity < 1) add('opacity', num(node.opacity))

  if (node.type === 'text') {
    add('color', node.fill)
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
    if (node.type === 'path') add('fill', node.fill ?? 'none')
    add('stroke', node.stroke ?? 'none')
    if (node.stroke !== null) add('stroke-width', px(node.strokeWidth))
  } else {
    if (node.fillGradient) add('background', gradientCss(node.fillGradient))
    else if (node.fill !== null) add('background', node.fill)
    if (node.stroke !== null && node.strokeWidth > 0) {
      add('border', `${px(node.strokeWidth)} solid ${node.stroke}`)
    }
  }

  if (node.type === 'ellipse') add('border-radius', '50%')
  else if ('cornerRadius' in node && node.cornerRadius > 0) add('border-radius', px(node.cornerRadius))
  if ('shadow' in node && node.shadow) {
    // パスの影は、枠ではなく形に沿って落ちる
    if (node.type === 'path') add('filter', `drop-shadow(${shadowCss(node.shadow)})`)
    else add('box-shadow', shadowCss(node.shadow))
  }
  if (node.type === 'frame' && node.clipContent && node.children.length > 0) add('overflow', 'hidden')

  return lines.join('\n')
}

/**
 * ドキュメントの角度は 0° が左から右、90° が上から下。CSS は 0deg が下から上、90deg が左から右なので、90° ずれる。
 * 色が変わる区間の長さは、描画（canvas/render.ts）も CSS も「枠の角がちょうど両端の色になる長さ」で同じ。
 */
function gradientCss(gradient: Gradient): string {
  const stops = gradient.stops.map((stop) => `${stop.color} ${percent(stop.offset)}`)
  return `linear-gradient(${num((((gradient.angle + 90) % 360) + 360) % 360)}deg, ${stops.join(', ')})`
}

function shadowCss(shadow: Shadow): string {
  const channel = (start: number) => parseInt(shadow.color.slice(start, start + 2), 16)
  const color = `rgba(${channel(1)}, ${channel(3)}, ${channel(5)}, ${num(shadow.opacity)})`
  const length = (value: number) => (value === 0 ? '0' : `${num(value)}px`)
  return `${length(shadow.x)} ${length(shadow.y)} ${length(shadow.blur)} ${color}`
}
