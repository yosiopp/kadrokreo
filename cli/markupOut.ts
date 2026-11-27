// kdr のノードの木を、kdr build / kdr place が読むマークアップ（markup.ts）として書き出す（kdr markup）。
//
// - 属性は build と同じ語彙（set の「名前=値」）。build が書かなかったときに使う値（塗りなし・線なしなど）と同じ項目は書かない
// - id はすべて書く（作り直しても同じ id になり、インスタンスの of・上書きの node もその id で指せる）
// - インスタンスの中身（写し）は書かない。元の側の id で指す <override> と、根の塗り・線だけを書く
// - 表せないもの（埋め込んだ書体、差し替えの候補、--assets なしの画像など）は書かずに、呼ぶ側へ知らせる（drops）
import { type InstanceNode, type MainNode, derivedId, isInstance, isMain, owningInstance } from '../src/document/component.ts'
import { canBindProperty } from '../src/document/componentProperties.ts'
import { LAYOUT_DEFAULTS } from '../src/document/kdr.ts'
import { contoursData, mapVertices, pathContours } from '../src/document/path.ts'
import type { AutoLayout, CodeComponent, DesignDocument, FrameNode, NodeId, Page, Paint, PathNode, SceneNode } from '../src/document/types.ts'
import { formatVariantName, isVariantSet, parseVariantName, variantsIn } from '../src/document/variants.ts'
import { componentName, listComponents, sameJson } from '../src/editor/components.ts'
import { createEllipse, createFrame, createImage, createPath, createRect, createText } from '../src/editor/nodes.ts'
import { pathFromData } from './commands/create.ts'

/** 画像を書き出すときの、assetId からファイルの名前（src に書くパス）を決めるもの。null なら画像は書かない */
export type AssetNamer = ((assetId: string) => string) | null

export type MarkupOutput = { text: string; drops: string[] }

const AT = { x: 0, y: 0, width: 100, height: 100 }

/** build が要素を作るときの、属性を当てる前のノード（書かなかった項目はこの値になる） */
function baseline(node: SceneNode): SceneNode {
  switch (node.type) {
    case 'rect':
      return { ...createRect(AT), fills: [] }
    case 'ellipse':
      return { ...createEllipse(AT), fills: [] }
    case 'text':
      return createText(AT, '')
    case 'image':
      return createImage(AT, node.assetId)
    case 'path':
      return { ...createPath({ ...AT, points: node.points }, node.closed), fills: [], strokes: [] }
    case 'frame':
      return { ...createFrame(AT), fills: [] }
  }
}

/** 自分で書く項目（残りは baseline と比べて、違えば「名前=値」で書く） */
const HANDLED = new Set(['id', 'type', 'parentId', 'children', 'component', 'name', 'x', 'y', 'width', 'height', 'sizing', 'layout', 'text', 'assetId', 'points', 'contours', 'closed', 'setCode'])

/** インスタンスが自分で持つ項目（INSTANCE_OWN と同じ。width・height・名前・位置は別に書く） */
const INSTANCE_OWN = ['rotation', 'visible', 'locked', 'opacity', 'blendMode'] as const
/** インスタンスの根に書ける、元の値の上書き */
const INSTANCE_ROOT_OVERRIDES = new Set(['fills', 'strokes', 'strokeDashes', 'strokeDashOffset'])

/** 制御文字は文字参照にする（そのまま書くと、ほかの道具で読めない） */
function controls(value: string): string {
  let out = ''
  for (const c of value) {
    const code = c.charCodeAt(0)
    out += (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f ? `&#${code};` : c
  }
  return out
}

function escapeAttribute(value: string): string {
  return controls(value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;'))
}

function escapeText(value: string): string {
  return controls(value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
}

/** 塗り・線を、略記の値（#rrggbb・null）にする。略記で書けなければ null */
function paintShorthand(paints: readonly Paint[]): string | null {
  if (paints.length === 0) return 'null'
  const [paint] = paints
  if (paints.length === 1 && paint.type === 'solid' && paint.opacity === 1 && paint.visible && paint.blendMode === 'normal') return paint.color
  return null
}

/** 項目の値を属性の文字にする（set の parseValue で同じ値に戻るもの） */
function plainValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

type Attribute = [string, string]

/** 項目 key の値を属性にする（塗りと線は、書けるなら fill / stroke の略記。グラデーションなどは fills / strokes の JSON） */
function fieldAttribute(key: string, value: unknown): Attribute {
  if (key === 'fills' || key === 'strokes') {
    const shorthand = paintShorthand(value as Paint[])
    if (shorthand !== null) return [key === 'fills' ? 'fill' : 'stroke', shorthand]
  }
  return [key, plainValue(value)]
}

/** 項目 key を baseline から変えた分の属性。入れ子の項目（constraints など）は、変えた中の項目だけを「.」でつないで書く */
function changedAttributes(key: string, value: unknown, fallback: unknown): Attribute[] {
  if (sameJson(value, fallback)) return []
  const nested = (object: unknown) => object !== null && typeof object === 'object' && !Array.isArray(object)
  if (nested(value) && nested(fallback) && sameJson(Object.keys(value as object).sort(), Object.keys(fallback as object).sort())) {
    const from = fallback as Record<string, unknown>
    const out: Attribute[] = []
    for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
      if (sameJson(innerValue, from[inner])) continue
      // もう一段入れ子なら、項目ごとまとめて JSON で書く
      if (innerValue !== null && typeof innerValue === 'object') return [fieldAttribute(key, value)]
      out.push([`${key}.${inner}`, plainValue(innerValue)])
    }
    return out
  }
  return [fieldAttribute(key, value)]
}

/** 並べ方（layout）の属性。layout=row|column と、既定から変えた項目 */
function layoutAttributes(layout: AutoLayout): Attribute[] {
  const out: Attribute[] = [['layout', layout.direction === 'horizontal' ? 'row' : 'column']]
  const { paddingTop: top, paddingRight: right, paddingBottom: bottom, paddingLeft: left } = layout
  if (top !== 0 || right !== 0 || bottom !== 0 || left !== 0) {
    const padding = left === right ? (top === bottom ? (top === right ? [top] : [top, right]) : [top, right, bottom]) : [top, right, bottom, left]
    out.push(['padding', padding.join(' ')])
  }
  for (const key of ['gap', 'align', 'justify', 'wrap', 'crossGap', 'alignContent'] as const) {
    if (layout[key] !== LAYOUT_DEFAULTS[key]) out.push([key, String(layout[key])])
  }
  return out
}

/** テキストを要素の中身に書けるか（build は前後の空行と各行の字下げを除くので、それで変わらないもの） */
function asContent(text: string): boolean {
  if (text === '' || text.includes('\r')) return false
  const lines = text.split('\n')
  return lines.every((line) => line === line.trim()) && lines[0] !== '' && lines.at(-1) !== ''
}

type Context = {
  doc: DesignDocument
  page: Page
  assets: AssetNamer
  drops: string[]
  /** 元のノードの id から、そのノードを指す of の値（同じ id の元がほかのページにもあれば null） */
  componentRef: (componentId: string) => string | null
  /** コンポーネントの id から元 */
  mainOf: (componentId: string) => { page: Page; node: MainNode } | undefined
  /** フレームを <component-set> で書けるか（フレームごとに 1 回だけ求める） */
  writableSet: (frame: FrameNode) => boolean
  /** インスタンスの中の、名前ごとのレイヤーの数（インスタンスごとに 1 回だけ数える） */
  namesIn: (instanceId: NodeId) => Map<string, number>
}

/** パスの形の属性。d で元と同じ形に戻るなら d、戻らなければ頂点の JSON と大きさ */
function pathAttributes(node: PathNode): { attributes: Attribute[]; sized: boolean } {
  const moved = pathContours(node).map((contour) => ({
    vertices: mapVertices(contour.vertices, (point) => ({ x: point.x + node.x, y: point.y + node.y })),
    closed: contour.closed,
  }))
  const d = contoursData(moved)
  try {
    const back = pathFromData(d, node.closed, 'd')
    const same =
      sameJson(back.points, node.points) &&
      sameJson(back.contours, node.contours) &&
      back.closed === node.closed &&
      back.width === node.width &&
      back.height === node.height &&
      back.x === node.x &&
      back.y === node.y
    if (same) return { attributes: [['d', d], ...(node.closed ? [['closed', 'true'] as Attribute] : [])], sized: false }
  } catch {
    // 読めない d なら、頂点で書く
  }
  const attributes: Attribute[] = [['points', JSON.stringify(node.points)]]
  if (node.closed) attributes.push(['closed', 'true'])
  if (node.contours.length > 0) attributes.push(['contours', JSON.stringify(node.contours)])
  return { attributes, sized: true }
}

/** ノードを置く位置を書くか（自動で並べるフレームの子は、並べ直しが決める） */
function positioned(page: Page, node: SceneNode): boolean {
  const parent = node.parentId === null ? null : page.nodes[node.parentId]
  // 隠したノードは並びに入らないので、位置を書く
  return parent?.type !== 'frame' || parent.layout === null || node.layoutPositioning === 'absolute' || !node.visible
}

/**
 * 親いっぱいに伸ばす（fill）を、そのまま書けるか（build と同じ決まり: 親が自動で並べるフレームで、並べる向きなら親が中身に合わせていない）。
 * root（木の一部の根）は親が決まらないので書けない
 */
function fillWritable(page: Page, node: SceneNode, axis: 'width' | 'height', root: boolean): boolean {
  const parent = node.parentId === null ? null : page.nodes[node.parentId]
  if (root || parent?.type !== 'frame' || parent.layout === null) return false
  const along = (parent.layout.direction === 'horizontal') === (axis === 'width')
  return !(along && parent.sizing[axis] === 'hug')
}

/** 大きさ（width / height）の属性 */
function sizeAttributes(node: SceneNode, layoutFrame: boolean, must: boolean): Attribute[] {
  const out: Attribute[] = []
  for (const axis of ['width', 'height'] as const) {
    if (node.type === 'text' && axis === 'height') continue
    const sizing = node.sizing[axis]
    if (sizing === 'fill') out.push([axis, 'fill'])
    else if (sizing === 'fixed' && (must || layoutFrame || node.type === 'text')) out.push([axis, String(node[axis])])
    else if (sizing === 'hug' && !layoutFrame && node.type !== 'text') out.push([axis, String(node[axis])])
  }
  return out
}

/** 元のプロパティを、結んだノードの属性（prop / prop.visible）にする。表せないものは drops に */
function propertyBindings(ctx: Context, main: MainNode, bindings: Map<NodeId, Attribute[]>): void {
  const label = `元 ${main.name}（${main.id}）`
  for (const property of main.component.properties) {
    if (property.preferred.length > 0) ctx.drops.push(`${label} のプロパティ ${property.name} の差し替えの候補（build のあと prop-prefer で付ける）`)
    const targets = property.targets.filter((id) => canBindProperty(ctx.page, main.id, property.type, id, ctx.doc))
    if (targets.length === 0) ctx.drops.push(`${label} の、結んだノードのないプロパティ ${property.name}`)
    for (const target of targets) {
      if (owningInstance(ctx.page, target) !== null) {
        ctx.drops.push(`${label} のプロパティ ${property.name} の、入れ子のインスタンスの中身（${target}）への結び付け（build のあと prop-add で付ける）`)
        continue
      }
      const name = property.type === 'boolean' ? 'prop.visible' : 'prop'
      const list = bindings.get(target) ?? []
      if (list.some(([attribute]) => attribute === name)) {
        ctx.drops.push(`${label} のプロパティ ${property.name} の ${target} への結び付け（同じノードに同じ種類のプロパティが 2 つ）`)
        continue
      }
      list.push([name, property.name])
      bindings.set(target, list)
    }
  }
}

/** バリアントのまとまりを <component-set> で書けるか（直下の元が、どれも「プロパティ=値」の名前） */
function writableSet(page: Page, frame: FrameNode): boolean {
  if (!isVariantSet(page, frame.id)) return false
  const variants = variantsIn(page, frame.id)
  // 名前が決まった書き方（「a=b, c=d」）でなければ、variant から作り直すと名前が変わるので、ふつうのフレームと名前で書く
  if (variants.some((variant) => formatVariantName(parseVariantName(variant.name)!) !== variant.name)) return false
  const ids = new Set(variants.map((variant) => variant.id))
  return frame.children.every((id) => !isMain(page.nodes[id]) || ids.has(id))
}

/** root は、木の一部として書き出す根（親によって決まるもの: 親いっぱいに伸ばす大きさ・バリアントの名前は、そのままでは書かない） */
function element(ctx: Context, id: NodeId, depth: number, bindings: Map<NodeId, Attribute[]>, root = false): string[] {
  const { page } = ctx
  const node = page.nodes[id]
  const indent = '  '.repeat(depth)
  if (node.type === 'image' && ctx.assets === null) {
    ctx.drops.push(`画像 ${node.name}（${node.id}）（--assets でフォルダを指定すると書き出せる）`)
    return []
  }
  const attributes: Attribute[] = [['id', node.id]]
  let tag: string
  const children: string[] = []

  if (isInstance(node)) {
    tag = 'instance'
    attributes.push(...instanceAttributes(ctx, node, children, depth + 1, root), ...(bindings.get(node.id) ?? []))
  } else {
    const base = baseline(node)
    const set = node.type === 'frame' && ctx.writableSet(node)
    const parent = node.parentId === null ? null : page.nodes[node.parentId]
    const variant = !root && isMain(node) && parent?.type === 'frame' && ctx.writableSet(parent) && parseVariantName(node.name) !== null
    tag = node.type === 'frame' ? (set ? 'component-set' : isMain(node) ? 'component' : 'frame') : node.type
    if (variant) attributes.push(['variant', node.name])
    else if (node.name !== base.name) attributes.push(['name', node.name])
    if (node.type === 'image') attributes.push(['src', ctx.assets!(node.assetId)])
    let pathSized = false
    if (node.type === 'path') {
      const path = pathAttributes(node)
      attributes.push(...path.attributes)
      pathSized = path.sized
    }
    if (isMain(node) && node.component.description !== '') attributes.push(['description', node.component.description])
    if (set && node.type === 'frame' && node.setDescription !== '') attributes.push(['description', node.setDescription])
    // 実装側の部品（元は component.code、まとまりは setCode）
    const code = set && node.type === 'frame' ? node.setCode : isMain(node) ? node.component.code : null
    if (code) {
      attributes.push(['code', code.name])
      if (code.from !== '') attributes.push(['code-from', code.from])
      if (code.defaultExport) attributes.push(['code-default', 'true'])
      children.push(...codePropLines(code, `${indent}  `))
    }
    if (node.type === 'frame' && node.setCode && !set) {
      ctx.drops.push(
        isVariantSet(page, node.id)
          ? `${node.name}（${node.id}）の実装側の部品（バリアントの名前が決まった書き方でないまとまりは <frame> で書くので、build で戻らない）`
          : `${node.name}（${node.id}）の実装側の部品（バリアントのまとまりでないフレームのもので、使われない）`,
      )
    }
    if (positioned(page, node)) {
      if (node.x !== 0) attributes.push(['x', String(node.x)])
      if (node.y !== 0) attributes.push(['y', String(node.y)])
    }
    const layoutFrame = node.type === 'frame' && node.layout !== null
    if (node.type === 'frame' && node.layout) attributes.push(...layoutAttributes(node.layout))
    const fixedAxes = (['width', 'height'] as const).filter((axis) => node.sizing[axis] === 'fill' && !fillWritable(page, node, axis, root))
    const sized = fixedAxes.length === 0 ? node : ({ ...node, sizing: { ...node.sizing, ...Object.fromEntries(fixedAxes.map((axis) => [axis, 'fixed'])) } } as SceneNode)
    if (sized !== node) {
      ctx.drops.push(`${node.name}（${node.id}）の親いっぱいに伸ばす大きさ（${root ? '木の一部の根なので' : '親が自動で並べるフレームでないので'}、今の大きさの数値にした）`)
    }
    attributes.push(...sizeAttributes(sized, layoutFrame, node.type !== 'path' || pathSized))
    const current = node as unknown as Record<string, unknown>
    const fallback = base as unknown as Record<string, unknown>
    for (const key of Object.keys(current)) {
      if (HANDLED.has(key) || (set && key === 'setDescription')) continue
      attributes.push(...changedAttributes(key, current[key], fallback[key]))
    }
    attributes.push(...(bindings.get(node.id) ?? []))
    if (node.type === 'text') {
      if (asContent(node.text)) children.push(`${indent}  ${escapeText(node.text).split('\n').join(`\n${indent}  `)}`)
      else attributes.push(['text', node.text])
    }
    if (isMain(node)) propertyBindings(ctx, node, bindings)
    if (node.type === 'frame') for (const child of node.children) children.push(...element(ctx, child, depth + 1, bindings))
  }

  const open = `${indent}<${tag}${attributes.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('')}`
  if (children.length === 0) return [`${open}/>`]
  // テキストの中身は 1 行なら同じ行に
  if (node.type === 'text' && children.length === 1 && !children[0].includes('\n')) return [`${open}>${children[0].trim()}</${tag}>`]
  return [`${open}>`, ...children, `${indent}</${tag}>`]
}

/** 実装側の部品の props の読み替え（<code-prop> と <code-value>） */
function codePropLines(code: CodeComponent, indent: string): string[] {
  return code.props.flatMap(({ property, prop, values }) => {
    const open = `${indent}<code-prop property="${escapeAttribute(property)}" prop="${escapeAttribute(prop)}"`
    const entries = Object.entries(values)
    if (entries.length === 0) return [`${open}/>`]
    return [
      `${open}>`,
      ...entries.map(([of, to]) => `${indent}  <code-value of="${escapeAttribute(of)}" to="${escapeAttribute(to)}"/>`),
      `${indent}</code-prop>`,
    ]
  })
}

function instanceAttributes(ctx: Context, node: InstanceNode, children: string[], depth: number, root: boolean): Attribute[] {
  const { page } = ctx
  const label = `インスタンス ${node.name}（${node.id}）`
  const main = ctx.mainOf(node.component.id)
  const out: Attribute[] = []
  const ref = ctx.componentRef(node.component.id)
  if (!main || ref === null) {
    ctx.drops.push(`${label} の元の指し方（${main ? '同じ id の元がほかのページにもある' : '元が見つからない'}）`)
    out.push(['of', main?.node.id ?? node.component.id])
  } else out.push(['of', ref])
  if (main && node.name !== componentName(main)) out.push(['name', node.name])
  if (positioned(page, node)) {
    if (node.x !== 0) out.push(['x', String(node.x)])
    if (node.y !== 0) out.push(['y', String(node.y)])
  }
  for (const key of INSTANCE_OWN) {
    const value = node[key]
    const fallback = createFrame(AT)[key]
    if (value !== fallback) out.push([key, String(value)])
  }
  for (const axis of ['width', 'height'] as const) {
    if (node.sizing[axis] !== 'fill') continue
    if (fillWritable(page, node, axis, root)) out.push([axis, 'fill'])
    else ctx.drops.push(`${label} の親いっぱいに伸ばす大きさ（${root ? '木の一部の根なので' : '親が自動で並べるフレームでないので'}、元の大きさになる）`)
  }
  if (node.component.flipX || node.component.flipY) ctx.drops.push(`${label} の裏返し（build のあと flip で付ける）`)
  const indent = '  '.repeat(depth)
  for (const [key, override] of Object.entries(node.component.overrides)) {
    const entries = Object.entries(override) as [string, unknown][]
    if (main && key === main.node.id) {
      for (const [field, value] of entries) {
        if (INSTANCE_ROOT_OVERRIDES.has(field)) out.push(fieldAttribute(field, value))
        else ctx.drops.push(`${label} の根の上書き ${field}`)
      }
      continue
    }
    if (!subtreeHas(page, node.id, key)) {
      ctx.drops.push(`${label} の、中身にないレイヤーへの上書き（${key}）`)
      continue
    }
    // 書き出さない画像（--assets なし）への上書きは、build でレイヤーが見つからない
    if (ctx.assets === null && page.nodes[derivedId(node.id, key)].type === 'image') {
      ctx.drops.push(`${label} の、書き出さない画像（${key}）への上書き`)
      continue
    }
    // 差し替えるレイヤーは、差し替えた後の名前では build で見つからないので、元の側の id で指す
    const attributes: Attribute[] = [['node', override.componentId === undefined ? overrideSelector(ctx, node.id, key) : key]]
    for (const [field, value] of entries) {
      if (field === 'componentId') {
        const swapped = ctx.componentRef(value as string)
        if (swapped === null) ctx.drops.push(`${label} の入れ子の差し替え（${key}）`)
        else attributes.push(['of', swapped])
      } else if (field === 'assetId') {
        if (ctx.assets === null) ctx.drops.push(`${label} の画像の差し替え（${key}）（--assets でフォルダを指定すると書き出せる）`)
        else attributes.push(['src', ctx.assets(value as string)])
      } else attributes.push(fieldAttribute(field, value))
    }
    if (attributes.length > 1) children.push(`${indent}<override${attributes.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('')}/>`)
  }
  return out
}

/** <override node="…"> の値。写しの名前がインスタンスの中で 1 つだけならその名前、でなければ元の側の id */
function overrideSelector(ctx: Context, instanceId: NodeId, key: string): string {
  const { page } = ctx
  const name = page.nodes[derivedId(instanceId, key)].name
  if (name === '' || name.includes('/')) return key
  // 名前が、ほかのレイヤーの元の側の id と同じだと、id として読まれる
  return ctx.namesIn(instanceId).get(name) === 1 && !Object.hasOwn(page.nodes, derivedId(instanceId, name)) ? name : key
}

/** インスタンス instanceId の中身に、元の側の id key に当たる写しがあるか */
function subtreeHas(page: Page, instanceId: NodeId, key: string): boolean {
  return Object.hasOwn(page.nodes, derivedId(instanceId, key))
}

function context(doc: DesignDocument, page: Page, assets: AssetNamer, drops: string[]): Context {
  const mains = listComponents(doc)
  const counts = new Map<string, number>()
  for (const { node } of mains) counts.set(node.id, (counts.get(node.id) ?? 0) + 1)
  const byComponent = new Map(mains.map(({ node }) => [node.component.id, node]))
  const sets = new Map<NodeId, boolean>()
  const names = new Map<NodeId, Map<string, number>>()
  const byComponentFull = new Map(mains.map((main) => [main.node.component.id, main]))
  return {
    doc,
    page,
    assets,
    drops,
    mainOf: (componentId) => byComponentFull.get(componentId),
    writableSet: (frame) => sets.get(frame.id) ?? sets.set(frame.id, writableSet(page, frame)).get(frame.id)!,
    namesIn: (instanceId) => {
      let counts = names.get(instanceId)
      if (!counts) {
        counts = new Map()
        const visit = (id: NodeId) => {
          const node = page.nodes[id]
          if (id !== instanceId) counts!.set(node.name, (counts!.get(node.name) ?? 0) + 1)
          if (node.type === 'frame') node.children.forEach(visit)
        }
        visit(instanceId)
        names.set(instanceId, counts)
      }
      return counts
    },
    componentRef: (componentId) => {
      const main = byComponent.get(componentId)
      if (!main) return null
      if (counts.get(main.id) === 1) return main.id
      // 同じ id の元がほかのページにもあれば、名前が 1 つだけで、どの元の id とも違うなら名前で指す
      const name = componentName(byComponentFull.get(componentId)!)
      const sameName = mains.filter((other) => componentName(other) === name)
      return sameName.length === 1 && !counts.has(name) ? name : null
    },
  }
}

/** ドキュメント全体を <kdr> のマークアップにする */
export function documentMarkup(doc: DesignDocument, assets: AssetNamer): MarkupOutput {
  const drops: string[] = []
  if (doc.fonts.length > 0) drops.push(`埋め込んだ書体 ${doc.fonts.length} 個（build のあと font-add で足す）`)
  const lines = [`<kdr name="${escapeAttribute(doc.name)}">`]
  for (const page of doc.pages) {
    const ctx = context(doc, page, assets, drops)
    // ガイド線は editor の補助なので、マークアップには書かない
    if (page.guides.length > 0) drops.push(`ページ ${page.name} のガイド線 ${page.guides.length} 本`)
    const bindings = new Map<NodeId, Attribute[]>()
    // プロパティは、結ぶノードより先に元を読んでおく（元の中のノードは元より後に書くので、元を書くときに集めれば間に合う）
    const body = page.rootIds.flatMap((id) => element(ctx, id, 2, bindings))
    lines.push(`  <page id="${escapeAttribute(page.id)}" name="${escapeAttribute(page.name)}"${body.length === 0 ? '/>' : '>'}`)
    if (body.length > 0) lines.push(...body, '  </page>')
  }
  lines.push('</kdr>')
  return { text: lines.join('\n') + '\n', drops }
}

/** ノード 1 つ（と子孫）を、kdr place で置ける木の一部のマークアップにする */
export function nodeMarkup(doc: DesignDocument, page: Page, id: NodeId, assets: AssetNamer): MarkupOutput {
  const drops: string[] = []
  const ctx = context(doc, page, assets, drops)
  if (owningInstance(page, id) !== null) throw new Error(`${id} はインスタンスの中身です（インスタンスか、元の側のノードを指定してください）`)
  // 根より外の元のプロパティは、木の一部には書けない（place の入れる先で決まる）
  const bindings = new Map<NodeId, Attribute[]>()
  const lines = element(ctx, id, 0, bindings, true)
  if (lines.length === 0) return { text: '', drops }
  return { text: lines.join('\n') + '\n', drops }
}
