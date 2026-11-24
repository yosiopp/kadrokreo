import type { Bounds, Point } from './geometry.ts'
import { type Vertex, pathFromPoints, pathPoints, roundCorners } from './path.ts'
import type { SceneNode, TextNode, TextPath } from './types.ts'

// テキストを線に沿わせる置き方（SVG の textPath と同じ）。描画（canvas/text.ts）・文字の形（textOutline.ts）が使い、
// SVG の書き出しは <textPath> に任せる（ブラウザも同じ決まりで置くので、同じ見た目になる）。決まり:
// - 文字（書記素のまとまり）ごとに送り幅を測り、送り幅の真ん中が線のどこに来るかで位置と向きを決める。基線を線に乗せる
// - 並べ始める位置は線の長さ × startOffset。行揃えは、その位置に並び全体の始まり・真ん中・終わりを合わせる（text-anchor）
// - 真ん中が線の外（始まりより前、終わりより後）に出た文字は描かない。閉じた線でも折り返さない（ブラウザの実装に合わせる）
// - 改行は空白として 1 行に並べる

/** 線に沿うテキストか。沿うテキストは折り返さず、枠は線を囲む矩形で、大きさは中身で決まらない */
export function isPathText(node: SceneNode): node is TextNode & { textPath: TextPath } {
  return node.type === 'text' && node.textPath !== null
}

/** 高さが中身で決まるテキスト（線に沿わないテキスト）。線に沿うテキストは図形と同じく縦横に伸縮する */
export function isFlowText(node: SceneNode): node is TextNode {
  return node.type === 'text' && node.textPath === null
}

/** 線に沿わせて並べる文字列（改行は空白にする） */
export function pathTextString(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ')
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

/** 1 つずつ置く文字のまとまり（書記素。結合文字や絵文字の並びを分けない） */
export function pathTextClusters(text: string): string[] {
  const line = pathTextString(text)
  return segmenter ? Array.from(segmenter.segment(line), (part) => part.segment) : Array.from(line)
}

/** 線に置いた 1 文字。index は clusters の番号、x / y は基線の左端（ノードの座標系）、angle はその向き（ラジアン。右が 0 で時計回り） */
export type PlacedGlyph = { index: number; text: string; x: number; y: number; angle: number; advance: number }

/** 折れ線にした線。lengths[i] は始まりから points[i] までの長さ */
type Polyline = { points: Point[]; lengths: number[] }

/** 行揃えごとの、並びのどこを始まりの位置に合わせるか（paint.ts の alignFactor と同じ値。paint.ts がこのファイルを読むので写した） */
const ANCHOR = { left: 0, center: 0.5, right: 1 } as const

const polylines = new WeakMap<TextNode, Polyline>()

/** 線の頂点（ノードの座標系。角の丸めは曲線に直したもの） */
export function textPathVertices(node: Pick<TextNode, 'width' | 'height'> & { textPath: TextPath }): Vertex[] {
  return roundCorners(pathPoints({ width: node.width, height: node.height, points: node.textPath.points }), node.textPath.closed)
}

/** 曲線を折れ線にする細かさ（1 本の曲線を何本の線分にするか） */
const CURVE_STEPS = 48

function flatten(vertices: readonly Vertex[], closed: boolean): Polyline {
  const points: Point[] = []
  if (vertices.length === 0) return { points, lengths: [] }
  points.push({ x: vertices[0].x, y: vertices[0].y })
  const count = closed ? vertices.length : vertices.length - 1
  for (let i = 0; i < count; i++) {
    const a = vertices[i]
    const b = vertices[(i + 1) % vertices.length]
    if (!a.out && !b.in) {
      points.push({ x: b.x, y: b.y })
      continue
    }
    const c1 = a.out ?? a
    const c2 = b.in ?? b
    for (let step = 1; step <= CURVE_STEPS; step++) {
      const t = step / CURVE_STEPS
      const u = 1 - t
      points.push({
        x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
        y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
      })
    }
  }
  const lengths = [0]
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y))
  return { points, lengths }
}

function polylineOf(node: TextNode & { textPath: TextPath }): Polyline {
  const cached = polylines.get(node)
  if (cached) return cached
  const line = flatten(textPathVertices(node), node.textPath.closed)
  polylines.set(node, line)
  return line
}

/** 頂点の並び（角の丸めは曲線に直したもの）の長さ。SVG の取り込みで、長さで書いた startOffset を割合に直すのに使う */
export function verticesLength(vertices: readonly Vertex[], closed: boolean): number {
  const { lengths } = flatten(vertices, closed)
  return lengths.length === 0 ? 0 : lengths[lengths.length - 1]
}

/** 線の長さ（px） */
export function textPathLength(node: TextNode & { textPath: TextPath }): number {
  const { lengths } = polylineOf(node)
  return lengths.length === 0 ? 0 : lengths[lengths.length - 1]
}

/** 線の始まりから distance の位置と、そこでの向き（ラジアン）。線の外なら null */
function pointAt(line: Polyline, distance: number): { x: number; y: number; angle: number } | null {
  const { points, lengths } = line
  const total = lengths[lengths.length - 1] ?? 0
  if (points.length < 2 || distance < 0 || distance > total) return null
  // 長さで二分探索して、distance を含む線分を探す（長さ 0 の線分は飛ばす）
  let lo = 1
  let hi = points.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (lengths[mid] < distance) lo = mid + 1
    else hi = mid
  }
  // 長さ 0 の線分では向きが決まらないので、後ろ、なければ前の長さのある線分を使う
  let segment = lo
  while (segment < points.length - 1 && lengths[segment] === lengths[segment - 1]) segment++
  while (segment > 1 && lengths[segment] === lengths[segment - 1]) segment--
  const a = points[segment - 1]
  const b = points[segment]
  const span = lengths[segment] - lengths[segment - 1]
  const t = span > 0 ? Math.min(1, Math.max(0, (distance - lengths[segment - 1]) / span)) : 0
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) }
}

/**
 * 文字を線に置く。clusters の i 番目の文字は、並びの始まりから starts[i] の位置で始まり、送り幅は advances[i]（px）。
 * total は並び全体の幅（行揃えに使う）。starts は前の文字との字詰めを含む。線の外に出た文字は返さない
 */
export function placeOnPath(
  node: TextNode & { textPath: TextPath },
  clusters: readonly string[],
  starts: readonly number[],
  advances: readonly number[],
  total: number,
): PlacedGlyph[] {
  const line = polylineOf(node)
  const length = textPathLength(node)
  const origin = length * node.textPath.startOffset - total * ANCHOR[node.textAlign]
  const placed: PlacedGlyph[] = []
  clusters.forEach((text, i) => {
    const advance = advances[i]
    const at = pointAt(line, origin + starts[i] + advance / 2)
    if (!at) return
    const cos = Math.cos(at.angle)
    const sin = Math.sin(at.angle)
    placed.push({ index: i, text, x: at.x - (cos * advance) / 2, y: at.y - (sin * advance) / 2, angle: at.angle, advance })
  })
  return placed
}

/**
 * 線に沿うテキストが描かれうる範囲（ノードの座標系）。文字は線から上へ字の高さ、下へ字の下がりの分だけ出て、
 * 線の端の近くでは送り幅の半分だけ線の外に出るので、文字の大きさの分だけ枠を広げる
 */
export function pathTextBox(node: Pick<TextNode, 'width' | 'height' | 'fontSize'>): Bounds {
  const margin = node.fontSize
  return { x: -margin, y: -margin, width: node.width + margin * 2, height: node.height + margin * 2 }
}

/**
 * 頂点（ノードの親の座標系など、どこでもよい）から、テキストを沿わせる線と、それを囲む枠を作る。
 * 枠は線を囲む矩形（幅・高さは 1 以上）で、頂点はその枠に対する割合にする
 */
export function textPathFromVertices(vertices: readonly Vertex[], closed: boolean, startOffset = 0): Bounds & { textPath: TextPath } {
  const shape = pathFromPoints(vertices, closed)
  const width = Math.max(1, shape.width)
  const height = Math.max(1, shape.height)
  // 直線（幅か高さが 0）は pathFromPoints が 0 のまま返すので、割合を枠の大きさに合わせて直す
  const points = shape.points.map((point) => {
    const fixed = { ...point }
    if (shape.width === 0) fixed.x = 0
    if (shape.height === 0) fixed.y = 0
    return fixed
  })
  return { x: shape.x, y: shape.y, width, height, textPath: { points, closed, startOffset } }
}
