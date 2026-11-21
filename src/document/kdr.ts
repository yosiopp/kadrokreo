import type {
  Asset,
  AssetId,
  AutoLayout,
  ColorStop,
  ComponentLink,
  DesignDocument,
  Effect,
  NodeId,
  Override,
  Page,
  Paint,
  PathPoint,
  Scene,
  SceneNode,
  Sizing,
  Constraint,
} from './types.ts'

// kdr ファイルの実体は gzip 圧縮した 1 つの JSON:
//   { format: 'kadrokreo', version: 15, document: { name, pages: [{ id, name, children: [ノード, …] }], assets } }
// ノードは木のまま入れ子で持ち（フレームの children にノードそのものが入る）、親の id は書かない。
// 既定値（DEFAULTS）と同じ項目は書かず、読むときに補う。だから、既定値を持つ項目を足すだけなら
// 古いファイルもそのまま読める（version を上げなくてよい）。読み込みは今の version だけに対応する。
//   15: 形を組み直した（入れ子の木、既定値の省略、塗り・線・効果の配列、大きさの決め方 sizing、直線をパスに）。
//       14 までのファイルは読まない（依頼主の指示で、後方互換を捨てた）
export const KDR_FORMAT = 'kadrokreo'
export const KDR_VERSION = 15
/** 埋め込める画像の種類。SVG はスクリプトを含められるので受け付けない */
export const IMAGE_MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const KDR_EXTENSION = '.kdr'

/** 展開後サイズの上限。細工された圧縮ファイルでメモリを食い潰されないようにする */
export const KDR_MAX_BYTES = 256 * 1024 * 1024

export class KdrError extends Error {
  override name = 'KdrError'
}

export async function decodeKdr(
  file: Blob,
  { maxBytes = KDR_MAX_BYTES }: { maxBytes?: number } = {},
): Promise<DesignDocument> {
  const bytes = await gunzip(file, maxBytes)

  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new KdrError('kdr ファイルの中身が JSON として読めません')
  }
  return parseKdr(value)
}

async function gunzip(file: Blob, maxBytes: number): Promise<Uint8Array> {
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    let result
    try {
      result = await reader.read()
    } catch {
      throw new KdrError('kdr ファイルを展開できません（gzip 形式ではありません）')
    }
    if (result.done) break
    total += result.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new KdrError('kdr ファイルが大きすぎます')
    }
    chunks.push(result.value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** 展開済みの JSON を検証し、既知のフィールドだけを持つドキュメントに組み直す */
export function parseKdr(value: unknown): DesignDocument {
  const file = record(value, 'ファイル')
  if (file.format !== KDR_FORMAT) throw new KdrError('kdr ファイルではありません')
  if (typeof file.version !== 'number') throw new KdrError('version がありません')
  if (file.version > KDR_VERSION) {
    throw new KdrError('このファイルは新しいバージョンで作られているため開けません')
  }
  if (!Number.isInteger(file.version) || file.version < 1) {
    throw new KdrError(`未対応のバージョンです: ${file.version}`)
  }
  if (file.version < KDR_VERSION) {
    throw new KdrError(`このファイルは古いバージョン（v${file.version}）で作られているため開けません`)
  }

  const doc = record(file.document, 'document')
  const assets: Record<AssetId, Asset> = {}
  for (const [id, raw] of Object.entries(record(doc.assets, 'document.assets'))) {
    assets[nodeId(id, `assets.${id}`)] = parseAsset(raw, `assets.${id}`)
  }

  const pages = array(doc.pages, 'document.pages').map((raw, i) => parsePage(raw, `pages[${i}]`, assets))
  if (pages.length === 0) throw new KdrError('document.pages: ページがありません')
  if (new Set(pages.map((page) => page.id)).size !== pages.length) {
    throw new KdrError('document.pages: ページの id が重複しています')
  }

  return { name: string(doc.name, 'document.name'), pages, assets }
}

function parsePage(value: unknown, path: string, assets: Record<AssetId, Asset>): Page {
  const raw = record(value, path)
  const scene: Scene = { nodes: {}, rootIds: [] }
  scene.rootIds = parseChildren(raw.children, `${path}.children`, null, 1, scene, assets)
  return { id: nodeId(raw.id, `${path}.id`), name: string(raw.name, `${path}.name`), ...scene }
}

/** 入れ子のノードを読み、scene.nodes に平らに入れる。返すのは子の id の並び */
function parseChildren(
  value: unknown,
  path: string,
  parentId: NodeId | null,
  depth: number,
  scene: Scene,
  assets: Record<AssetId, Asset>,
): NodeId[] {
  if (value === undefined) return []
  const list = array(value, path)
  // 描画は再帰で辿るので、入れ子の深さに上限を設ける（MAX_DEPTH 段目のフレームが空の children を持つのはよい）
  if (depth > MAX_DEPTH && list.length > 0) throw new KdrError('フレームの入れ子が深すぎます')
  return list.map((rawNode, i) => {
    const at = `${path}[${i}]`
    const node = parseNode(rawNode, at, parentId, assets)
    if (Object.hasOwn(scene.nodes, node.id)) throw new KdrError(`${at}.id: id が重複しています: ${node.id}`)
    scene.nodes[node.id] = node
    if (node.type === 'frame') {
      const children = parseChildren(record(rawNode, at).children, `${at}.children`, node.id, depth + 1, scene, assets)
      scene.nodes[node.id] = { ...node, children }
    }
    return node.id
  })
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

function parseAsset(value: unknown, path: string): Asset {
  const raw = record(value, path)
  const mime = string(raw.mime, `${path}.mime`)
  if (!IMAGE_MIME_TYPES.includes(mime)) throw new KdrError(`${path}.mime: 未対応の画像形式です`)
  const data = string(raw.data, `${path}.data`)
  if (data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
    throw new KdrError(`${path}.data: base64 ではありません`)
  }
  return { mime, data }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
export const MAX_DEPTH = 100

const CAPS = ['none', 'arrow'] as const
const SIZINGS = ['fixed', 'hug', 'fill'] as const
const CONSTRAINTS = ['start', 'end', 'stretch', 'center', 'scale'] as const
const MAX_PATH_POINTS = 10_000
const MAX_PAINTS = 16

/**
 * 省略できる項目と、省略したときの値。書き出しはこれと同じ値の項目を書かず、読み込みはこれで補う。
 * 新しく作るノードの既定値（editor/nodes.ts）とは別で、「その見た目がない」値にしてある。
 * 種類によらず、同じ名前の項目は同じ既定値を持つ
 */
const DEFAULTS = {
  rotation: 0,
  visible: true,
  locked: false,
  opacity: 1,
  layoutPositioning: 'auto',
  minWidth: null,
  maxWidth: null,
  minHeight: null,
  maxHeight: null,
  fills: [],
  strokes: [],
  strokeWidth: 1,
  effects: [],
  cornerRadius: 0,
  closed: false,
  startCap: 'none',
  endCap: 'none',
  fontWeight: 400,
  textAlign: 'left',
  lineHeight: 1.2,
  fit: 'cover',
  clipContent: true,
  layout: null,
  component: null,
} as const

/** オートレイアウトの省略できる項目 */
const LAYOUT_DEFAULTS = {
  direction: 'horizontal',
  gap: 0,
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
  paddingLeft: 0,
  align: 'start',
  justify: 'start',
  wrap: false,
  crossGap: 0,
  alignContent: 'auto',
} as const

/** 書き出しで、ノードのうち書かない項目（入れ子や他の項目から決まるもの） */
const DERIVED_KEYS = new Set(['parentId', 'children', 'sizing', 'constraints'])

function parseNode(
  value: unknown,
  path: string,
  parentId: NodeId | null,
  assets: Record<AssetId, Asset>,
): SceneNode {
  const raw = record(value, path)
  const at = (key: string) => `${path}.${key}`
  /** 省略できる項目。省略されていれば DEFAULTS の値（配列は新しく作る） */
  const optional = <T>(key: keyof typeof DEFAULTS, parse: (value: unknown, path: string) => T): T => {
    if (raw[key] === undefined) {
      const fallback = DEFAULTS[key]
      return (Array.isArray(fallback) ? [] : fallback) as T
    }
    return parse(raw[key], at(key))
  }
  const type = oneOf(raw.type, ['rect', 'ellipse', 'path', 'text', 'image', 'frame'] as const, at('type'))
  const layout = type === 'frame' ? optional('layout', (v, p) => (v === null ? null : parseLayout(v, p))) : null

  const base = {
    id: nodeId(raw.id, at('id')),
    name: string(raw.name, at('name')),
    parentId,
    x: number(raw.x, at('x')),
    y: number(raw.y, at('y')),
    width: size(raw.width, at('width')),
    height: size(raw.height, at('height')),
    rotation: optional('rotation', number),
    visible: optional('visible', boolean),
    locked: optional('locked', boolean),
    opacity: optional('opacity', ratio),
    sizing: parseSizing(raw.sizing, at('sizing'), type, layout !== null),
    layoutPositioning: optional('layoutPositioning', (v, p) => oneOf(v, ['auto', 'absolute'] as const, p)),
    constraints: parseConstraints(raw.constraints, at('constraints')),
    minWidth: optional('minWidth', optionalSize),
    maxWidth: optional('maxWidth', optionalSize),
    minHeight: optional('minHeight', optionalSize),
    maxHeight: optional('maxHeight', optionalSize),
  }
  const style = () => ({
    fills: optional('fills', paints),
    strokes: optional('strokes', paints),
    strokeWidth: optional('strokeWidth', size),
    effects: optional('effects', effects),
  })
  const cornerRadius = () => optional('cornerRadius', size)

  switch (type) {
    case 'rect':
      return { ...base, ...style(), type, cornerRadius: cornerRadius() }
    case 'ellipse':
      return { ...base, ...style(), type }
    case 'path': {
      const points = array(raw.points, at('points')).map((point, i) => parsePoint(point, at(`points[${i}]`)))
      if (points.length < 2 || points.length > MAX_PATH_POINTS) {
        throw new KdrError(`${at('points')}: 頂点の数が不正です`)
      }
      return {
        ...base,
        ...style(),
        type,
        points,
        closed: optional('closed', boolean),
        startCap: optional('startCap', (v, p) => oneOf(v, CAPS, p)),
        endCap: optional('endCap', (v, p) => oneOf(v, CAPS, p)),
      }
    }
    case 'text':
      return {
        ...base,
        type,
        text: string(raw.text, at('text')),
        fontSize: size(raw.fontSize, at('fontSize')),
        fontFamily: string(raw.fontFamily, at('fontFamily')),
        fills: optional('fills', paints),
        fontWeight: optional('fontWeight', fontWeight),
        textAlign: optional('textAlign', (v, p) => oneOf(v, ['left', 'center', 'right'] as const, p)),
        lineHeight: optional('lineHeight', size),
      }
    case 'image': {
      const assetId = nodeId(raw.assetId, at('assetId'))
      if (!Object.hasOwn(assets, assetId)) throw new KdrError(`${at('assetId')}: 画像データがありません`)
      return {
        ...base,
        type,
        assetId,
        cornerRadius: cornerRadius(),
        fit: optional('fit', (v, p) => oneOf(v, ['stretch', 'cover', 'contain'] as const, p)),
      }
    }
    case 'frame':
      return {
        ...base,
        ...style(),
        type,
        // 子は parseChildren が入れる
        children: [],
        clipContent: optional('clipContent', boolean),
        cornerRadius: cornerRadius(),
        layout,
        component: optional('component', (v, p) => (v === null ? null : parseComponent(v, p, assets))),
      }
  }
}

/**
 * 向きごとの大きさの決め方。省略した向きは fixed。
 * hug はテキストの幅と自動で並べるフレームだけが持てる。テキストの高さは常に hug（中身で決まる）。
 * 自動で並べないフレームの hug は fixed として読む（並べるのをやめたあとに残った値）
 */
function parseSizing(value: unknown, path: string, type: SceneNode['type'], hasLayout: boolean): { width: Sizing; height: Sizing } {
  const raw = value === undefined ? {} : record(value, path)
  const axis = (key: 'width' | 'height'): Sizing => {
    const sizing = raw[key] === undefined ? 'fixed' : oneOf(raw[key], SIZINGS, `${path}.${key}`)
    if (sizing !== 'hug') return sizing
    if (type === 'frame') return hasLayout ? 'hug' : 'fixed'
    if (type === 'text' && key === 'width') return 'hug'
    throw new KdrError(`${path}.${key}: この種類のノードは中身に合わせられません`)
  }
  const width = axis('width')
  return { width, height: type === 'text' ? 'hug' : axis('height') }
}

/** 親の大きさが変わったときの追従のしかた。省略した向きは start（左・上に固定） */
function parseConstraints(value: unknown, path: string): { horizontal: Constraint; vertical: Constraint } {
  const raw = value === undefined ? {} : record(value, path)
  const axis = (key: 'horizontal' | 'vertical'): Constraint =>
    raw[key] === undefined ? 'start' : oneOf(raw[key], CONSTRAINTS, `${path}.${key}`)
  return { horizontal: axis('horizontal'), vertical: axis('vertical') }
}

/** パスの頂点。制御点 in / out（頂点からのずれ）は省略でき、なければ書かない（角の頂点） */
function parsePoint(value: unknown, path: string): PathPoint {
  const raw = record(value, path)
  const point: PathPoint = { x: number(raw.x, `${path}.x`), y: number(raw.y, `${path}.y`) }
  for (const key of ['in', 'out'] as const) {
    if (raw[key] === undefined) continue
    const control = record(raw[key], `${path}.${key}`)
    point[key] = { x: number(control.x, `${path}.${key}.x`), y: number(control.y, `${path}.${key}.y`) }
  }
  return point
}

function parseComponent(value: unknown, path: string, assets: Record<AssetId, Asset>): ComponentLink {
  const link = record(value, path)
  const id = nodeId(link.id, `${path}.id`)
  const role = oneOf(link.role, ['main', 'instance'] as const, `${path}.role`)
  if (role === 'main') return { id, role }
  const overrides = link.overrides === undefined ? {} : parseOverrides(link.overrides, `${path}.overrides`, assets)
  return { id, role, overrides }
}

/** インスタンスごとの上書き。どのノードに当たるかはここでは分からないので、値の形だけを確かめる */
function parseOverrides(value: unknown, path: string, assets: Record<AssetId, Asset>): Record<NodeId, Override> {
  const overrides: Record<NodeId, Override> = {}
  for (const [id, rawOverride] of Object.entries(record(value, path))) {
    const at = (key: string) => `${path}.${id}.${key}`
    const raw = record(rawOverride, `${path}.${id}`)
    const override: Override = {}
    if (Object.hasOwn(raw, 'text')) override.text = string(raw.text, at('text'))
    if (Object.hasOwn(raw, 'fills')) override.fills = paints(raw.fills, at('fills'))
    if (Object.hasOwn(raw, 'strokes')) override.strokes = paints(raw.strokes, at('strokes'))
    if (Object.hasOwn(raw, 'visible')) override.visible = boolean(raw.visible, at('visible'))
    if (Object.hasOwn(raw, 'fontSize')) override.fontSize = size(raw.fontSize, at('fontSize'))
    if (Object.hasOwn(raw, 'fontFamily')) override.fontFamily = string(raw.fontFamily, at('fontFamily'))
    if (Object.hasOwn(raw, 'fontWeight')) override.fontWeight = fontWeight(raw.fontWeight, at('fontWeight'))
    if (Object.hasOwn(raw, 'assetId')) {
      override.assetId = nodeId(raw.assetId, at('assetId'))
      // 画像を差し替える上書きも、ファイルの中の画像を指していなければならない
      if (!Object.hasOwn(assets, override.assetId)) throw new KdrError(`${at('assetId')}: 上書きの画像データがありません`)
    }
    // 差し替え先のコンポーネントは、なくても読める（インスタンスの元がないときと同じく、同期で無視される）
    if (Object.hasOwn(raw, 'componentId')) override.componentId = nodeId(raw.componentId, at('componentId'))
    overrides[nodeId(id, `${path}.${id}`)] = override
  }
  return overrides
}

function parseLayout(value: unknown, path: string): AutoLayout {
  const raw = record(value, path)
  const optional = <K extends keyof typeof LAYOUT_DEFAULTS, T>(key: K, parse: (value: unknown, path: string) => T) =>
    raw[key] === undefined ? LAYOUT_DEFAULTS[key] : parse(raw[key], `${path}.${key}`)
  return {
    direction: optional('direction', (v, p) => oneOf(v, ['horizontal', 'vertical'] as const, p)),
    gap: optional('gap', number),
    paddingTop: optional('paddingTop', size),
    paddingRight: optional('paddingRight', size),
    paddingBottom: optional('paddingBottom', size),
    paddingLeft: optional('paddingLeft', size),
    align: optional('align', (v, p) => oneOf(v, ['start', 'center', 'end'] as const, p)),
    justify: optional('justify', (v, p) => oneOf(v, ['start', 'center', 'end', 'space-between'] as const, p)),
    wrap: optional('wrap', boolean),
    crossGap: optional('crossGap', number),
    alignContent: optional('alignContent', (v, p) => oneOf(v, ['auto', 'space-between'] as const, p)),
  }
}

function paints(value: unknown, path: string): Paint[] {
  const list = array(value, path)
  if (list.length > MAX_PAINTS) throw new KdrError(`${path}: 塗りが多すぎます`)
  return list.map((item, i) => parsePaint(item, `${path}[${i}]`))
}

function parsePaint(value: unknown, path: string): Paint {
  const raw = record(value, path)
  const type = oneOf(raw.type, ['solid', 'linear'] as const, `${path}.type`)
  if (type === 'solid') return { type, color: color(raw.color, `${path}.color`) }
  const stops = array(raw.stops, `${path}.stops`).map((stop, i): ColorStop => {
    const rawStop = record(stop, `${path}.stops[${i}]`)
    return {
      offset: ratio(rawStop.offset, `${path}.stops[${i}].offset`),
      color: color(rawStop.color, `${path}.stops[${i}].color`),
    }
  })
  if (stops.length < 2 || stops.length > 16) throw new KdrError(`${path}.stops: 色の数が不正です`)
  if (stops.some((stop, i) => i > 0 && stop.offset < stops[i - 1].offset)) {
    throw new KdrError(`${path}.stops: offset が小さい順に並んでいません`)
  }
  return { type, angle: number(raw.angle, `${path}.angle`), stops }
}

function effects(value: unknown, path: string): Effect[] {
  const list = array(value, path)
  if (list.length > MAX_PAINTS) throw new KdrError(`${path}: 効果が多すぎます`)
  return list.map((item, i) => {
    const at = `${path}[${i}]`
    const raw = record(item, at)
    return {
      type: oneOf(raw.type, ['drop-shadow'] as const, `${at}.type`),
      x: number(raw.x, `${at}.x`),
      y: number(raw.y, `${at}.y`),
      blur: size(raw.blur, `${at}.blur`),
      color: color(raw.color, `${at}.color`),
      opacity: ratio(raw.opacity, `${at}.opacity`),
    }
  })
}

function fontWeight(value: unknown, path: string): number {
  const n = number(value, path)
  if (!Number.isInteger(n / 100) || n < 100 || n > 900) throw new KdrError(`${path}: 100〜900 の 100 刻みではありません`)
  return n
}

/**
 * kdr ファイルの中身（圧縮前の JSON にするもの）。ノードを入れ子の木にし、既定値と同じ項目を省く。
 * 画像は渡されたものをそのまま入れるので、使っていない画像を除くなら先に除いておく
 */
export function kdrFile(doc: DesignDocument): { format: string; version: number; document: unknown } {
  return {
    format: KDR_FORMAT,
    version: KDR_VERSION,
    document: {
      name: doc.name,
      pages: doc.pages.map((page) => ({ id: page.id, name: page.name, children: page.rootIds.map((id) => nodeFile(page, id)) })),
      assets: doc.assets,
    },
  }
}

function nodeFile(scene: Scene, id: NodeId): Record<string, unknown> {
  const node = scene.nodes[id]
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (DERIVED_KEYS.has(key)) continue
    if (Object.hasOwn(DEFAULTS, key) && sameValue(value, DEFAULTS[key as keyof typeof DEFAULTS])) continue
    out[key] = key === 'layout' && value !== null ? omitDefaults(value as AutoLayout, LAYOUT_DEFAULTS) : value
  }
  // 大きさの決め方は fixed でない向きだけ。テキストの高さは常に hug なので書かない
  const sizing: Partial<Record<'width' | 'height', Sizing>> = {}
  if (node.sizing.width !== 'fixed') sizing.width = node.sizing.width
  if (node.sizing.height !== 'fixed' && node.type !== 'text') sizing.height = node.sizing.height
  if (Object.keys(sizing).length > 0) out.sizing = sizing
  // 親への追従は start でない向きだけ
  const constraints: Partial<Record<'horizontal' | 'vertical', Constraint>> = {}
  if (node.constraints.horizontal !== 'start') constraints.horizontal = node.constraints.horizontal
  if (node.constraints.vertical !== 'start') constraints.vertical = node.constraints.vertical
  if (Object.keys(constraints).length > 0) out.constraints = constraints
  if (node.type === 'frame') {
    if (out.component && (out.component as ComponentLink).role === 'instance' && Object.keys((out.component as { overrides: object }).overrides).length === 0) {
      const { overrides: _overrides, ...link } = out.component as { overrides: object }
      out.component = link
    }
    if (node.children.length > 0) out.children = node.children.map((childId) => nodeFile(scene, childId))
  }
  return out
}

function omitDefaults<T extends object>(value: T, defaults: Partial<Record<keyof T, unknown>>): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([key, item]) => !(Object.hasOwn(defaults, key) && sameValue(item, defaults[key as keyof T]))),
  ) as Partial<T>
}

/** 既定値との比較。既定値は数値・文字列・真偽値・null・空の配列だけ */
function sameValue(value: unknown, fallback: unknown): boolean {
  if (Array.isArray(fallback)) return Array.isArray(value) && value.length === 0
  return value === fallback
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KdrError(`${path}: オブジェクトではありません`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new KdrError(`${path}: 文字列ではありません`)
  return value
}

function color(value: unknown, path: string): string {
  const text = string(value, path)
  if (!COLOR_PATTERN.test(text)) throw new KdrError(`${path}: #rrggbb 形式の色ではありません`)
  return text
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new KdrError(`${path}: 真偽値ではありません`)
  return value
}

function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new KdrError(`${path}: 数値ではありません`)
  }
  return value
}

function ratio(value: unknown, path: string): number {
  const n = number(value, path)
  if (n < 0 || n > 1) throw new KdrError(`${path}: 0〜1 の範囲ではありません`)
  return n
}

function oneOf<const T>(value: unknown, choices: readonly T[], path: string): T {
  const found = choices.find((choice) => choice === value)
  if (found === undefined) throw new KdrError(`${path}: 不正な値です`)
  return found
}

function size(value: unknown, path: string): number {
  const n = number(value, path)
  if (n < 0) throw new KdrError(`${path}: 負の値です`)
  return n
}

function optionalSize(value: unknown, path: string): number | null {
  return value === null ? null : size(value, path)
}

function nodeId(value: unknown, path: string): NodeId {
  const id = string(value, path)
  // __proto__ はオブジェクトのキーとして安全に扱えないので弾く
  if (!ID_PATTERN.test(id) || id === '__proto__') throw new KdrError(`${path}: 不正な id です`)
  return id
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new KdrError(`${path}: 配列ではありません`)
  return value
}
