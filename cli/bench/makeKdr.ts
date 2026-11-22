#!/usr/bin/env node
// 計測用の大きな kdr を作る（npm run bench が使う。単独でも動く）。
//   node cli/bench/makeKdr.ts --nodes 2000 --depth 4 --instances 170 --images 10 -o big.kdr
// ノードは editor の関数（createRect など）で作り、インスタンスの中身は editor と同じ syncComponents で入れ、
// 書き出しは editor の encodeKdr を通す。kdr の形式が変わっても（tar.gz など）、ここは変えずに済むようにしている。
// 同じオプションなら毎回同じ中身になる（id も色も、決まった順に振る）。
import { writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'
import type { Bounds } from '../../src/document/geometry.ts'
import { parseKdr, kdrFile } from '../../src/document/kdr.ts'
import { solid } from '../../src/document/paint.ts'
import type { Asset, DesignDocument, Effect, FrameNode, NodeId, Page, SceneNode } from '../../src/document/types.ts'
import { syncComponents } from '../../src/editor/components.ts'
import { encodeKdr } from '../../src/editor/exportKdr.ts'
import { createEllipse, createFrame, createImage, createRect, createText } from '../../src/editor/nodes.ts'
import { fitTextEstimated } from '../textMeasure.ts'

export type BenchOptions = {
  /** 普通のノード（フレームと葉）の数のおおよそ。インスタンスと画像は別に数える */
  nodes: number
  /** フレームの入れ子の深さ */
  depth: number
  /** コンポーネント「Card」のインスタンスの数（1 つに写しが 6 個入る） */
  instances: number
  /** 画像の数（どれも別の中身なので、アセットも同じ数になる） */
  images: number
  /** 画像 1 枚の一辺（ピクセル）。32 より大きいと乱数の模様にする（圧縮が効かない、写真に近い重さ） */
  imageSize: number
}

/** 計測スクリプトが画面の位置を計算するのに使う、決まった名前のノードのページ上の枠 */
export type BenchMeta = {
  options: BenchOptions
  /** ページのノードの数（写しを含む） */
  totalNodes: number
  copies: number
  /** レイヤー一覧の行の数（フレームは開き、インスタンスは閉じた状態） */
  layerRows: number
  /** ドラッグで動かす長方形 */
  dragTarget: Bounds
  /** 何もない場所。範囲選択をここから始める */
  empty: Bounds
  /** コンポーネントの元の中の、色を変える長方形の id */
  mainRectId: NodeId
  mainId: NodeId
}

export const DEFAULT_OPTIONS: BenchOptions = { nodes: 2000, depth: 4, instances: 170, images: 10, imageSize: 32 }

const PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
  '#f43f5e', '#78716c', '#64748b', '#1e293b', '#0f172a', '#334155', '#94a3b8', '#e2e8f0',
]
const FONT_SIZES = [12, 14, 16, 20, 24]
const SHADOWS: Effect[] = [
  { type: 'drop-shadow', x: 0, y: 2, blur: 4, color: '#000000', opacity: 0.2, visible: true },
  { type: 'drop-shadow', x: 0, y: 8, blur: 16, color: '#0f172a', opacity: 0.15, visible: true },
]

const LEAF = { width: 40, height: 24 }
const GAP = 8
/** 一番内側のフレームに入れる葉の数 */
const INNER_LEAVES = 20

/** 決まった順の id（kdr の id の書式: 英数字と _ -） */
function idMaker(prefix: string) {
  let next = 0
  return () => `${prefix}${(next++).toString(36)}`
}

/** 1 つの色で塗った、index ごとに少し違う PNG（index が違えば中身も違う） */
function makePng(index: number, size = 32): Asset {
  const raw = Buffer.alloc((size * 3 + 1) * size)
  const [r, g, b] = [(index * 53) & 255, (index * 97) & 255, (index * 151) & 255]
  const noisy = size > 32
  let seed = (index + 1) * 2654435761
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const offset = y * (size * 3 + 1) + 1 + x * 3
      if (noisy) {
        // xorshift の乱数（決まった順）
        seed ^= seed << 13
        seed ^= seed >>> 17
        seed ^= seed << 5
        raw[offset] = seed & 255
        raw[offset + 1] = (seed >>> 8) & 255
        raw[offset + 2] = (seed >>> 16) & 255
        continue
      }
      raw[offset] = (r + x * 4) & 255
      raw[offset + 1] = (g + y * 4) & 255
      raw[offset + 2] = b
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return { mime: 'image/png', bytes: new Uint8Array(png) }
}

export function makeBenchDocument(options: BenchOptions): { document: DesignDocument; meta: BenchMeta } {
  const nodeId = idMaker('n')
  const nodes: Record<NodeId, SceneNode> = {}
  const rootIds: NodeId[] = []
  let leafCount = 0

  /** ノードを登録する。parent を渡すと、その子の最後（最前面）に入れる */
  function add<T extends SceneNode>(node: T, parent: FrameNode | null): T {
    const placed = { ...node, id: nodeId(), parentId: parent?.id ?? null } as T
    nodes[placed.id] = placed
    if (parent) parent.children.push(placed.id)
    else rootIds.push(placed.id)
    return placed
  }

  function frame(name: string, bounds: Bounds, parent: FrameNode | null, fill = '#ffffff'): FrameNode {
    return add({ ...createFrame(bounds), name, fills: solid(fill), children: [] }, parent)
  }

  /** 葉を 1 つ。長方形・楕円・テキストを順に使い、色・文字の大きさ・影を散らす */
  function leaf(parent: FrameNode, bounds: Bounds): void {
    const i = leafCount++
    const color = PALETTE[i % PALETTE.length]
    const effects = i % 7 === 0 ? [SHADOWS[i % 2]] : []
    switch (i % 3) {
      case 0:
        add({ ...createRect(bounds), name: `Rect ${i}`, fills: solid(color), effects, cornerRadius: i % 4 }, parent)
        break
      case 1:
        add({ ...createEllipse(bounds), name: `Ellipse ${i}`, fills: solid(color), effects }, parent)
        break
      default:
        add(
          {
            ...createText(bounds, `Text ${i}`),
            name: `Text ${i}`,
            fills: solid(color),
            fontSize: FONT_SIZES[i % FONT_SIZES.length],
            fontWeight: i % 5 === 0 ? 700 : 400,
            sizing: { width: 'fixed', height: 'fixed' },
          },
          parent,
        )
    }
  }

  /** 葉を count 個、columns 列で並べたときの大きさ */
  const gridSize = (count: number, columns: number) => ({
    width: columns * (LEAF.width + GAP) + GAP,
    height: Math.ceil(count / columns) * (LEAF.height + GAP) + GAP,
  })

  // 1 つの「節」は、depth 段の入れ子のフレーム。各段に葉を 2 つ、一番内側に INNER_LEAVES 個を置く
  const depth = Math.max(1, options.depth)
  const perSection = depth + (depth - 1) * 2 + INNER_LEAVES
  const sections = Math.max(1, Math.round(options.nodes / perSection))
  const inner = gridSize(INNER_LEAVES, 5)
  // 各段は、上に葉 2 つ、その下に 1 段内側のフレーム
  const step = { width: GAP * 2, height: GAP * 3 + LEAF.height }
  const sectionSize = { width: inner.width + (depth - 1) * step.width, height: inner.height + (depth - 1) * step.height }
  const sectionColumns = Math.max(1, Math.ceil(Math.sqrt(sections)))
  const card = { width: 200, height: 120 }
  const instanceColumns = Math.max(1, Math.ceil(Math.sqrt(options.instances)))
  const imageColumns = Math.max(1, Math.ceil(Math.sqrt(options.images)))
  const treeWidth = sectionColumns * (sectionSize.width + GAP * 4)
  const treeHeight = Math.ceil(sections / sectionColumns) * (sectionSize.height + GAP * 4)
  const instancesWidth = instanceColumns * (card.width + GAP * 2) + GAP * 2
  const instancesHeight = Math.ceil(options.instances / instanceColumns) * (card.height + GAP * 2) + GAP * 2
  // 左の列: ドラッグする長方形・何もない場所・コンポーネントの元。右へ、木・インスタンス・画像を並べる
  const contentHeight = Math.max(treeHeight, instancesHeight, 1200)
  const side = Math.round(contentHeight * 0.3)
  const dragTarget = { x: 0, y: 0, width: side, height: side }
  const empty = { x: 0, y: side + 40, width: side, height: Math.round(contentHeight * 0.3) }
  const left = side + 200

  add({ ...createRect(dragTarget), name: 'DragTarget', fills: solid('#4f46e5') }, null)

  // コンポーネントの元。写しは 6 個（背景・アバター・見出し・説明・バッジとその中の文字）
  const mainTop = empty.y + empty.height + 40
  const main = frame('Card', { x: 0, y: mainTop, ...card }, null, '#ffffff')
  main.component = { id: 'card', role: 'main', description: '', properties: [] }
  main.effects = [SHADOWS[1]]
  const mainRect = add({ ...createRect({ x: 0, y: 0, ...card }), name: 'Background', fills: solid('#f8fafc') }, main)
  add({ ...createEllipse({ x: 16, y: 16, width: 40, height: 40 }), name: 'Avatar', fills: solid('#6366f1') }, main)
  const fixedText = (text: string, bounds: Bounds, fontSize: number, color: string) => ({
    ...createText(bounds, text),
    name: text,
    fontSize,
    fills: solid(color),
    sizing: { width: 'fixed', height: 'fixed' } as const,
  })
  add(fixedText('Title', { x: 72, y: 18, width: 100, height: 20 }, 16, '#0f172a'), main)
  add(fixedText('Description', { x: 72, y: 42, width: 110, height: 16 }, 12, '#64748b'), main)
  const badge = frame('Badge', { x: 16, y: 80, width: 60, height: 24 }, main, '#dcfce7')
  add(fixedText('New', { x: 8, y: 4, width: 40, height: 16 }, 12, '#166534'), badge)

  // 普通のノードの木
  const tree = frame('Tree', { x: left, y: 0, width: treeWidth, height: treeHeight }, null, '#f1f5f9')
  for (let s = 0; s < sections; s++) {
    const x = (s % sectionColumns) * (sectionSize.width + GAP * 4) + GAP * 2
    const y = Math.floor(s / sectionColumns) * (sectionSize.height + GAP * 4) + GAP * 2
    let parent = frame(`Section ${s}`, { x, y, ...sectionSize }, tree)
    let size = sectionSize
    for (let level = 1; level < depth; level++) {
      leaf(parent, { x: GAP, y: GAP, ...LEAF })
      leaf(parent, { x: GAP * 2 + LEAF.width, y: GAP, ...LEAF })
      size = { width: size.width - step.width, height: size.height - step.height }
      parent = frame(`Level ${level}`, { x: GAP, y: GAP * 2 + LEAF.height, ...size }, parent, PALETTE[(s + level) % PALETTE.length])
    }
    for (let i = 0; i < INNER_LEAVES; i++) {
      leaf(parent, { x: GAP + (i % 5) * (LEAF.width + GAP), y: GAP + Math.floor(i / 5) * (LEAF.height + GAP), ...LEAF })
    }
  }

  // インスタンス。中身は下の syncComponents が入れる
  const instancesLeft = left + treeWidth + 200
  const holder = frame('Instances', { x: instancesLeft, y: 0, width: instancesWidth, height: instancesHeight }, null, '#f8fafc')
  for (let i = 0; i < options.instances; i++) {
    const x = (i % instanceColumns) * (card.width + GAP * 2) + GAP * 2
    const y = Math.floor(i / instanceColumns) * (card.height + GAP * 2) + GAP * 2
    add(
      { ...createFrame({ x, y, ...card }), name: 'Card', children: [], component: { id: 'card', role: 'instance', overrides: {} } },
      holder,
    )
  }

  // 画像（別々の中身）
  const assets: Record<string, Asset> = {}
  if (options.images > 0) {
    const imagesLeft = instancesLeft + instancesWidth + 200
    const images = frame(
      'Images',
      { x: imagesLeft, y: 0, width: imageColumns * 72 + 8, height: Math.ceil(options.images / imageColumns) * 72 + 8 },
      null,
    )
    for (let i = 0; i < options.images; i++) {
      const assetId = `img${i}`
      assets[assetId] = makePng(i, options.imageSize)
      add({ ...createImage({ x: 8 + (i % imageColumns) * 72, y: 8 + Math.floor(i / imageColumns) * 72, width: 64, height: 64 }, assetId), name: `Image ${i}` }, images)
    }
  }

  const page: Page = { id: 'page1', name: 'Bench', nodes, rootIds }
  // 読み込んだときと同じ形に組み直してから、インスタンスの中身を入れる
  const parsed = parseKdr(JSON.parse(JSON.stringify(kdrFile({ name: 'Bench', pages: [page] }))), assets)
  const document = syncComponents(parsed, fitTextEstimated)
  const synced = document.pages[0]
  const totalNodes = Object.keys(synced.nodes).length
  const ownNodes = Object.keys(nodes).length
  return {
    document,
    meta: {
      options,
      totalNodes,
      copies: totalNodes - ownNodes,
      layerRows: ownNodes,
      dragTarget,
      empty,
      mainRectId: mainRect.id,
      mainId: main.id,
    },
  }
}

/** --nodes 2000 のような引数を読む。知らない名前はエラー */
export function parseOptions(argv: readonly string[]): { options: BenchOptions; output: string | null } {
  const options = { ...DEFAULT_OPTIONS }
  let output: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]
    const value = argv[++i]
    if (name === '-o' || name === '--output') {
      output = value
      continue
    }
    const key = name.replace(/^--/, '') as keyof BenchOptions
    if (!(key in DEFAULT_OPTIONS) || value === undefined || !/^\d+$/.test(value)) {
      throw new Error(`使い方: makeKdr.ts [--nodes N] [--depth N] [--instances N] [--images N] [--imageSize N] -o 出力.kdr（${name} が読めません）`)
    }
    options[key] = Number(value)
  }
  return { options, output }
}

export async function writeBenchKdr(options: BenchOptions, output: string): Promise<BenchMeta> {
  const { document, meta } = makeBenchDocument(options)
  writeFileSync(output, Buffer.from(await (await encodeKdr(document)).arrayBuffer()))
  return meta
}

if (import.meta.main) {
  const { options, output } = parseOptions(process.argv.slice(2))
  if (output === null) throw new Error('-o で出力先を指定してください')
  const meta = await writeBenchKdr(options, output)
  console.log(JSON.stringify(meta, null, 2))
}
