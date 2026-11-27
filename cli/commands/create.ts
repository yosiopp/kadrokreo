import { IMAGE_MIME_TYPES, KDR_MAX_ASSET_BYTES } from '../../src/document/kdr.ts'
import { pathFromContours, pathFromPoints } from '../../src/document/path.ts'
import { POLYGON_MAX_COUNT, POLYGON_MIN_COUNT, STAR_DEFAULT_RATIO, type PolygonShape, polygonSize, regularPolygon, star } from '../../src/document/polygon.ts'
import { PathDataError, parsePathData } from '../../src/document/pathData.ts'
import type { Asset, NodeId, PathNode, SceneNode } from '../../src/document/types.ts'
import {
  createEllipse,
  createFrame,
  createId,
  createImage,
  createLine,
  createPath,
  createRect,
  createText,
} from '../../src/editor/nodes.ts'
import { copyFragment } from '../../src/editor/operations/clipboard.ts'
import { addOrReuseAsset, pasteIntoPage, updatePage } from '../../src/editor/operations/document.ts'
import { insertNode } from '../../src/editor/operations/tree.ts'
import { type Step, UsageError } from '../args.ts'
import { IMAGE_TOO_LARGE_MESSAGE, isImageTooLarge, readImageInfo } from '../../src/document/imageInfo.ts'
import { checkNewId } from '../session.ts'
import { canvasTextMetrics } from '../png.ts'
import { convertSvgFile, placeSvgFragment } from '../svg.ts'
import { estimateTextSize } from '../textMeasure.ts'
import { buildPatch } from '../values.ts'
import { type Command, type Context, checkStep, flag, numberOption, option, point, positional } from './common.ts'

// ノードを作るコマンド（add・svg・dup）

const NODE_TYPES = ['rect', 'ellipse', 'polygon', 'star', 'line', 'path', 'text', 'frame', 'image'] as const
type NodeType = (typeof NODE_TYPES)[number]

async function buildNode(ctx: Context, step: Step, type: NodeType): Promise<SceneNode> {
  const x = numberOption(step, 'x') ?? 0
  const y = numberOption(step, 'y') ?? 0
  const width = numberOption(step, 'width')
  const height = numberOption(step, 'height')
  const box = { x, y, width: width ?? 100, height: height ?? 100 }

  switch (type) {
    case 'rect':
      return createRect(box)
    case 'ellipse':
      return createEllipse(box)
    case 'polygon':
    case 'star': {
      const shape = polygonShape(type, numberOption(step, 'count'), numberOption(step, 'ratio'), `add ${type}`)
      // 大きさを省いた側は、正しい形になる縦横比から決める
      // editor のツールと同じく、塗りだけで線は付けない
      return { ...createPath({ x, y, ...polygonSize(shape.aspect, width, height), points: shape.points }, true), strokes: [], name: type === 'star' ? 'Star' : 'Polygon' }
    }
    case 'frame':
      return createFrame(box)
    case 'line': {
      const from = option(step, 'from')
      const to = option(step, 'to')
      if (from === undefined || to === undefined) {
        return createLine({ ...box, height: height ?? 0 })
      }
      return createLine(pathFromPoints([point(from, '--from'), point(to, '--to')]))
    }
    case 'path': {
      const d = option(step, 'd')
      if (d !== undefined) {
        if (option(step, 'points') !== undefined) throw new UsageError('add path: --d と --points は一緒に指定できません')
        return pathFromData(d, flag(step, 'closed'))
      }
      const raw = option(step, 'points')
      if (raw === undefined) throw new UsageError('add path: --points "x,y x,y …" か --d "M… C…" で頂点を指定してください')
      const points = raw.trim().split(/\s+/).map((part) => point(part, '--points'))
      if (points.length < 2) throw new UsageError('add path: 頂点は 2 つ以上です')
      return createPath(pathFromPoints(points), flag(step, 'closed'))
    }
    case 'text': {
      const text = createText(box, option(step, 'text') ?? '')
      // 幅を指定したら、その幅で折り返す
      return { ...text, sizing: { width: width === undefined ? 'hug' : 'fixed', height: 'hug' }, width: width ?? text.width }
    }
    case 'image': {
      const file = option(step, 'src')
      const asset = option(step, 'asset')
      if (asset !== undefined) {
        if (!Object.hasOwn(ctx.session.document.assets, asset)) throw new UsageError(`画像がありません: ${asset}`)
        return createImage(box, asset)
      }
      if (file === undefined) throw new UsageError('add image: --src で画像ファイルを指定してください')
      const { asset: read, info } = await readImageFile(ctx.readFile, file)
      // 同じ画像がすでにあれば、新しいアセットを作らずにそれを使う
      let assetId = ''
      ctx.session.applyDocument((doc) => {
        const added = addOrReuseAsset(doc, read, createId)
        assetId = added.assetId
        return added.document
      })
      // 大きさを片方だけ指定したら、縦横比を保つ
      const ratio = info.height === 0 ? 1 : info.width / info.height
      const w = width ?? (height !== undefined ? height * ratio : info.width)
      const h = height ?? (width !== undefined ? width / ratio : info.height)
      return createImage({ x, y, width: Math.max(1, w), height: Math.max(1, h) }, assetId)
    }
  }
}

/**
 * 正多角形（count は頂点の数。既定 3）と星（count は先の数。既定 5。ratio は内側の頂点の半径の、先に対する比。既定 0.382）の頂点。
 * できるのはふつうの閉じたパス。label はエラーの頭に付ける呼び名、dash は項目名の前に付けるもの（オプションなら --、属性なら空）
 */
export function polygonShape(type: 'polygon' | 'star', count: number | undefined, ratio: number | undefined, label: string, dash = '--'): PolygonShape {
  const n = count ?? (type === 'star' ? 5 : 3)
  if (!Number.isInteger(n) || n < POLYGON_MIN_COUNT || n > POLYGON_MAX_COUNT) {
    throw new UsageError(`${label}: ${dash}count は ${POLYGON_MIN_COUNT}〜${POLYGON_MAX_COUNT} の整数です: ${n}`)
  }
  if (type === 'polygon') {
    if (ratio !== undefined) throw new UsageError(`${label}: ${dash}ratio は star にだけ指定できます`)
    return regularPolygon(n)
  }
  const r = ratio ?? STAR_DEFAULT_RATIO
  if (!(r > 0 && r < 1)) throw new UsageError(`${label}: ${dash}ratio は 0 より大きく 1 未満です: ${r}`)
  return star(n, r)
}

/** 画像ファイルを読み、kdr に入れられる画像か（種類・ファイルの大きさ・画素数。kdr の読み込みと同じ上限）を確かめる */
export async function readImageFile(
  readFile: Context['readFile'],
  file: string,
): Promise<{ asset: Asset; info: { width: number; height: number } }> {
  const bytes = await readFile(file)
  const info = readImageInfo(bytes)
  if (!info || !IMAGE_MIME_TYPES.includes(info.mime)) {
    throw new UsageError(`${file}: PNG・JPEG・WebP・GIF の画像ではありません`)
  }
  if (bytes.byteLength > KDR_MAX_ASSET_BYTES) {
    throw new UsageError(`${file}: 画像が大きすぎます（${KDR_MAX_ASSET_BYTES / 1024 / 1024}MB まで）`)
  }
  if (isImageTooLarge(info)) throw new UsageError(`${file}: ${IMAGE_TOO_LARGE_MESSAGE}`)
  return { asset: { mime: info.mime, bytes: new Uint8Array(bytes) }, info }
}

/**
 * SVG の path の d から作るパス（曲線を含められる）。座標は親の座標系。Z か --closed で閉じた形。
 * M で始まるまとまりが複数あれば、2 つ目以降は同じパスの輪郭（穴など。塗る範囲は fillRule で決まる）になる。
 * label はエラーの頭に付ける、指定した場所の呼び名
 */
export function pathFromData(d: string, close: boolean, label = 'add path: --d'): PathNode {
  let subpaths
  try {
    subpaths = parsePathData(d)
  } catch (error) {
    if (error instanceof PathDataError) throw new UsageError(`${label}: ${error.message}`)
    throw error
  }
  if (subpaths.length === 0 || subpaths.some((subpath) => subpath.vertices.length < 2)) {
    throw new UsageError(`${label}: 頂点は輪郭ごとに 2 つ以上です`)
  }
  const shape = pathFromContours(subpaths.map((subpath) => ({ vertices: subpath.vertices, closed: subpath.closed || close })))
  return { ...createPath(shape, shape.closed), contours: shape.contours }
}

async function runAdd(ctx: Context, step: Step): Promise<void> {
  const type = positional(step, 0, '種類（' + NODE_TYPES.join(' / ') + '）') as NodeType
  if (!NODE_TYPES.includes(type)) throw new UsageError(`add: 不明な種類です: ${type}（${NODE_TYPES.join(' / ')}）`)
  checkStep(step, {
    options: ['x', 'y', 'width', 'height', 'parent', 'index', 'id', 'name', 'text', 'from', 'to', 'points', 'd', 'closed', 'src', 'asset', 'count', 'ratio'],
    positionals: 1,
    assignments: true,
  })
  const { session } = ctx
  const parentSelector = option(step, 'parent')
  const parentId = parentSelector === undefined ? null : session.resolveFrame(parentSelector)
  const index = numberOption(step, 'index')
  const id = option(step, 'id')
  if (id !== undefined) checkNewId(session.page, id)

  let node = await buildNode(ctx, step, type)
  const name = option(step, 'name')
  node = { ...node, ...(id === undefined ? {} : { id }), ...(name === undefined ? {} : { name }) }
  // 名前=値 は、作ったノードへ set と同じ決まりで当てる
  node = { ...node, ...buildPatch(node, step.assignments, session.document.collections) } as SceneNode
  // layout=row|column|grid は大きさを中身に合わせるが、--width / --height で決めた向きは固定のまま
  if (node.type === 'frame' && node.layout) {
    const fixed = (axis: 'width' | 'height') => (node.sizing[axis] === 'hug' && option(step, axis) !== undefined ? 'fixed' : node.sizing[axis])
    node = { ...node, sizing: { width: fixed('width'), height: fixed('height') } }
  }
  if (node.type === 'text') node = { ...node, ...estimateTextSize(node) }

  const created = node
  session.apply((page) => insertNode(page, created, parentId, index))
  session.last = [created.id]
}

export const add: Command = {
  name: 'add',
  kind: 'edit',
  assignments: true,
  usage:
    'add 種類 [--x N --y N --width N --height N] [--parent フレーム] [--index N] [--id ID] [--name 名前] [名前=値…]\n' +
    '      種類: rect ellipse frame text（--text 文字）line（--from x,y --to x,y）\n' +
    '            polygon（[--count 頂点の数 3〜100]）star（[--count 先の数] [--ratio 内側の比 0〜1]）\n' +
    '            path（--points "x,y x,y …" [--closed] | --d "M0 0 C…"）image（--src 画像 | --asset ID）',
  summary: 'ノードを足す。座標は親の左上が原点。作ったノードは次のコマンドで「@」で指せる',
  flags: ['closed'],
  run: runAdd,
}

export const svg: Command = {
  name: 'svg',
  kind: 'edit',
  usage: 'svg ファイル.svg [--x N --y N] [--parent フレーム] [--id ID] [--name 名前]',
  summary:
    'SVG を図形のノードに変換して置く（全体を 1 つのフレームに、g は入れ子のフレームに）。表せずに落としたものは標準エラーに出す。置いたものは「@」で指せる',
  async run(ctx, step) {
    checkStep(step, { options: ['x', 'y', 'parent', 'id', 'name'], positionals: 1 })
    const { session } = ctx
    const file = positional(step, 0, 'SVG ファイル')
    const parent = option(step, 'parent')
    const parentId = parent === undefined ? null : session.resolveFrame(parent)
    const id = option(step, 'id')
    if (id !== undefined) checkNewId(session.page, id)
    const at = { x: numberOption(step, 'x') ?? 0, y: numberOption(step, 'y') ?? 0 }
    const base = file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'SVG'
    const bytes = await ctx.readFile(file)
    // 基線から枠の上端を、svg-out と同じくフォントの実際の高さで求める（測れなければ見積もる）
    const textMetrics = await canvasTextMetrics()
    let imported
    try {
      imported = convertSvgFile(bytes, base, textMetrics)
    } catch (error) {
      if (error instanceof Error && /^Svg/.test(error.name)) throw new UsageError(`${file}: ${error.message}`)
      throw error
    }
    let created: NodeId = ''
    // data URI の <image> から作った画像もドキュメントに足す。同じ id のものは中身も同じなので、あるものはそのまま使う
    const assets = imported.fragment.assets
    session.applyDocument((doc) => {
      const placed = updatePage(doc, session.page.id, (page) => {
        const result = placeSvgFragment(page, imported, parentId, at, { id, name: option(step, 'name') })
        created = result.id
        return result.page
      })
      return Object.keys(assets).length === 0 ? placed : { ...placed, assets: { ...assets, ...placed.assets } }
    })
    session.last = [created]
    for (const { label, count } of imported.warnings) ctx.warn(`svg: ${file}: 表せないので置き換えるか読み飛ばしました: ${label}${count > 1 ? ` ×${count}` : ''}`)
  },
}

export const dup: Command = {
  name: 'dup',
  kind: 'edit',
  usage: 'dup ノード… [--offset 20]',
  summary: '複製する。複製は元から右下へ offset ずらして置き、「@」で指せる',
  run({ session }, step) {
    checkStep(step, { options: ['offset'] })
    const ids = session.resolveAll(step.positionals)
    const offset = numberOption(step, 'offset') ?? 20
    const fragment = copyFragment(session.page, session.document.assets, ids)
    let created: NodeId[] = []
    const pageId = session.page.id
    session.applyDocument((doc) => {
      const result = pasteIntoPage(doc, pageId, fragment, offset)
      created = result.ids
      return result.document
    })
    session.last = created
  },
}
