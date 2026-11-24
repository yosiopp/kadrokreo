import type {
  Asset,
  AssetId,
  AutoLayout,
  BlendMode,
  ColorStop,
  ComponentLink,
  ComponentProperty,
  DesignDocument,
  Effect,
  EmbeddedFont,
  NodeId,
  Override,
  Page,
  CornerRadius,
  Paint,
  PathContour,
  PathPoint,
  Scene,
  SceneNode,
  Sizing,
  Constraint,
  TextPath,
} from './types.ts'
import { IMAGE_TOO_LARGE_MESSAGE, isImageTooLarge, readImageInfo } from './imageInfo.ts'
import { EMBEDDED_FAMILY_FORBIDDEN, FONT_EXTENSIONS, FONT_MIME_TYPES, MAX_EMBEDDED_FAMILY_LENGTH, fontMime } from './fontFile.ts'
import { TarError, readTar, type TarEntry } from './tar.ts'

// kdr ファイルの実体は、次のファイルを tar にまとめて gzip で圧縮した 1 つのファイル（中身は `tar xzf` で取り出せる）:
//   document.json              { format: 'kadrokreo', version: 16, document: { name, pages: [{ id, name, children: [ノード, …] }], fonts?: [書体, …] } }
//   assets/<id>.<png|jpg|webp|gif>   画像の元のファイルそのまま。id は中身の SHA-256（16 進 64 文字）
//   assets/<id>.<ttf|otf|woff|woff2> 埋め込んだ書体の元のファイルそのまま（document.fonts の assetId が指す）
// ノードは木のまま入れ子で持ち（フレームの children にノードそのものが入る）、親の id は書かない。
// 既定値（DEFAULTS）と同じ項目は書かず、読むときに補う。だから、既定値を持つ項目を足すだけなら
// 古いファイルもそのまま読める（version を上げなくてよい）。読み込みは今の version だけに対応する。
//   15: 形を組み直した（入れ子の木、既定値の省略、塗り・線・効果の配列、大きさの決め方 sizing、直線をパスに）。
//       14 までのファイルは読まない（後方互換は持たない）
//   16: gzip した 1 つの JSON（画像は base64 で document.assets に入れていた）から、tar.gz に画像のファイルを切り出した形へ。
//       15 までのファイルは読まない
export const KDR_FORMAT = 'kadrokreo'
export const KDR_VERSION = 16
/** 埋め込める画像の種類。SVG はスクリプトを含められるので受け付けない */
export const IMAGE_MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const KDR_EXTENSION = '.kdr'
/** kdr の中のドキュメントのファイル名 */
export const KDR_DOCUMENT_NAME = 'document.json'

/** 画像の種類と、kdr の中のファイルの拡張子 */
const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
/** 埋め込みファイル（画像と書体）の種類と拡張子 */
const ASSET_EXTENSIONS: Record<string, string> = { ...IMAGE_EXTENSIONS, ...FONT_EXTENSIONS }
const ASSET_NAME_PATTERN = /^assets\/([A-Za-z0-9_-]{1,64})\.(png|jpg|webp|gif|ttf|otf|woff|woff2)$/

// 細工された圧縮ファイルでメモリを食い潰されないよう、展開した大きさに上限を設ける
/** 展開した tar 全体の上限 */
export const KDR_MAX_BYTES = 256 * 1024 * 1024
/** document.json の上限 */
export const KDR_MAX_JSON_BYTES = 64 * 1024 * 1024
/** 画像 1 枚の上限（取り込める画像の大きさもこれに揃える） */
export const KDR_MAX_ASSET_BYTES = 32 * 1024 * 1024
/** 画像の数の上限（書体のファイルも数える） */
export const KDR_MAX_ASSETS = 10_000
/** 埋め込める書体の数の上限 */
export const KDR_MAX_FONTS = 1_000

export type KdrLimits = { maxBytes?: number; maxJsonBytes?: number; maxAssetBytes?: number }

export class KdrError extends Error {
  override name = 'KdrError'
}

/** kdr の中の画像・書体のファイル名 */
export function assetFileName(id: AssetId, asset: Asset): string {
  const extension = ASSET_EXTENSIONS[asset.mime]
  if (extension === undefined) throw new KdrError(`assets.${id}: 未対応のファイル形式です`)
  return `assets/${id}.${extension}`
}

export async function decodeKdr(file: Blob, limits: KdrLimits = {}): Promise<DesignDocument> {
  const { document, assets } = await readKdrArchive(file, limits)
  return parseKdr(document, assets)
}

/**
 * kdr を展開して tar を読み、document.json（JSON として解析しただけのもの）と画像を返す。中身の検証は parseKdr がする。
 * 名前は document.json と assets/<id>.<拡張子> だけを受け付け、同じ名前・同じ id が 2 つあればエラーにする
 */
export async function readKdrArchive(
  file: Blob,
  { maxBytes = KDR_MAX_BYTES, maxJsonBytes = KDR_MAX_JSON_BYTES, maxAssetBytes = KDR_MAX_ASSET_BYTES }: KdrLimits = {},
): Promise<{ document: unknown; assets: Record<AssetId, Asset> }> {
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader()
  let total = 0
  const next = async (): Promise<Uint8Array | null> => {
    let result
    try {
      result = await reader.read()
    } catch {
      throw new KdrError('kdr ファイルを展開できません（gzip 形式ではありません）')
    }
    if (result.done) return null
    // v15 までの kdr は gzip した JSON そのもの（tar の見出しは名前から始まるので { にはならない）
    if (total === 0 && result.value[0] === 0x7b) {
      throw new KdrError('このファイルは古いバージョン（v15 以前）で作られているため開けません')
    }
    total += result.value.byteLength
    if (total > maxBytes) throw new KdrError('kdr ファイルが大きすぎます')
    return result.value
  }

  const names = new Set<string>()
  const ids = new Set<AssetId>()
  const check = (name: string, size: number) => {
    if (names.has(name)) throw new KdrError(`kdr の中に同じ名前のファイルが 2 つあります: ${name}`)
    names.add(name)
    if (name === KDR_DOCUMENT_NAME) {
      if (size > maxJsonBytes) throw new KdrError(`${name} が大きすぎます`)
      return
    }
    const match = ASSET_NAME_PATTERN.exec(name)
    if (match === null || match[1] === '__proto__') throw new KdrError(`kdr の中に知らないファイルがあります: ${name.slice(0, 120)}`)
    if (ids.has(match[1])) throw new KdrError(`kdr の中に同じ id のファイルが 2 つあります: ${match[1]}`)
    ids.add(match[1])
    if (ids.size > KDR_MAX_ASSETS) throw new KdrError('kdr の中の画像が多すぎます')
    if (size > maxAssetBytes) throw new KdrError(`${name}: ファイルが大きすぎます`)
  }

  let entries: TarEntry[]
  try {
    entries = await readTar(next, check)
  } catch (error) {
    if (error instanceof TarError) throw new KdrError(`kdr ファイルの中身が読めません: ${error.message}`)
    throw error
  } finally {
    // 途中でやめたときも、展開を止めて後片付けする
    reader.cancel().catch(() => {})
  }

  let document: unknown = undefined
  const assets: Record<AssetId, Asset> = {}
  for (const entry of entries) {
    if (entry.name === KDR_DOCUMENT_NAME) {
      try {
        document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes))
      } catch {
        throw new KdrError(`${KDR_DOCUMENT_NAME} が JSON として読めません`)
      }
      continue
    }
    const [, id, extension] = ASSET_NAME_PATTERN.exec(entry.name)!
    const mime = Object.keys(ASSET_EXTENSIONS).find((key) => ASSET_EXTENSIONS[key] === extension)!
    assets[id] = { mime, bytes: entry.bytes }
  }
  if (document === undefined) throw new KdrError(`kdr の中に ${KDR_DOCUMENT_NAME} がありません`)
  return { document, assets }
}

/**
 * 展開済みの JSON（document.json の中身）と画像・書体のファイルを検証し、既知のフィールドだけを持つドキュメントに組み直す。
 * 画像はノードや上書きから、書体のファイルは document.fonts から使われているものだけを残す（使われていないものは捨てる）
 */
export function parseKdr(value: unknown, files: Record<AssetId, unknown> = {}): DesignDocument {
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
  for (const [id, raw] of Object.entries(record(files, 'assets'))) {
    assets[nodeId(id, `assets.${id}`)] = parseAsset(raw, `assets.${id}`)
  }

  const context: AssetContext = { assets, used: new Set() }
  const pages = array(doc.pages, 'document.pages').map((raw, i) => parsePage(raw, `pages[${i}]`, context))
  if (pages.length === 0) throw new KdrError('document.pages: ページがありません')
  if (new Set(pages.map((page) => page.id)).size !== pages.length) {
    throw new KdrError('document.pages: ページの id が重複しています')
  }

  const fonts = doc.fonts === undefined ? [] : parseFonts(doc.fonts, 'document.fonts', context)

  const used: Record<AssetId, Asset> = {}
  for (const id of context.used) used[id] = assets[id]
  return { name: string(doc.name, 'document.name'), pages, assets: used, fonts }
}

/** 埋め込んだ書体の並び。書体のファイルがあること、同じ書体名・太さ・斜体の組が 2 つないことを確かめる */
function parseFonts(value: unknown, path: string, assets: AssetContext): EmbeddedFont[] {
  const list = array(value, path)
  if (list.length > KDR_MAX_FONTS) throw new KdrError(`${path}: 書体が多すぎます（${KDR_MAX_FONTS} 個まで）`)
  const seen = new Set<string>()
  return list.map((rawFont, i) => {
    const at = (key: string) => `${path}[${i}].${key}`
    const raw = record(rawFont, `${path}[${i}]`)
    const assetId = nodeId(raw.assetId, at('assetId'))
    const asset = Object.hasOwn(assets.assets, assetId) ? assets.assets[assetId] : undefined
    if (asset === undefined) throw new KdrError(`${at('assetId')}: 書体のファイルがありません`)
    if (!FONT_MIME_TYPES.includes(asset.mime)) throw new KdrError(`${at('assetId')}: 書体のファイルではありません`)
    const font: EmbeddedFont = {
      assetId,
      family: embeddedFamily(raw.family, at('family')),
      weight: raw.weight === undefined ? 400 : fontWeight(raw.weight, at('weight')),
      style: raw.style === undefined ? 'normal' : oneOf(raw.style, ['normal', 'italic'] as const, at('style')),
    }
    const key = `${font.family}\u0000${font.weight}\u0000${font.style}`
    if (seen.has(key)) throw new KdrError(`${path}[${i}]: 同じ書体名・太さ・斜体の書体が 2 つあります`)
    seen.add(key)
    assets.used.add(assetId)
    return font
  })
}

function embeddedFamily(value: unknown, path: string): string {
  const text = string(value, path)
  if (text.trim() === '' || text !== text.trim()) throw new KdrError(`${path}: 書体名が空か、前後に空白があります`)
  if (text.length > MAX_EMBEDDED_FAMILY_LENGTH) throw new KdrError(`${path}: 書体名が長すぎます（${MAX_EMBEDDED_FAMILY_LENGTH} 文字まで）`)
  if (EMBEDDED_FAMILY_FORBIDDEN.test(text)) throw new KdrError(`${path}: 書体名に使えない文字があります`)
  return text
}

/**
 * 読んでいる途中の画像。used には、ノード（画像）とインスタンスの上書き（画像の差し替え）から使われた id を読みながら入れる
 * （読み終えてからページの全部のノードを辿り直すと、large で約 2ms かかった）
 */
type AssetContext = { assets: Record<AssetId, Asset>; used: Set<AssetId> }

/** 画像のノードと上書きが指せるのは画像のファイルだけ（書体のファイルは指せない） */
function isImageAsset(assets: AssetContext, id: AssetId): boolean {
  return Object.hasOwn(assets.assets, id) && IMAGE_MIME_TYPES.includes(assets.assets[id].mime)
}

function parsePage(value: unknown, path: string, assets: AssetContext): Page {
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
  assets: AssetContext,
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
    // 作ったばかりで、まだどこからも参照されていないので、写さずに子を入れる
    if (node.type === 'frame') node.children = parseChildren(record(rawNode, at).children, `${at}.children`, node.id, depth + 1, scene, assets)
    return node.id
  })
}

/** 画像・書体の形式と中身（バイト列）。自動保存から読んだものなど、どこから来たものでも同じように確かめる */
function parseAsset(value: unknown, path: string): Asset {
  const raw = record(value, path)
  const mime = string(raw.mime, `${path}.mime`)
  const font = FONT_MIME_TYPES.includes(mime)
  if (!font && !IMAGE_MIME_TYPES.includes(mime)) throw new KdrError(`${path}.mime: 未対応のファイル形式です`)
  if (!(raw.bytes instanceof Uint8Array) || !(raw.bytes.buffer instanceof ArrayBuffer)) {
    throw new KdrError(`${path}.bytes: バイト列ではありません`)
  }
  // 書体は、先頭が拡張子どおりの書体ファイルであることだけを確かめる（中身の検査は描くときにブラウザや Canvas がする）
  if (font) {
    if (fontMime(raw.bytes) !== mime) throw new KdrError(`${path}: 書体のファイルとして読めません`)
    return { mime, bytes: raw.bytes as Uint8Array<ArrayBuffer> }
  }
  // 見出しの大きさが読める画像は、デコードする前に画素数を確かめる（読めない画像はデコードしないので描かれない。canvas/images.ts）
  const info = readImageInfo(raw.bytes)
  if (info !== null && isImageTooLarge(info)) throw new KdrError(`${path}: ${IMAGE_TOO_LARGE_MESSAGE}`)
  return { mime, bytes: raw.bytes as Uint8Array<ArrayBuffer> }
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
export const MAX_DEPTH = 100

export const STROKE_JOINS = ['miter', 'round', 'bevel'] as const
export const CAPS = ['none', 'round', 'square', 'arrow', 'circle', 'diamond'] as const
const SIZINGS = ['fixed', 'hug', 'fill'] as const
const CONSTRAINTS = ['start', 'end', 'stretch', 'center', 'scale'] as const
/** 1 つのパスに持てる頂点の数の上限 */
export const MAX_PATH_POINTS = 10_000
/** 塗り・線・効果の数の上限 */
export const MAX_PAINTS = 16
/** グラデーションの色の数の上限 */
export const MAX_STOPS = 16

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
  blendMode: 'normal',
  layoutPositioning: 'auto',
  minWidth: null,
  maxWidth: null,
  minHeight: null,
  maxHeight: null,
  fills: [],
  strokes: [],
  strokeWidth: 1,
  strokeDashes: [],
  strokeDashOffset: 0,
  strokeJoin: 'miter',
  effects: [],
  cornerRadius: 0,
  closed: false,
  startCap: 'none',
  endCap: 'none',
  capSize: 0,
  contours: [],
  fillRule: 'nonzero',
  isMask: false,
  maskType: 'vector',
  fontWeight: 400,
  textAlign: 'left',
  lineHeight: 1.2,
  textPath: null,
  fit: 'cover',
  positionX: 0.5,
  positionY: 0.5,
  scale: 1,
  flipX: false,
  flipY: false,
  clipContent: true,
  passThrough: false,
  layout: null,
  component: null,
  setDescription: '',
  booleanOperation: null,
  booleanIncludeStrokes: false,
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

/** ブーリアン演算の種類 */
const BOOLEAN_OPERATIONS = ['union', 'subtract', 'intersect', 'exclude'] as const

/** 書き出しで、ノードのうち書かない項目（入れ子や他の項目から決まるもの） */
const DERIVED_KEYS = new Set(['parentId', 'children', 'sizing', 'constraints'])

function parseNode(
  value: unknown,
  path: string,
  parentId: NodeId | null,
  assets: AssetContext,
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
    blendMode: optional('blendMode', blendMode),
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
    strokeDashes: optional('strokeDashes', dashes),
    strokeDashOffset: optional('strokeDashOffset', number),
    strokeJoin: optional('strokeJoin', (v, p) => oneOf(v, STROKE_JOINS, p)),
    effects: optional('effects', effects),
  })
  const cornerRadius = () => optional('cornerRadius', parseCornerRadius)
  const isMask = () => optional('isMask', boolean)
  const booleanOperation = () => {
    const op = optional('booleanOperation', (v, p) => (v === null ? null : oneOf(v, BOOLEAN_OPERATIONS, p)))
    if (op !== null && layout !== null) throw new KdrError(`${at('booleanOperation')}: 自動で並べるフレームは演算のノードにできません`)
    return op
  }
  const maskType = () => optional('maskType', (v, p) => oneOf(v, ['vector', 'alpha', 'luminance'] as const, p))

  switch (type) {
    case 'rect':
      return { ...base, ...style(), type, cornerRadius: cornerRadius(), isMask: isMask(), maskType: maskType() }
    case 'ellipse':
      return { ...base, ...style(), type, isMask: isMask(), maskType: maskType() }
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
        capSize: optional('capSize', size),
        contours: optional('contours', contours),
        fillRule: optional('fillRule', (v, p) => oneOf(v, ['nonzero', 'evenodd'] as const, p)),
        isMask: isMask(),
        maskType: maskType(),
      }
    }
    case 'text':
      return {
        ...base,
        type,
        text: string(raw.text, at('text')),
        fontSize: size(raw.fontSize, at('fontSize')),
        fontFamily: fontFamily(raw.fontFamily, at('fontFamily')),
        fills: optional('fills', paints),
        effects: optional('effects', effects),
        fontWeight: optional('fontWeight', fontWeight),
        textAlign: optional('textAlign', (v, p) => oneOf(v, ['left', 'center', 'right'] as const, p)),
        lineHeight: optional('lineHeight', size),
        textPath: optional('textPath', (v, p) => (v === null ? null : parseTextPath(v, p))),
        flipX: optional('flipX', boolean),
        flipY: optional('flipY', boolean),
        isMask: isMask(),
        maskType: maskType(),
      }
    case 'image': {
      const assetId = nodeId(raw.assetId, at('assetId'))
      if (!isImageAsset(assets, assetId)) throw new KdrError(`${at('assetId')}: 画像データがありません`)
      assets.used.add(assetId)
      return {
        ...base,
        type,
        assetId,
        effects: optional('effects', effects),
        cornerRadius: cornerRadius(),
        fit: optional('fit', (v, p) => oneOf(v, ['stretch', 'cover', 'contain'] as const, p)),
        positionX: optional('positionX', ratio),
        positionY: optional('positionY', ratio),
        scale: optional('scale', imageScale),
        flipX: optional('flipX', boolean),
        flipY: optional('flipY', boolean),
        isMask: isMask(),
        maskType: maskType(),
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
        passThrough: optional('passThrough', boolean),
        cornerRadius: cornerRadius(),
        layout,
        component: optional('component', (v, p) => (v === null ? null : parseComponent(v, p, assets))),
        setDescription: optional('setDescription', string),
        booleanOperation: booleanOperation(),
        booleanIncludeStrokes: optional('booleanIncludeStrokes', boolean),
        isMask: isMask(),
        maskType: maskType(),
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

const MAX_CONTOURS = 1_000
/** 破線の並びの数の上限 */
export const MAX_DASHES = 16

/** 線の破線の並び。0 以上の数で、すべて 0 は受け付けない（描けない） */
function dashes(value: unknown, path: string): number[] {
  const list = array(value, path).map((item, i) => size(item, `${path}[${i}]`))
  if (list.length > MAX_DASHES) throw new KdrError(`${path}: 破線の数が多すぎます`)
  if (list.length > 0 && list.every((item) => item === 0)) throw new KdrError(`${path}: 長さがすべて 0 です`)
  return list
}

/** パスの 2 つ目以降の輪郭。頂点の数は最初の輪郭と合わせて MAX_PATH_POINTS まで */
function contours(value: unknown, path: string): PathContour[] {
  const list = array(value, path)
  if (list.length > MAX_CONTOURS) throw new KdrError(`${path}: 輪郭の数が多すぎます`)
  let total = 0
  return list.map((item, i) => {
    const at = `${path}[${i}]`
    const raw = record(item, at)
    const points = array(raw.points, `${at}.points`).map((point, j) => parsePoint(point, `${at}.points[${j}]`))
    total += points.length
    if (points.length < 2 || total > MAX_PATH_POINTS) throw new KdrError(`${at}.points: 頂点の数が不正です`)
    return { points, closed: raw.closed === undefined ? false : boolean(raw.closed, `${at}.closed`) }
  })
}

/** テキストを沿わせる線。頂点はパスの頂点と同じ形で、2 つ以上 MAX_PATH_POINTS まで */
function parseTextPath(value: unknown, path: string): TextPath {
  const raw = record(value, path)
  const points = array(raw.points, `${path}.points`).map((point, i) => parsePoint(point, `${path}.points[${i}]`))
  if (points.length < 2 || points.length > MAX_PATH_POINTS) throw new KdrError(`${path}.points: 頂点の数が不正です`)
  return {
    points,
    closed: raw.closed === undefined ? false : boolean(raw.closed, `${path}.closed`),
    startOffset: raw.startOffset === undefined ? 0 : ratio(raw.startOffset, `${path}.startOffset`),
  }
}

/** パスの頂点。制御点 in / out（頂点からのずれ）と角の丸め radius は省略でき、なければ書かない（角の頂点） */
function parsePoint(value: unknown, path: string): PathPoint {
  const raw = record(value, path)
  const point: PathPoint = { x: number(raw.x, `${path}.x`), y: number(raw.y, `${path}.y`) }
  for (const key of ['in', 'out'] as const) {
    if (raw[key] === undefined) continue
    const control = record(raw[key], `${path}.${key}`)
    point[key] = { x: number(control.x, `${path}.${key}.x`), y: number(control.y, `${path}.${key}.y`) }
  }
  // 0 は「丸めない」なので持たない（書き出しでも省かれる）
  if (raw.radius !== undefined) {
    const radius = size(raw.radius, `${path}.radius`)
    if (radius > 0) point.radius = radius
  }
  return point
}

function parseComponent(value: unknown, path: string, assets: AssetContext): ComponentLink {
  const link = record(value, path)
  const id = nodeId(link.id, `${path}.id`)
  const role = oneOf(link.role, ['main', 'instance'] as const, `${path}.role`)
  if (role === 'main') {
    const description = link.description === undefined ? '' : string(link.description, `${path}.description`)
    const properties =
      link.properties === undefined ? [] : array(link.properties, `${path}.properties`).map((raw, i) => parseProperty(raw, `${path}.properties[${i}]`))
    if (new Set(properties.map((property) => property.name)).size !== properties.length) {
      throw new KdrError(`${path}.properties: プロパティの名前が重複しています`)
    }
    return { id, role, description, properties }
  }
  const overrides = link.overrides === undefined ? {} : parseOverrides(link.overrides, `${path}.overrides`, assets)
  const flipX = link.flipX === undefined ? false : boolean(link.flipX, `${path}.flipX`)
  const flipY = link.flipY === undefined ? false : boolean(link.flipY, `${path}.flipY`)
  return { id, role, overrides, flipX, flipY }
}

/** コンポーネントのプロパティ。結んだノードがあるかは確かめない（ないノードは使うときに無視する） */
function parseProperty(value: unknown, path: string): ComponentProperty {
  const raw = record(value, path)
  const name = string(raw.name, `${path}.name`)
  if (name.trim() === '') throw new KdrError(`${path}.name: プロパティの名前が空です`)
  return {
    name,
    type: oneOf(raw.type, ['text', 'boolean', 'instance'] as const, `${path}.type`),
    targets: raw.targets === undefined ? [] : array(raw.targets, `${path}.targets`).map((id, i) => nodeId(id, `${path}.targets[${i}]`)),
    // 重なりは 1 つにまとめる（どのコンポーネントがあるかは使うときに確かめる）
    preferred:
      raw.preferred === undefined
        ? []
        : [...new Set(array(raw.preferred, `${path}.preferred`).map((id, i) => nodeId(id, `${path}.preferred[${i}]`)))],
  }
}

/** インスタンスごとの上書き。どのノードに当たるかはここでは分からないので、値の形だけを確かめる */
function parseOverrides(value: unknown, path: string, assets: AssetContext): Record<NodeId, Override> {
  const overrides: Record<NodeId, Override> = {}
  for (const [id, rawOverride] of Object.entries(record(value, path))) {
    const at = (key: string) => `${path}.${id}.${key}`
    const raw = record(rawOverride, `${path}.${id}`)
    const override: Override = {}
    if (Object.hasOwn(raw, 'text')) override.text = string(raw.text, at('text'))
    if (Object.hasOwn(raw, 'fills')) override.fills = paints(raw.fills, at('fills'))
    if (Object.hasOwn(raw, 'strokes')) override.strokes = paints(raw.strokes, at('strokes'))
    if (Object.hasOwn(raw, 'strokeDashes')) override.strokeDashes = dashes(raw.strokeDashes, at('strokeDashes'))
    if (Object.hasOwn(raw, 'strokeDashOffset')) override.strokeDashOffset = number(raw.strokeDashOffset, at('strokeDashOffset'))
    if (Object.hasOwn(raw, 'visible')) override.visible = boolean(raw.visible, at('visible'))
    if (Object.hasOwn(raw, 'fontSize')) override.fontSize = size(raw.fontSize, at('fontSize'))
    if (Object.hasOwn(raw, 'fontFamily')) override.fontFamily = fontFamily(raw.fontFamily, at('fontFamily'))
    if (Object.hasOwn(raw, 'fontWeight')) override.fontWeight = fontWeight(raw.fontWeight, at('fontWeight'))
    if (Object.hasOwn(raw, 'flipX')) override.flipX = boolean(raw.flipX, at('flipX'))
    if (Object.hasOwn(raw, 'flipY')) override.flipY = boolean(raw.flipY, at('flipY'))
    if (Object.hasOwn(raw, 'assetId')) {
      override.assetId = nodeId(raw.assetId, at('assetId'))
      // 画像を差し替える上書きも、ファイルの中の画像を指していなければならない
      if (!isImageAsset(assets, override.assetId)) throw new KdrError(`${at('assetId')}: 上書きの画像データがありません`)
      assets.used.add(override.assetId)
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

/** 角丸。数値か、4 隅（左上・右上・右下・左下）の配列 */
function parseCornerRadius(value: unknown, path: string): CornerRadius {
  if (!Array.isArray(value)) return size(value, path)
  if (value.length !== 4) throw new KdrError(`${path}: 4 隅の配列ではありません`)
  const [a, b, c, d] = value.map((r, i) => size(r, `${path}[${i}]`))
  return [a, b, c, d]
}

/** 画像の切り抜きの拡大の上限 */
export const MAX_IMAGE_SCALE = 100

function imageScale(value: unknown, path: string): number {
  const n = number(value, path)
  if (n < 1 || n > MAX_IMAGE_SCALE) throw new KdrError(`${path}: 1〜${MAX_IMAGE_SCALE} の範囲ではありません`)
  return n
}

/** 円形のグラデーションの焦点（中心からのずれ。半径に対する割合）。楕円の中か上に限る */
function focus(raw: Record<string, unknown>, path: string): { fx: number; fy: number } {
  const fx = raw.fx === undefined ? 0 : number(raw.fx, `${path}.fx`)
  const fy = raw.fy === undefined ? 0 : number(raw.fy, `${path}.fy`)
  if (fx * fx + fy * fy > 1 + 1e-9) throw new KdrError(`${path}.fx: 焦点が楕円の外にあります`)
  return { fx, fy }
}

function parsePaint(value: unknown, path: string): Paint {
  const raw = record(value, path)
  const type = oneOf(raw.type, ['solid', 'linear', 'radial', 'conic'] as const, `${path}.type`)
  // 塗りの不透明度は 1 なら、表示は true なら省く（paintFile）
  const opacity = raw.opacity === undefined ? 1 : ratio(raw.opacity, `${path}.opacity`)
  const visible = raw.visible === undefined ? true : boolean(raw.visible, `${path}.visible`)
  // 描画モードは normal なら省く
  const mode = raw.blendMode === undefined ? 'normal' : blendMode(raw.blendMode, `${path}.blendMode`)
  const common = { opacity, visible, blendMode: mode }
  if (type === 'solid') return { type, color: color(raw.color, `${path}.color`), ...common }
  const stops = array(raw.stops, `${path}.stops`).map((stop, i): ColorStop => {
    const rawStop = record(stop, `${path}.stops[${i}]`)
    return {
      offset: ratio(rawStop.offset, `${path}.stops[${i}].offset`),
      color: color(rawStop.color, `${path}.stops[${i}].color`),
      // 色の不透明度は 1 なら省く（paintFile）
      opacity: rawStop.opacity === undefined ? 1 : ratio(rawStop.opacity, `${path}.stops[${i}].opacity`),
    }
  })
  if (stops.length < 2 || stops.length > MAX_STOPS) throw new KdrError(`${path}.stops: 色の数が不正です`)
  if (stops.some((stop, i) => i > 0 && stop.offset < stops[i - 1].offset)) {
    throw new KdrError(`${path}.stops: offset が小さい順に並んでいません`)
  }
  if (type === 'radial') {
    return {
      type,
      cx: number(raw.cx, `${path}.cx`),
      cy: number(raw.cy, `${path}.cy`),
      rx: size(raw.rx, `${path}.rx`),
      ry: size(raw.ry, `${path}.ry`),
      // 回す角度は 0 なら省く（paintFile）
      angle: raw.angle === undefined ? 0 : number(raw.angle, `${path}.angle`),
      // 焦点は 0 / 0（中心）なら省く（paintFile）
      ...focus(raw, path),
      stops,
      ...common,
    }
  }
  if (type === 'conic') {
    return {
      type,
      cx: number(raw.cx, `${path}.cx`),
      cy: number(raw.cy, `${path}.cy`),
      angle: number(raw.angle, `${path}.angle`),
      stops,
      ...common,
    }
  }
  return {
    type,
    x1: number(raw.x1, `${path}.x1`),
    y1: number(raw.y1, `${path}.y1`),
    x2: number(raw.x2, `${path}.x2`),
    y2: number(raw.y2, `${path}.y2`),
    stops,
    ...common,
  }
}

function effects(value: unknown, path: string): Effect[] {
  const list = array(value, path)
  if (list.length > MAX_PAINTS) throw new KdrError(`${path}: 効果が多すぎます`)
  return list.map((item, i) => {
    const at = `${path}[${i}]`
    const raw = record(item, at)
    const type = oneOf(raw.type, EFFECT_TYPES, `${at}.type`)
    // 表示は true なら省く（effectFile）
    const visible = raw.visible === undefined ? true : boolean(raw.visible, `${at}.visible`)
    const blur = size(raw.blur, `${at}.blur`)
    if (type === 'layer-blur' || type === 'background-blur') return { type, blur, visible }
    return {
      type,
      x: number(raw.x, `${at}.x`),
      y: number(raw.y, `${at}.y`),
      blur,
      // 広がりは 0 なら省く（effectFile）
      spread: raw.spread === undefined ? 0 : number(raw.spread, `${at}.spread`),
      color: color(raw.color, `${at}.color`),
      opacity: ratio(raw.opacity, `${at}.opacity`),
      visible,
      // 描画モードは normal なら省く（effectFile）
      blendMode: raw.blendMode === undefined ? 'normal' : blendMode(raw.blendMode, `${at}.blendMode`),
    }
  })
}

const EFFECT_TYPES = ['drop-shadow', 'inner-shadow', 'layer-blur', 'background-blur'] as const

/** 描画モードの名前（types.ts の BlendMode と同じ並び） */
export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const satisfies readonly BlendMode[]

function blendMode(value: unknown, path: string): BlendMode {
  return oneOf(value, BLEND_MODES, path)
}

function fontWeight(value: unknown, path: string): number {
  const n = number(value, path)
  if (!Number.isInteger(n / 100) || n < 100 || n > 900) throw new KdrError(`${path}: 100〜900 の 100 刻みではありません`)
  return n
}

/**
 * kdr の document.json の中身（JSON にするもの）。ノードを入れ子の木にし、既定値と同じ項目を省く。
 * 画像と書体のファイルは入らない（tar の assets/ に別のファイルとして入れる。editor/exportKdr.ts）。
 * 埋め込んだ書体の並び（fonts）は、空なら書かない。太さ 400・斜体なしも書かない
 */
export function kdrFile(
  doc: Pick<DesignDocument, 'name' | 'pages'> & { fonts?: readonly EmbeddedFont[] },
): { format: string; version: number; document: unknown } {
  const fonts = doc.fonts ?? []
  return {
    format: KDR_FORMAT,
    version: KDR_VERSION,
    document: {
      name: doc.name,
      pages: doc.pages.map((page) => ({ id: page.id, name: page.name, children: page.rootIds.map((id) => nodeFile(page, id)) })),
      ...(fonts.length === 0
        ? {}
        : {
            fonts: fonts.map(({ assetId, family, weight, style }) => ({
              assetId,
              family,
              ...(weight === 400 ? {} : { weight }),
              ...(style === 'normal' ? {} : { style }),
            })),
          }),
    },
  }
}

function nodeFile(scene: Scene, id: NodeId): Record<string, unknown> {
  const node = scene.nodes[id]
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (DERIVED_KEYS.has(key)) continue
    if (Object.hasOwn(DEFAULTS, key) && sameValue(value, DEFAULTS[key as keyof typeof DEFAULTS])) continue
    out[key] =
      key === 'layout' && value !== null
        ? omitDefaults(value as AutoLayout, LAYOUT_DEFAULTS)
        : PAINT_KEYS.has(key)
          ? (value as Paint[]).map(paintFile)
          : key === 'effects'
            ? (value as Effect[]).map(effectFile)
            : key === 'textPath' && value !== null
              ? textPathFile(value as TextPath)
              : value
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
    if (out.component && (out.component as ComponentLink).role === 'instance') {
      const { overrides, flipX, flipY, ...link } = out.component as Extract<ComponentLink, { role: 'instance' }>
      // 上書きの塗りも、不透明度が 1 なら省く
      const written = Object.fromEntries(
        Object.entries(overrides).map(([id, override]) => [
          id,
          Object.fromEntries(
            Object.entries(override).map(([key, value]) => [key, PAINT_KEYS.has(key) ? (value as Paint[]).map(paintFile) : value]),
          ),
        ]),
      )
      // 中身の裏返しも、していない向きは書かない
      out.component = {
        ...link,
        ...(Object.keys(written).length === 0 ? {} : { overrides: written }),
        ...(flipX ? { flipX } : {}),
        ...(flipY ? { flipY } : {}),
      }
    }
    // 元の説明文とプロパティは、空なら書かない
    if (out.component && (out.component as ComponentLink).role === 'main') {
      const { description, properties, ...link } = out.component as Extract<ComponentLink, { role: 'main' }>
      out.component = {
        ...link,
        ...(description === '' ? {} : { description }),
        // 差し替えの候補（preferred）も、空なら書かない
        ...(properties.length === 0
          ? {}
          : { properties: properties.map(({ preferred, ...property }) => (preferred.length === 0 ? property : { ...property, preferred })) }),
      }
    }
    if (node.children.length > 0) out.children = node.children.map((childId) => nodeFile(scene, childId))
  }
  return out
}

/** 塗りの配列を持つ項目（ノードと上書きで同じ名前） */
const PAINT_KEYS = new Set(['fills', 'strokes'])

/** ファイルに書く塗り。不透明度は 1 なら、表示は true なら省く */
function paintFile(paint: Paint): Partial<Paint> {
  const { opacity, visible, blendMode, ...rest } = paint
  const out: Record<string, unknown> = { ...rest }
  // 円形のグラデーションの回す角度は 0 なら省く
  if (out.type === 'radial' && out.angle === 0) delete out.angle
  // 焦点は中心（0 / 0）なら省く
  if (out.type === 'radial' && out.fx === 0 && out.fy === 0) {
    delete out.fx
    delete out.fy
  }
  // グラデーションの色の不透明度は 1 なら省く
  if ('stops' in rest) out.stops = rest.stops.map(({ opacity: stopOpacity, ...stop }) => (stopOpacity === 1 ? stop : { ...stop, opacity: stopOpacity }))
  return {
    ...out,
    ...(opacity === 1 ? {} : { opacity }),
    ...(visible ? {} : { visible }),
    ...(blendMode === 'normal' ? {} : { blendMode }),
  } as Partial<Paint>
}

/** ファイルに書く効果。表示は true なら省く */
function effectFile(effect: Effect): Partial<Effect> {
  const out: Record<string, unknown> = { ...effect }
  if (effect.visible) delete out.visible
  if ('spread' in effect && effect.spread === 0) delete out.spread
  if ('blendMode' in effect && effect.blendMode === 'normal') delete out.blendMode
  return out as Partial<Effect>
}

function omitDefaults<T extends object>(value: T, defaults: Partial<Record<keyof T, unknown>>): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([key, item]) => !(Object.hasOwn(defaults, key) && sameValue(item, defaults[key as keyof T]))),
  ) as Partial<T>
}

/** 既定値との比較。既定値は数値・文字列・真偽値・null・空の配列だけ */
/** テキストを沿わせる線。閉じていない・始まりが 0 なら書かない */
function textPathFile(textPath: TextPath): Record<string, unknown> {
  return {
    points: textPath.points,
    ...(textPath.closed ? { closed: true } : {}),
    ...(textPath.startOffset !== 0 ? { startOffset: textPath.startOffset } : {}),
  }
}

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

/** 書体名の長さの上限 */
export const MAX_FONT_FAMILY_LENGTH = 200
/** 書体名に使えない文字（制御文字と、CSS や HTML の区切りになる記号）。書体名にはふつう現れない */
const FONT_FAMILY_FORBIDDEN = /[\u0000-\u001f\u007f;{}<>\\]/

function fontFamily(value: unknown, path: string): string {
  const text = string(value, path)
  if (text.length > MAX_FONT_FAMILY_LENGTH) throw new KdrError(`${path}: 書体名が長すぎます（${MAX_FONT_FAMILY_LENGTH} 文字まで）`)
  if (FONT_FAMILY_FORBIDDEN.test(text)) throw new KdrError(`${path}: 書体名に使えない文字があります`)
  return text
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
  if (!choices.includes(value as T)) throw new KdrError(`${path}: 不正な値です`)
  return value as T
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
