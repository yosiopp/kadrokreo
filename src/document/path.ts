import { type Bounds, type Point, tidy } from './geometry.ts'
import type { Cap, PathNode, PathPoint, SceneNode } from './types.ts'

/** 画面で呼び分けるノードの種類。直線はパスの 1 つだが、名前やアイコンは分ける */
export type NodeKind = SceneNode['type'] | 'line'

export function nodeKind(node: SceneNode): NodeKind {
  return isLine(node) ? 'line' : node.type
}

/** 直線（2 つの頂点を持つ、曲がっていない開いたパス）か。editor は端を直接動かすハンドルを出し、一覧では「直線」と呼ぶ */
export function isLine(node: SceneNode): boolean {
  return node.type === 'path' && node.points.length === 2 && !node.closed && node.contours.length === 0 && !node.points.some(hasControls)
}

function hasControls(point: PathPoint | Vertex): boolean {
  return point.in !== undefined || point.out !== undefined
}

/**
 * 頂点と、その制御点。in / out は制御点の位置そのもの（kdr の PathPoint と違い、頂点からのずれではない）。
 * 座標系は使う所しだい（ノード・親・ページ）。位置で持つので、座標の変換は 3 つの点に同じ変換をかけるだけで済む
 */
export type Vertex = Point & { in?: Point; out?: Point; radius?: number }

/**
 * 頂点の 3 つの点に同じ変換をかける。角の丸めの半径（px）はそのまま持ち越す
 * （使う所の変換は回転と平行移動だけなので、長さは変わらない）
 */
export function mapVertices(vertices: readonly Vertex[], transform: (point: Point) => Point): Vertex[] {
  return vertices.map((vertex) => {
    const mapped: Vertex = transform({ x: vertex.x, y: vertex.y })
    if (vertex.in) mapped.in = transform(vertex.in)
    if (vertex.out) mapped.out = transform(vertex.out)
    if (vertex.radius) mapped.radius = vertex.radius
    return mapped
  })
}

/** パスの頂点と制御点（ノードの座標系） */
export function pathPoints(path: Pick<PathNode, 'width' | 'height' | 'points'>): Vertex[] {
  const { width, height } = path
  return path.points.map((point) => {
    const vertex: Vertex = { x: point.x * width, y: point.y * height }
    if (point.in) vertex.in = { x: (point.x + point.in.x) * width, y: (point.y + point.in.y) * height }
    if (point.out) vertex.out = { x: (point.x + point.out.x) * width, y: (point.y + point.out.y) * height }
    if (point.radius) vertex.radius = point.radius
    return vertex
  })
}

/** 輪郭 1 つ分の頂点（Vertex）と、閉じているか */
export type Contour = { vertices: Vertex[]; closed: boolean }

type ContourSource = Pick<PathNode, 'width' | 'height' | 'points' | 'closed' | 'contours'>

/** パスのすべての輪郭の頂点と制御点（ノードの座標系）。先頭が最初の輪郭（points） */
export function pathContours(path: ContourSource): Contour[] {
  const { width, height } = path
  return [
    { vertices: pathPoints(path), closed: path.closed },
    ...path.contours.map((contour) => ({ vertices: pathPoints({ width, height, points: contour.points }), closed: contour.closed })),
  ]
}

/** すべての輪郭の描く形の頂点（角の丸めを曲線に直したもの）。先頭が最初の輪郭 */
export function pathOutlines(path: ContourSource): Contour[] {
  return pathContours(path).map((contour) => ({ vertices: roundCorners(contour.vertices, contour.closed), closed: contour.closed }))
}

/** パスの描く形の頂点（ノードの座標系）。角の丸めを曲線に直したもの。描画・当たり判定・SVG の出力が使う */
export function pathOutline(path: Pick<PathNode, 'width' | 'height' | 'points' | 'closed'>): Vertex[] {
  return roundCorners(pathPoints(path), path.closed)
}

/**
 * 角の丸め（radius）を持つ頂点を、丸めの始まりと終わりの 2 つの頂点と、円弧に近い 3 次ベジェ曲線に置き換える。
 * 丸めるのは、制御点を持たず、両側の辺が直線の頂点だけ（開いたパスの両端は丸めない）。
 * 丸めが辺から取る長さは、両側の辺のそれぞれ半分までに抑える（隣も丸めていてもぶつからない）。返す頂点は radius を持たない
 */
export function roundCorners(vertices: readonly Vertex[], closed: boolean): Vertex[] {
  if (!vertices.some((vertex) => vertex.radius)) return [...vertices]
  const count = vertices.length
  const result: Vertex[] = []
  vertices.forEach((vertex, i) => {
    const { radius, ...plain } = vertex
    const prev = i > 0 ? vertices[i - 1] : closed ? vertices[count - 1] : null
    const next = i < count - 1 ? vertices[i + 1] : closed ? vertices[0] : null
    const corner = roundCorner(vertex, prev, next, radius ?? 0)
    if (corner) result.push(...corner)
    else result.push(plain)
  })
  return result
}

/** 1 つの角を丸めた 2 つの頂点。丸められなければ null */
function roundCorner(vertex: Vertex, prev: Vertex | null, next: Vertex | null, radius: number): [Vertex, Vertex] | null {
  if (radius <= 0 || !prev || !next || hasControls(vertex) || prev.out || next.in) return null
  const a = { x: prev.x - vertex.x, y: prev.y - vertex.y }
  const b = { x: next.x - vertex.x, y: next.y - vertex.y }
  const la = Math.hypot(a.x, a.y)
  const lb = Math.hypot(b.x, b.y)
  if (la === 0 || lb === 0) return null
  const ua = { x: a.x / la, y: a.y / la }
  const ub = { x: b.x / lb, y: b.y / lb }
  // 2 つの辺のなす角。一直線（180°）や折り返し（0°）は丸めない
  const angle = Math.acos(Math.max(-1, Math.min(1, ua.x * ub.x + ua.y * ub.y)))
  if (angle < 1e-6 || Math.PI - angle < 1e-6) return null
  const half = Math.tan(angle / 2)
  // 頂点から丸めの始まりまでの長さ。両側の辺の半分までに抑え、その分だけ半径も小さくする
  const along = Math.min(radius / half, la / 2, lb / 2)
  const r = along * half
  // 円弧を 1 本の 3 次ベジェで近似する。制御点の長さは 4/3 · tan(弧の角 / 4) · r
  const handle = (4 / 3) * Math.tan((Math.PI - angle) / 4) * r
  const start = { x: vertex.x + ua.x * along, y: vertex.y + ua.y * along }
  const end = { x: vertex.x + ub.x * along, y: vertex.y + ub.y * along }
  return [
    { ...start, out: { x: start.x - ua.x * handle, y: start.y - ua.y * handle } },
    { ...end, in: { x: end.x - ub.x * handle, y: end.y - ub.y * handle } },
  ]
}

/**
 * 頂点の並びから、それを囲む枠と、枠に対する割合で表した頂点を作る。
 * 枠は曲線そのもの（角の丸めを含む）を囲む矩形（制御点は含めない）。閉じた形は最後から最初へ戻る辺も囲むので closed が要る
 */
export function pathFromPoints(vertices: readonly Vertex[], closed = false): Bounds & Pick<PathNode, 'points'> {
  // 枠は描く形（角を丸めたもの）を囲む
  const box = pathBounds(roundCorners(vertices, closed), closed)
  const { x, y, width, height } = box
  const fx = (value: number) => (width === 0 ? 0 : value / width)
  const fy = (value: number) => (height === 0 ? 0 : value / height)
  // 水平・垂直に並んだ頂点でも、枠がつぶれないようにする。直線（曲がっていない 2 つの頂点）は幅や高さが 0 のままでよい
  const straightLine = vertices.length === 2 && !closed && !vertices.some(hasControls)
  return {
    x,
    y,
    width: straightLine ? width : Math.max(1, width),
    height: straightLine ? height : Math.max(1, height),
    points: vertices.map((vertex) => {
      const point: PathPoint = { x: fx(vertex.x - x), y: fy(vertex.y - y) }
      if (vertex.in) point.in = { x: fx(vertex.in.x - vertex.x), y: fy(vertex.in.y - vertex.y) }
      if (vertex.out) point.out = { x: fx(vertex.out.x - vertex.x), y: fy(vertex.out.y - vertex.y) }
      if (vertex.radius) point.radius = vertex.radius
      return point
    }),
  }
}

/**
 * いくつもの輪郭から、すべてを囲む枠と、枠に対する割合で表した頂点を作る。先頭の輪郭が points、残りが contours になる。
 * 輪郭が 1 つなら pathFromPoints と同じ
 */
export function pathFromContours(contours: readonly Contour[]): Bounds & Pick<PathNode, 'points' | 'closed' | 'contours'> {
  const [first, ...rest] = contours
  if (rest.length === 0) return { ...pathFromPoints(first.vertices, first.closed), closed: first.closed, contours: [] }
  const box = unionBox(contours.map((contour) => pathBounds(roundCorners(contour.vertices, contour.closed), contour.closed)))
  const width = Math.max(1, box.width)
  const height = Math.max(1, box.height)
  const ratios = (vertices: readonly Vertex[]): PathPoint[] =>
    vertices.map((vertex) => {
      const point: PathPoint = { x: (vertex.x - box.x) / width, y: (vertex.y - box.y) / height }
      if (vertex.in) point.in = { x: (vertex.in.x - vertex.x) / width, y: (vertex.in.y - vertex.y) / height }
      if (vertex.out) point.out = { x: (vertex.out.x - vertex.x) / width, y: (vertex.out.y - vertex.y) / height }
      if (vertex.radius) point.radius = vertex.radius
      return point
    })
  return {
    x: box.x,
    y: box.y,
    width,
    height,
    points: ratios(first.vertices),
    closed: first.closed,
    contours: rest.map((contour) => ({ points: ratios(contour.vertices), closed: contour.closed })),
  }
}

function unionBox(boxes: readonly Bounds[]): Bounds {
  const x = Math.min(...boxes.map((box) => box.x))
  const y = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return { x, y, width: right - x, height: bottom - y }
}

/** 頂点から頂点への 1 本の辺。curved でなければ c1 / c2 は両端と同じ点 */
export type Segment = { from: Point; c1: Point; c2: Point; to: Point; curved: boolean }

/** 辺の並び。閉じた形は最後の頂点から最初の頂点へ戻る辺も含む */
export function pathSegments(vertices: readonly Vertex[], closed: boolean): Segment[] {
  const segments: Segment[] = []
  const count = closed ? vertices.length : vertices.length - 1
  for (let i = 0; i < count; i++) {
    const a = vertices[i]
    const b = vertices[(i + 1) % vertices.length]
    const from = { x: a.x, y: a.y }
    const to = { x: b.x, y: b.y }
    segments.push({ from, c1: a.out ?? from, c2: b.in ?? to, to, curved: a.out !== undefined || b.in !== undefined })
  }
  return segments
}

/** 3 次ベジェ曲線の t（0〜1）の位置 */
export function segmentAt(segment: Segment, t: number): Point {
  const { from, c1, c2, to } = segment
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return { x: a * from.x + b * c1.x + c * c2.x + d * to.x, y: a * from.y + b * c1.y + c * c2.y + d * to.y }
}

/** t で 2 つに分けた曲線（de Casteljau）。形は変わらない */
export function splitSegment(segment: Segment, t: number): [Segment, Segment] {
  const { from, c1, c2, to } = segment
  const lerp = (p: Point, q: Point) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
  const p01 = lerp(from, c1)
  const p12 = lerp(c1, c2)
  const p23 = lerp(c2, to)
  const p012 = lerp(p01, p12)
  const p123 = lerp(p12, p23)
  const mid = lerp(p012, p123)
  const curved = segment.curved
  return [
    { from, c1: curved ? p01 : from, c2: curved ? p012 : mid, to: mid, curved },
    { from: mid, c1: curved ? p123 : mid, c2: curved ? p23 : to, to, curved },
  ]
}

/** 1 本の辺の曲線そのものを囲む矩形。曲線の向きが軸に平行になる点（微分が 0 の点）を両端に加えて囲む */
export function segmentBounds(segment: Segment): Bounds {
  const xs = [segment.from.x, segment.to.x]
  const ys = [segment.from.y, segment.to.y]
  if (segment.curved) {
    for (const t of extremes(segment.from.x, segment.c1.x, segment.c2.x, segment.to.x)) xs.push(segmentAt(segment, t).x)
    for (const t of extremes(segment.from.y, segment.c1.y, segment.c2.y, segment.to.y)) ys.push(segmentAt(segment, t).y)
  }
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/** 1 つの軸の 3 次ベジェ曲線の微分が 0 になる t（0〜1 の間だけ） */
function extremes(p0: number, p1: number, p2: number, p3: number): number[] {
  // B'(t) / 3 = a t² + b t + c
  const a = -p0 + 3 * p1 - 3 * p2 + p3
  const b = 2 * (p0 - 2 * p1 + p2)
  const c = p1 - p0
  const roots: number[] = []
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b)
  } else {
    const discriminant = b * b - 4 * a * c
    if (discriminant >= 0) {
      const sqrt = Math.sqrt(discriminant)
      roots.push((-b + sqrt) / (2 * a), (-b - sqrt) / (2 * a))
    }
  }
  return roots.filter((t) => t > 0 && t < 1)
}

/** 頂点の並びが描く線そのものを囲む矩形（制御点は含めない） */
export function pathBounds(vertices: readonly Vertex[], closed: boolean): Bounds {
  const boxes = pathSegments(vertices, closed).map(segmentBounds)
  if (boxes.length === 0) return { x: vertices[0]?.x ?? 0, y: vertices[0]?.y ?? 0, width: 0, height: 0 }
  const x = Math.min(...boxes.map((box) => box.x))
  const y = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  return { x, y, width: right - x, height: bottom - y }
}

/**
 * 曲線を細かい折れ線に直した頂点の並び（当たり判定用）。閉じた形でも最初の頂点を最後に繰り返さない。
 * 曲線は制御点を結んだ長さに応じて分ける（6px ごと、4〜64 分割）
 */
export function flattenPath(vertices: readonly Vertex[], closed: boolean): Point[] {
  const points: Point[] = []
  for (const segment of pathSegments(vertices, closed)) {
    points.push(segment.from)
    if (!segment.curved) continue
    const { from, c1, c2, to } = segment
    const length = Math.hypot(c1.x - from.x, c1.y - from.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(to.x - c2.x, to.y - c2.y)
    const steps = Math.min(64, Math.max(4, Math.ceil(length / 6)))
    for (let k = 1; k < steps; k++) points.push(segmentAt(segment, k / steps))
  }
  if (!closed && vertices.length > 0) {
    const last = vertices[vertices.length - 1]
    points.push({ x: last.x, y: last.y })
  }
  return points
}

/** 輪郭を描く先。CanvasRenderingContext2D と Path2D がこの形を持つ */
export type PathSink = {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void
  closePath(): void
}

/** 頂点の並びの輪郭をなぞる（beginPath は呼ばない） */
export function tracePath(sink: PathSink, vertices: readonly Vertex[], closed: boolean): void {
  if (vertices.length === 0) return
  sink.moveTo(vertices[0].x, vertices[0].y)
  const segments = pathSegments(vertices, closed)
  segments.forEach((segment, i) => {
    const closing = closed && i === segments.length - 1
    if (segment.curved) {
      sink.bezierCurveTo(segment.c1.x, segment.c1.y, segment.c2.x, segment.c2.y, segment.to.x, segment.to.y)
    } else if (!closing) {
      sink.lineTo(segment.to.x, segment.to.y)
    }
  })
  if (closed) sink.closePath()
}

/** SVG の path の d（M / L / C / Z）。数値は小数 2 桁まで */
export function pathData(vertices: readonly Vertex[], closed: boolean): string {
  const parts: string[] = []
  const n = (value: number) => String(tidy(value))
  const sink: PathSink = {
    moveTo: (x, y) => parts.push(`M${n(x)} ${n(y)}`),
    lineTo: (x, y) => parts.push(`L${n(x)} ${n(y)}`),
    bezierCurveTo: (c1x, c1y, c2x, c2y, x, y) => parts.push(`C${[c1x, c1y, c2x, c2y, x, y].map(n).join(' ')}`),
    closePath: () => parts.push('Z'),
  }
  tracePath(sink, vertices, closed)
  return parts.join(' ')
}

/** いくつもの輪郭をつないだ SVG の path の d */
export function contoursData(contours: readonly Contour[]): string {
  return contours.map((contour) => pathData(contour.vertices, contour.closed)).filter((d) => d !== '').join(' ')
}

/** 端の印（矢印・丸・ひし形）の大きさ。capSize が 0 なら線の太さから決める（細い線でも見えるように太さの 4 倍、最小 10） */
export function capMarkerSize(style: { strokeWidth: number; capSize: number }): number {
  return style.capSize > 0 ? style.capSize : Math.max(style.strokeWidth * 4, 10)
}

/** 端の印か（大きさ capSize を持つもの） */
export function isMarkerCap(cap: Cap): boolean {
  return cap === 'arrow' || cap === 'circle' || cap === 'diamond'
}

/** 端の形が、線の端からどれだけ外へ張り出しうるか（描く範囲を見積もるのに使う） */
export function capReach(style: { strokeWidth: number; capSize: number; startCap: Cap; endCap: Cap; closed: boolean }): number {
  if (style.closed) return 0
  const caps = [style.startCap, style.endCap]
  if (caps.some(isMarkerCap)) return Math.max(capMarkerSize(style), style.strokeWidth / 2)
  // 四角は対角の分だけ外へ出る
  if (caps.includes('square')) return (style.strokeWidth / 2) * Math.SQRT2
  return style.strokeWidth / 2
}

/** 端の形として塗る図形。polygon は頂点の並び、circle は中心と半径 */
export type CapShape = { kind: 'polygon'; points: Point[] } | { kind: 'circle'; center: Point; radius: number }

/**
 * 端の形を付けた線の形。line は線として引く頂点（線の端は切りっぱなしで引く）、caps は端に塗る図形（線の色で塗る）。
 * 矢印は先が端の位置にちょうど来るよう、線を矢印の分だけ短くする。端の辺が曲線なら、曲線のまま途中で切り、
 * 矢印は曲線の接線の向きに向ける。丸・ひし形の印は端を中心に置き、丸・四角の端は線の太さの円・正方形を端に置く。
 * 描画（canvas）と HTML の出力で同じ形にするためのもの。
 */
export function cappedStroke(
  vertices: readonly Vertex[],
  style: { strokeWidth: number; startCap: Cap; endCap: Cap; capSize: number },
): { line: Vertex[]; caps: CapShape[] } {
  const size = capMarkerSize(style)
  const line: Vertex[] = vertices.map((vertex) => ({ ...vertex }))
  const caps: CapShape[] = []
  const addCap = (cap: Cap, atEnd: boolean) => {
    if (cap === 'none') return
    const tipIndex = atEnd ? line.length - 1 : 0
    const neighborIndex = atEnd ? line.length - 2 : 1
    const tipVertex = line[tipIndex]
    const neighborVertex = line[neighborIndex]
    // 先を終わりに置いた向きの辺（始点なら逆向きにたどる）
    const tip = { x: tipVertex.x, y: tipVertex.y }
    const neighbor = { x: neighborVertex.x, y: neighborVertex.y }
    const segment: Segment = {
      from: neighbor,
      c1: (atEnd ? neighborVertex.out : neighborVertex.in) ?? neighbor,
      c2: (atEnd ? tipVertex.in : tipVertex.out) ?? tip,
      to: tip,
      curved: (atEnd ? neighborVertex.out ?? tipVertex.in : neighborVertex.in ?? tipVertex.out) !== undefined,
    }
    const chord = Math.hypot(tip.x - neighbor.x, tip.y - neighbor.y)
    // 先での接線の向き。制御点が先と重なっていれば、その手前の点から見る
    const toward = [segment.c2, segment.c1, segment.from].find((p) => Math.hypot(tip.x - p.x, tip.y - p.y) > 1e-9)
    if (chord === 0 || !toward) return
    const length = Math.hypot(tip.x - toward.x, tip.y - toward.y)
    const d = { x: (tip.x - toward.x) / length, y: (tip.y - toward.y) / length }
    // 先から見た、向きに沿った位置 along と横の位置 side の点
    const at = (along: number, side: number) => ({ x: tip.x + d.x * along - d.y * side, y: tip.y + d.y * along + d.x * side })
    const half = size * 0.4
    switch (cap) {
      case 'round': {
        // 線と重ならないよう、端より外側の半円だけ（不透明度が 1 未満でも重なった所が濃くならない）
        const w = style.strokeWidth / 2
        const steps = 24
        const points: Point[] = []
        for (let k = 0; k <= steps; k++) {
          const theta = -Math.PI / 2 + (Math.PI * k) / steps
          points.push(at(Math.cos(theta) * w, Math.sin(theta) * w))
        }
        caps.push({ kind: 'polygon', points })
        return
      }
      case 'square': {
        const w = style.strokeWidth / 2
        caps.push({ kind: 'polygon', points: [at(0, -w), at(w, -w), at(w, w), at(0, w)] })
        return
      }
      case 'circle':
        caps.push({ kind: 'circle', center: tip, radius: half })
        return
      case 'diamond':
        caps.push({ kind: 'polygon', points: [at(size / 2, 0), at(0, half), at(-size / 2, 0), at(0, -half)] })
        return
      case 'arrow':
        break
    }
    const inset = Math.min(size * 0.8, chord)
    if (!segment.curved) {
      line[tipIndex] = { ...tipVertex, x: tip.x - d.x * inset, y: tip.y - d.y * inset }
    } else {
      // 先から inset だけ離れた曲線上の点を探し、そこまでの曲線に切り詰める
      let lo = 0
      let hi = 1
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2
        const p = segmentAt(segment, mid)
        if (Math.hypot(tip.x - p.x, tip.y - p.y) > inset) lo = mid
        else hi = mid
      }
      const [kept] = splitSegment(segment, lo)
      line[neighborIndex] = { ...neighborVertex, [atEnd ? 'out' : 'in']: kept.c1 }
      line[tipIndex] = { ...tipVertex, x: kept.to.x, y: kept.to.y, [atEnd ? 'in' : 'out']: kept.c2 }
    }
    caps.push({ kind: 'polygon', points: [tip, at(-size, half), at(-size, -half)] })
  }
  if (line.length >= 2) {
    addCap(style.startCap, false)
    addCap(style.endCap, true)
  }
  return { line, caps }
}
