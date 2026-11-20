import type { Asset, AssetId, DesignDocument, NodeId, SceneNode, Shadow } from './types.ts'

// kdr ファイルの実体は gzip 圧縮した 1 つの JSON:
//   { format: 'kadrokreo', version: 3, document: DesignDocument }
// 古い version も読み込める。それぞれで増えたもの:
//   2: 画像（assets）、テキストの折り返し（autoWidth）
//   3: 直線、影、フレームと画像の角丸、テキストの太さ・行揃え・行の高さ
export const KDR_FORMAT = 'kadrokreo'
export const KDR_VERSION = 3
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
  if (file.version !== 1 && file.version !== 2 && file.version !== 3) {
    throw new KdrError(`未対応のバージョンです: ${file.version}`)
  }
  const version: Version = file.version

  const doc = record(file.document, 'document')
  const assets: Record<AssetId, Asset> = {}
  if (version >= 2) {
    for (const [id, raw] of Object.entries(record(doc.assets, 'document.assets'))) {
      assets[nodeId(id, `assets.${id}`)] = parseAsset(raw, `assets.${id}`)
    }
  }

  const rawNodes = record(doc.nodes, 'document.nodes')
  const nodes: Record<NodeId, SceneNode> = {}
  for (const [id, raw] of Object.entries(rawNodes)) {
    const node = parseNode(raw, `nodes.${id}`, version)
    if (node.id !== id) throw new KdrError(`nodes.${id}: id がキーと一致しません`)
    if (node.type === 'image' && !Object.hasOwn(assets, node.assetId)) {
      throw new KdrError(`nodes.${id}: 画像データがありません`)
    }
    nodes[id] = node
  }

  const document: DesignDocument = {
    name: string(doc.name, 'document.name'),
    nodes,
    rootIds: idArray(doc.rootIds, 'document.rootIds'),
    assets,
  }
  checkTree(document)
  return document
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
/** 描画は再帰で辿るので、入れ子の深さに上限を設ける */
export const MAX_DEPTH = 100

type Version = 1 | 2 | 3

function parseNode(value: unknown, path: string, version: Version): SceneNode {
  const raw = record(value, path)
  const at = (key: string) => `${path}.${key}`
  /** since より前の version にはないフィールド。古いファイルでは当時の見た目になる値で補う */
  const added = <T>(since: Version, fallback: T, parse: () => T): T =>
    version < since ? fallback : parse()

  const base = {
    id: nodeId(raw.id, at('id')),
    name: string(raw.name, at('name')),
    parentId: raw.parentId === null ? null : nodeId(raw.parentId, at('parentId')),
    x: number(raw.x, at('x')),
    y: number(raw.y, at('y')),
    width: size(raw.width, at('width')),
    height: size(raw.height, at('height')),
    visible: boolean(raw.visible, at('visible')),
    locked: boolean(raw.locked, at('locked')),
    opacity: ratio(raw.opacity, at('opacity')),
  }

  const paint = () => ({
    fill: raw.fill === null ? null : color(raw.fill, at('fill')),
    stroke: raw.stroke === null ? null : color(raw.stroke, at('stroke')),
    strokeWidth: size(raw.strokeWidth, at('strokeWidth')),
    shadow: added(3, null, () => (raw.shadow === null ? null : parseShadow(raw.shadow, at('shadow')))),
  })
  const cornerRadius = () => size(raw.cornerRadius, at('cornerRadius'))

  switch (raw.type) {
    case 'rect':
      return { ...base, ...paint(), type: 'rect', cornerRadius: cornerRadius() }
    case 'ellipse':
      return { ...base, ...paint(), type: 'ellipse' }
    case 'line':
      return {
        ...base,
        type: 'line',
        stroke: color(raw.stroke, at('stroke')),
        strokeWidth: size(raw.strokeWidth, at('strokeWidth')),
        direction: oneOf(raw.direction, ['down', 'up'] as const, at('direction')),
      }
    case 'text':
      return {
        ...base,
        type: 'text',
        text: string(raw.text, at('text')),
        fontSize: size(raw.fontSize, at('fontSize')),
        fontFamily: string(raw.fontFamily, at('fontFamily')),
        fill: color(raw.fill, at('fill')),
        autoWidth: added(2, true, () => boolean(raw.autoWidth, at('autoWidth'))),
        fontWeight: added(3, 400, () => oneOf(raw.fontWeight, [400, 700] as const, at('fontWeight'))),
        textAlign: added(3, 'left', () =>
          oneOf(raw.textAlign, ['left', 'center', 'right'] as const, at('textAlign')),
        ),
        lineHeight: added(3, 1.2, () => size(raw.lineHeight, at('lineHeight'))),
      }
    case 'image':
      return {
        ...base,
        type: 'image',
        assetId: nodeId(raw.assetId, at('assetId')),
        cornerRadius: added(3, 0, cornerRadius),
      }
    case 'frame':
      return {
        ...base,
        ...paint(),
        type: 'frame',
        children: idArray(raw.children, at('children')),
        clipContent: boolean(raw.clipContent, at('clipContent')),
        cornerRadius: added(3, 0, cornerRadius),
      }
    default:
      throw new KdrError(`${at('type')}: 未対応のノード種別です`)
  }
}

function parseShadow(value: unknown, path: string): Shadow {
  const raw = record(value, path)
  return {
    x: number(raw.x, `${path}.x`),
    y: number(raw.y, `${path}.y`),
    blur: size(raw.blur, `${path}.blur`),
    color: color(raw.color, `${path}.color`),
    opacity: ratio(raw.opacity, `${path}.opacity`),
  }
}

/** rootIds から辿って、すべてのノードがちょうど 1 回ずつ現れる木になっていることを確かめる */
function checkTree(doc: DesignDocument): void {
  const seen = new Set<NodeId>()
  const stack: { id: NodeId; parentId: NodeId | null; depth: number }[] = doc.rootIds.map((id) => ({
    id,
    parentId: null,
    depth: 1,
  }))
  while (stack.length > 0) {
    const { id, parentId, depth } = stack.pop()!
    if (depth > MAX_DEPTH) throw new KdrError('フレームの入れ子が深すぎます')
    if (!Object.hasOwn(doc.nodes, id)) throw new KdrError(`存在しないノードへの参照です: ${id}`)
    if (seen.has(id)) throw new KdrError(`ノードが複数の場所から参照されています: ${id}`)
    seen.add(id)

    const node = doc.nodes[id]
    if (node.parentId !== parentId) throw new KdrError(`nodes.${id}: parentId が親と一致しません`)
    if (node.type === 'frame') {
      for (const childId of node.children) stack.push({ id: childId, parentId: id, depth: depth + 1 })
    }
  }
  if (seen.size !== Object.keys(doc.nodes).length) {
    throw new KdrError('どこからも参照されていないノードがあります')
  }
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

function nodeId(value: unknown, path: string): NodeId {
  const id = string(value, path)
  // __proto__ はオブジェクトのキーとして安全に扱えないので弾く
  if (!ID_PATTERN.test(id) || id === '__proto__') throw new KdrError(`${path}: 不正な id です`)
  return id
}

function idArray(value: unknown, path: string): NodeId[] {
  if (!Array.isArray(value)) throw new KdrError(`${path}: 配列ではありません`)
  return value.map((item, i) => nodeId(item, `${path}[${i}]`))
}
