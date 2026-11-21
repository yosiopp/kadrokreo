import type { Point } from './geometry.ts'
import type { Vertex } from './path.ts'

// SVG の path の d を、kadrokreo の頂点（Vertex、制御点は位置で持つ）の並びに直す。
// M / L / H / V / C / S / Q / T / A / Z（小文字の相対座標も）を受け付ける。
// 2 次の曲線（Q / T）は同じ形の 3 次に、円弧（A）は 90° 以下に分けた 3 次の曲線で近似する。
// CLI の `add path --d` と、SVG の取り込み（予定）が使う。transform は呼び出し側で mapVertices をかける。

/** 1 つの輪郭（M から次の M まで）。kadrokreo のパスは輪郭を 1 つだけ持つ */
export type Subpath = { vertices: Vertex[]; closed: boolean }

export class PathDataError extends Error {
  override name = 'PathDataError'
}

/** 引数の数（A は 7、C は 6 …）。H / V は 1 */
const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }

export function parsePathData(d: string): Subpath[] {
  const tokens = tokenize(d)
  const subpaths: Subpath[] = []
  let current: Subpath | null = null
  let point: Point = { x: 0, y: 0 }
  let start: Point = { x: 0, y: 0 }
  // 直前の曲線の 2 つ目の制御点（S / T の折り返しに使う）
  let lastCubic: Point | null = null
  let lastQuad: Point | null = null

  const last = (): Vertex => {
    if (!current) throw new PathDataError('パスが M で始まっていません')
    return current.vertices[current.vertices.length - 1]
  }
  const lineTo = (to: Point) => {
    if (!current) throw new PathDataError('パスが M で始まっていません')
    current.vertices.push({ ...to })
    point = to
  }
  const curveTo = (c1: Point, c2: Point, to: Point) => {
    last().out = c1
    current!.vertices.push({ ...to, in: c2 })
    point = to
  }

  let i = 0
  let command = ''
  while (i < tokens.length) {
    const token = tokens[i]
    if (typeof token === 'string') {
      command = token
      i++
    } else if (command === '') {
      throw new PathDataError('パスが M で始まっていません')
    } else if (command === 'Z' || command === 'z') {
      throw new PathDataError('Z のあとに数値があります')
    }
    const upper = command.toUpperCase()
    const relative = command !== upper
    const arity = ARITY[upper]
    if (arity === undefined) throw new PathDataError(`知らないコマンドです: ${command}`)

    if (upper === 'Z') {
      if (current) {
        current.closed = true
        // 最初の頂点に戻ってから閉じていれば、重なった頂点を 1 つにまとめる
        const vertices = current.vertices
        const end = vertices[vertices.length - 1]
        if (vertices.length > 1 && near(end, vertices[0])) {
          if (end.in) vertices[0].in = end.in
          vertices.pop()
        }
      }
      point = start
      current = null
      lastCubic = lastQuad = null
      continue
    }

    const args: number[] = []
    for (let k = 0; k < arity; k++) {
      const value = tokens[i + k]
      if (typeof value !== 'number') throw new PathDataError(`${command} の数値が足りません`)
      args.push(value)
    }
    i += arity
    const at = (x: number, y: number): Point => (relative ? { x: point.x + x, y: point.y + y } : { x, y })

    // Z の後に M がなければ、閉じた輪郭の始点から新しい輪郭を始める
    if (!current && upper !== 'M') {
      if (subpaths.length === 0) throw new PathDataError('パスが M で始まっていません')
      current = { vertices: [{ ...start }], closed: false }
      subpaths.push(current)
    }

    switch (upper) {
      case 'M': {
        const to = at(args[0], args[1])
        current = { vertices: [{ ...to }], closed: false }
        subpaths.push(current)
        point = start = to
        // 続く座標の組は L として扱う
        command = relative ? 'l' : 'L'
        lastCubic = lastQuad = null
        break
      }
      case 'L':
        lineTo(at(args[0], args[1]))
        lastCubic = lastQuad = null
        break
      case 'H':
        lineTo({ x: relative ? point.x + args[0] : args[0], y: point.y })
        lastCubic = lastQuad = null
        break
      case 'V':
        lineTo({ x: point.x, y: relative ? point.y + args[0] : args[0] })
        lastCubic = lastQuad = null
        break
      case 'C': {
        const c1 = at(args[0], args[1])
        const c2 = at(args[2], args[3])
        const to = at(args[4], args[5])
        curveTo(c1, c2, to)
        lastCubic = c2
        lastQuad = null
        break
      }
      case 'S': {
        const c1 = lastCubic ? reflect(lastCubic, point) : point
        const c2 = at(args[0], args[1])
        const to = at(args[2], args[3])
        curveTo(c1, c2, to)
        lastCubic = c2
        lastQuad = null
        break
      }
      case 'Q':
      case 'T': {
        const q: Point = upper === 'Q' ? at(args[0], args[1]) : lastQuad ? reflect(lastQuad, point) : point
        const to = upper === 'Q' ? at(args[2], args[3]) : at(args[0], args[1])
        const from = point
        curveTo(
          { x: from.x + ((q.x - from.x) * 2) / 3, y: from.y + ((q.y - from.y) * 2) / 3 },
          { x: to.x + ((q.x - to.x) * 2) / 3, y: to.y + ((q.y - to.y) * 2) / 3 },
          to,
        )
        lastQuad = q
        lastCubic = null
        break
      }
      case 'A': {
        const [rx, ry, rotation, large, sweep] = args
        if ((large !== 0 && large !== 1) || (sweep !== 0 && sweep !== 1)) throw new PathDataError('A のフラグは 0 か 1 です')
        const to = at(args[5], args[6])
        const curves = arcToCubics(point, to, rx, ry, rotation, large === 1, sweep === 1)
        // 半径が 0 の円弧は直線（SVG の決まり）。始点と終点が同じなら何も描かない
        if (curves.length === 0 && !near(point, to)) lineTo(to)
        for (const [c1, c2, end] of curves) curveTo(c1, c2, end)
        lastCubic = lastQuad = null
        break
      }
    }
  }
  return subpaths
}

function near(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9
}

function reflect(control: Point, about: Point): Point {
  return { x: about.x * 2 - control.x, y: about.y * 2 - control.y }
}

function tokenize(d: string): (string | number)[] {
  const tokens: (string | number)[] = []
  const pattern = /([MLHVCSQTAZmlhvcsqtaz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)|([\s,]+)|(.)/g
  // A のフラグは区切りなしで続けて書ける（"a1 1 0 00 10 10"）ので、A の引数の 4・5 番目は 1 文字ずつ読む
  let command = ''
  let index = 0
  for (const match of d.matchAll(pattern)) {
    const [text, letter, number, , other] = match
    if (other !== undefined) throw new PathDataError(`読めない文字があります: ${other}`)
    if (letter !== undefined) {
      tokens.push(letter)
      command = letter.toUpperCase()
      index = 0
    } else if (number !== undefined) {
      if (command === 'A' && (index % 7 === 3 || index % 7 === 4) && /^[01]/.test(text) && text.length > 1) {
        // フラグ 1 文字と、その後ろに続く数値に分ける
        tokens.push(Number(text[0]))
        index++
        const rest = text.slice(1)
        if (command === 'A' && index % 7 === 4 && /^[01]/.test(rest)) {
          tokens.push(Number(rest[0]))
          index++
          if (rest.length > 1) {
            tokens.push(Number(rest.slice(1)))
            index++
          }
        } else {
          tokens.push(Number(rest))
          index++
        }
        continue
      }
      tokens.push(Number(text))
      index++
    }
  }
  return tokens
}

/**
 * SVG の円弧（端点で表したもの）を、90° 以下に分けた 3 次ベジェ曲線の [制御点 1, 制御点 2, 終点] の並びにする。
 * 半径が 0 なら空（直線として扱う）。半径が足りなければ SVG の決まりどおり拡大する
 */
function arcToCubics(
  from: Point,
  to: Point,
  rxIn: number,
  ryIn: number,
  degrees: number,
  large: boolean,
  sweep: boolean,
): [Point, Point, Point][] {
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if (rx === 0 || ry === 0 || near(from, to)) return []
  const phi = (degrees * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  // 端点から中心を求める（SVG 1.1 の付録 F.6.5）
  const dx = (from.x - to.x) / 2
  const dy = (from.y - to.y) / 2
  const x1 = cos * dx + sin * dy
  const y1 = -sin * dx + cos * dy
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
  let factor = Math.sqrt(Math.max(0, numerator / denominator))
  if (large === sweep) factor = -factor
  const cx1 = (factor * rx * y1) / ry
  const cy1 = (-factor * ry * x1) / rx
  const cx = cos * cx1 - sin * cy1 + (from.x + to.x) / 2
  const cy = sin * cx1 + cos * cy1 + (from.y + to.y) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const theta = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
  if (!sweep && delta > 0) delta -= Math.PI * 2
  if (sweep && delta < 0) delta += Math.PI * 2

  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9))
  const step = delta / count
  // 単位円の弧を 3 次曲線で近似するときの制御点の長さ
  const k = (4 / 3) * Math.tan(step / 4)
  const map = (x: number, y: number): Point => ({ x: cx + rx * x * cos - ry * y * sin, y: cy + rx * x * sin + ry * y * cos })
  const curves: [Point, Point, Point][] = []
  for (let n = 0; n < count; n++) {
    const a = theta + step * n
    const b = a + step
    const c1 = map(Math.cos(a) - k * Math.sin(a), Math.sin(a) + k * Math.cos(a))
    const c2 = map(Math.cos(b) + k * Math.sin(b), Math.sin(b) - k * Math.cos(b))
    const end = n === count - 1 ? to : map(Math.cos(b), Math.sin(b))
    curves.push([c1, c2, end])
  }
  return curves
}
