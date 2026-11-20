import type { DesignDocument, NodeId, SceneNode } from './types.ts'

// kdr ファイルの実体は gzip 圧縮した 1 つの JSON:
//   { format: 'kadrokreo', version: 1, document: DesignDocument }
export const KDR_FORMAT = 'kadrokreo'
export const KDR_VERSION = 1
export const KDR_EXTENSION = '.kdr'

/** 展開後サイズの上限。細工された圧縮ファイルでメモリを食い潰されないようにする */
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024

export class KdrError extends Error {
  override name = 'KdrError'
}

export async function decodeKdr(
  file: Blob,
  { maxBytes = DEFAULT_MAX_BYTES }: { maxBytes?: number } = {},
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
  if (file.version !== KDR_VERSION) {
    throw new KdrError(`未対応のバージョンです: ${file.version}`)
  }

  const doc = record(file.document, 'document')
  const rawNodes = record(doc.nodes, 'document.nodes')
  const nodes: Record<NodeId, SceneNode> = {}
  for (const [id, raw] of Object.entries(rawNodes)) {
    const node = parseNode(raw, `nodes.${id}`)
    if (node.id !== id) throw new KdrError(`nodes.${id}: id がキーと一致しません`)
    nodes[id] = node
  }

  const document: DesignDocument = {
    name: string(doc.name, 'document.name'),
    nodes,
    rootIds: idArray(doc.rootIds, 'document.rootIds'),
  }
  checkTree(document)
  return document
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
/** 描画は再帰で辿るので、入れ子の深さに上限を設ける */
export const MAX_DEPTH = 100

function parseNode(value: unknown, path: string): SceneNode {
  const raw = record(value, path)
  const base = {
    id: nodeId(raw.id, `${path}.id`),
    name: string(raw.name, `${path}.name`),
    parentId: raw.parentId === null ? null : nodeId(raw.parentId, `${path}.parentId`),
    x: number(raw.x, `${path}.x`),
    y: number(raw.y, `${path}.y`),
    width: size(raw.width, `${path}.width`),
    height: size(raw.height, `${path}.height`),
    visible: boolean(raw.visible, `${path}.visible`),
    locked: boolean(raw.locked, `${path}.locked`),
    opacity: number(raw.opacity, `${path}.opacity`),
  }
  if (base.opacity < 0 || base.opacity > 1) {
    throw new KdrError(`${path}.opacity: 0〜1 の範囲ではありません`)
  }

  const paint = () => ({
    fill: raw.fill === null ? null : color(raw.fill, `${path}.fill`),
    stroke: raw.stroke === null ? null : color(raw.stroke, `${path}.stroke`),
    strokeWidth: size(raw.strokeWidth, `${path}.strokeWidth`),
  })

  switch (raw.type) {
    case 'rect':
      return {
        ...base,
        ...paint(),
        type: 'rect',
        cornerRadius: size(raw.cornerRadius, `${path}.cornerRadius`),
      }
    case 'ellipse':
      return { ...base, ...paint(), type: 'ellipse' }
    case 'text':
      return {
        ...base,
        type: 'text',
        text: string(raw.text, `${path}.text`),
        fontSize: size(raw.fontSize, `${path}.fontSize`),
        fontFamily: string(raw.fontFamily, `${path}.fontFamily`),
        fill: color(raw.fill, `${path}.fill`),
      }
    case 'frame':
      return {
        ...base,
        ...paint(),
        type: 'frame',
        children: idArray(raw.children, `${path}.children`),
        clipContent: boolean(raw.clipContent, `${path}.clipContent`),
      }
    default:
      throw new KdrError(`${path}.type: 未対応のノード種別です`)
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
