import { type Point, tidy } from './geometry.ts'
import { gradientLine, mixColor, paintColor, radialTransform } from './paint.ts'
import { type Vertex, cappedStroke, contoursData, isLine, pathOutlines } from './path.ts'
import type { Asset, ColorStop, ConicGradient, Paint, PathNode } from './types.ts'

// SVG の図形を書く処理。viewer の Dev モードの HTML（パス・直線の <svg>）と、SVG ファイルの書き出し（svgExport.ts）で共有する。
// 座標はどれもノードの座標系（枠の左上が原点）。

/** SVG の属性値・文字に入れる文字のエスケープ */
export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export type SvgPaintOptions = {
  /** 色の書き方（#rrggbb を受け取る）。HTML の出力は rgb / hsl にもする */
  color: (hex: string) => string
  /** 属性名を React の書き方（stopColor）にする */
  jsx?: boolean
}

/**
 * グラデーションの定義（linearGradient / radialGradient。角度のグラデーションは SVG にないので pattern で近似する）。size はノードの枠。
 * 中心と半径・向きはノードの座標系の値（userSpaceOnUse）で書くので、要素はノードの座標系で置くこと。
 * 塗りの不透明度は、どの色にも stop-opacity で付ける
 */
export function gradientDef(
  paint: Exclude<Paint, { type: 'solid' }>,
  size: { width: number; height: number },
  id: string,
  options: SvgPaintOptions,
): string {
  const { jsx = false } = options
  const opacity = paint.opacity < 1 ? ` ${jsx ? 'stopOpacity' : 'stop-opacity'}="${tidy(paint.opacity)}"` : ''
  const stops = paint.stops
    .map((stop) => `<stop offset="${tidy(stop.offset)}" ${jsx ? 'stopColor' : 'stop-color'}="${escapeXml(options.color(stop.color))}"${opacity}/>`)
    .join('')
  if (paint.type === 'conic') return conicPatternDef(paint, size, id, options)
  if (paint.type === 'radial') {
    // 半径 1 の円を、変換で枠に対する割合の（回した）楕円にする（描画と同じ）
    const matrix = radialTransform(paint, size)
    return `<radialGradient id="${escapeXml(id)}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="matrix(${matrix.map(tidy).join(' ')})">${stops}</radialGradient>`
  }
  const [from, to] = gradientLine(paint, size)
  return `<linearGradient id="${escapeXml(id)}" gradientUnits="userSpaceOnUse" x1="${tidy(from.x)}" y1="${tidy(from.y)}" x2="${tidy(to.x)}" y2="${tidy(to.y)}">${stops}</linearGradient>`
}

/** 角度のグラデーションを近似する扇形の数（3° ずつ） */
export const CONIC_WEDGES = 120

/**
 * 角度のグラデーションを、扇形を並べた pattern で近似する（SVG に conic のグラデーションはない）。
 * 扇形は 1 つずつ真ん中の角度の色で塗るので、色は 3° ずつの段になる。継ぎ目が見えないよう扇形を少し重ね、
 * 塗りの不透明度は重なりで濃くならないよう g にかける。線のはみ出しも覆えるよう、pattern は枠より外まで広げる。
 * 元の値は data-kdr-conic（中心 x y・向き・不透明度）と data-kdr-stops（位置 色,…）に残し、取り込み（editor/svg/convert.ts）で戻す
 */
function conicPatternDef(paint: ConicGradient, size: { width: number; height: number }, id: string, options: SvgPaintOptions): string {
  const { width, height } = size
  const margin = Math.max(width, height, 1)
  const cx = paint.cx * width
  const cy = paint.cy * height
  const box = { x: -margin, y: -margin, width: width + margin * 2, height: height + margin * 2 }
  const color = (hex: string) => escapeXml(options.color(hex))
  if (![cx, cy, box.width, box.height].every(Number.isFinite)) {
    return `<linearGradient id="${escapeXml(id)}"><stop offset="0" ${options.jsx ? 'stopColor' : 'stop-color'}="${color(paint.stops[0].color)}"/></linearGradient>`
  }
  // 中心からいちばん遠い角まで届く半径。扇形の弦が内側に入らないよう、少し余裕を取る
  const radius =
    Math.max(...[box.x, box.x + box.width].flatMap((x) => [box.y, box.y + box.height].map((y) => Math.hypot(x - cx, y - cy)))) * 1.01 + 1
  const step = (Math.PI * 2) / CONIC_WEDGES
  const start = ((paint.angle % 360) * Math.PI) / 180
  const overlap = step * 0.1
  const wedges = Array.from({ length: CONIC_WEDGES }, (_, i) => {
    const a0 = start + i * step - overlap
    const a1 = start + (i + 1) * step + overlap
    const point = (a: number) => `${tidy(cx + Math.cos(a) * radius)} ${tidy(cy + Math.sin(a) * radius)}`
    return `<path d="M${tidy(cx)} ${tidy(cy)} L${point(a0)} L${point(a1)} Z" fill="${color(stopColorAt(paint.stops, (i + 0.5) / CONIC_WEDGES))}"/>`
  }).join('')
  const group = paint.opacity < 1 ? `<g opacity="${tidy(paint.opacity)}">${wedges}</g>` : wedges
  // 取り込み直したときに角度のグラデーションへ戻せるよう、元の値を data 属性に残す（中心はこの座標系のピクセル、色は #rrggbb）
  const source =
    ` data-kdr-conic="${[cx, cy, paint.angle, paint.opacity].map(tidy).join(' ')}"` +
    ` data-kdr-stops="${escapeXml(paint.stops.map((stop) => `${tidy(stop.offset)} ${stop.color}`).join(','))}"`
  return (
    `<pattern id="${escapeXml(id)}"${source} patternUnits="userSpaceOnUse" ` +
    `x="${tidy(box.x)}" y="${tidy(box.y)}" width="${tidy(box.width)}" height="${tidy(box.height)}">${group}</pattern>`
  )
}

/** グラデーションの色の並びの、位置 t（0〜1）での色（#rrggbb。間は RGB で混ぜる） */
function stopColorAt(stops: readonly ColorStop[], t: number): string {
  const next = stops.findIndex((stop) => stop.offset > t)
  if (next === -1) return stops[stops.length - 1].color
  if (next === 0) return stops[0].color
  const a = stops[next - 1]
  const b = stops[next]
  return mixColor(a.color, b.color, b.offset === a.offset ? 0 : (t - a.offset) / (b.offset - a.offset))
}

export type PathSvgOptions = SvgPaintOptions & {
  /** グラデーションの id の頭。塗りは `${id}-fill`、線は `${id}-stroke` */
  id: string
  /** 塗る塗り（直線では使わない）。null なら塗らない */
  fill: Paint | null
  /** 引く線。null なら引かない */
  stroke: Paint | null
  /**
   * 単色・線の太さ・破線・塗る範囲の決め方も属性で書くか。HTML の出力は CSS（外側の svg のクラス）で付けるので false で、
   * そのときは単色の塗り・線は属性を書かず（CSS を受け継ぐ）、グラデーションだけを属性で指す。
   * SVG ファイルの書き出しは true で、要素だけで見た目が決まる
   */
  standalone: boolean
}

/** 直線とパスの SVG の要素と、それが使うグラデーションの定義 */
export type PathSvg = { defs: string[]; elements: string[] }

/**
 * 直線とパスの SVG の要素。直線は line、それ以外は path の d（曲線は C）で書く。角の丸めは曲線に直して書く（pathOutlines）。
 * 端の形があれば、描画と同じく線を矢印の分だけ短くし（cappedStroke）、端の図形は線の色で塗った多角形・円にする。
 * ただし standalone で両端が同じ丸・四角の端（か端なし）なら、stroke-linecap で書く（取り込みで端の形に戻る）。
 * 2 つ目以降の輪郭（穴など）は、塗りでは全部の輪郭を 1 つの d にまとめ、端の形は最初の輪郭にだけ付ける
 */
export function pathSvg(node: PathNode, options: PathSvgOptions): PathSvg {
  const { standalone } = options
  const outlines = pathOutlines(node)
  const points = outlines[0].vertices
  const others = outlines.slice(1)
  const defs: string[] = []
  const line = isLine(node)
  const fill = line ? null : options.fill
  const stroke = options.stroke

  /** 塗り・線の色の属性（単色は standalone のときだけ） */
  const paintDecls = (paint: Paint | null, role: 'fill' | 'stroke'): string[] => {
    if (paint === null) return []
    if (paint.type !== 'solid') {
      const id = `${options.id}-${role}`
      defs.push(gradientDef(paint, node, id, options))
      return [`${role}="url(#${escapeXml(id)})"`]
    }
    if (!standalone) return []
    const opacity = paint.opacity < 1 ? [`${role}-opacity="${tidy(paint.opacity)}"`] : []
    return [`${role}="${escapeXml(options.color(paint.color))}"`, ...opacity]
  }
  const fillDecls = paintDecls(fill, 'fill')
  const strokeDecls = paintDecls(stroke, 'stroke')
  // 線の形は standalone のときだけ属性で（HTML の出力は CSS）
  const strokeShape = standalone && stroke !== null
    ? [
        `stroke-width="${tidy(node.strokeWidth)}"`,
        ...(node.strokeDashes.length > 0 ? [`stroke-dasharray="${node.strokeDashes.map(tidy).join(' ')}"`] : []),
      ]
    : []
  const fillRule = standalone && fill !== null && node.fillRule === 'evenodd' ? ['fill-rule="evenodd"'] : []
  // standalone では、書かなかった塗り・線を「なし」にする（SVG の既定は黒で塗る）
  const noFill = standalone && fill === null && !line ? ['fill="none"'] : []
  const noStroke = standalone && stroke === null ? ['stroke="none"'] : []

  const attrs = (decls: readonly string[]) => decls.map((decl) => ` ${decl}`).join('')
  const lineElement = (ps: readonly Vertex[], extra: string) =>
    `<line x1="${tidy(ps[0].x)}" y1="${tidy(ps[0].y)}" x2="${tidy(ps[1].x)}" y2="${tidy(ps[1].y)}"${extra}/>`
  const pathElement = (ps: readonly Vertex[], isClosed: boolean, extra: string, rest = others) =>
    `<path d="${contoursData([{ vertices: [...ps], closed: isClosed }, ...rest])}"${extra}/>`

  const parts: string[] = []
  const hasCaps = !node.closed && stroke !== null && (node.startCap !== 'none' || node.endCap !== 'none')
  // 両端が同じ丸・四角なら、SVG の stroke-linecap がそのまま同じ形になる
  const lineCap = standalone && hasCaps && node.startCap === node.endCap && (node.startCap === 'round' || node.startCap === 'square')
    ? node.startCap
    : null
  if (!hasCaps || lineCap) {
    const capDecl = lineCap ? [`stroke-linecap="${lineCap}"`] : []
    const decls = [...fillDecls, ...fillRule, ...noFill, ...strokeDecls, ...strokeShape, ...capDecl, ...noStroke]
    parts.push(line ? lineElement(points, attrs(decls)) : pathElement(points, node.closed, attrs(decls)))
  } else {
    const shortened = cappedStroke(points, node)
    // 塗りは短くしない元の形で
    if (fill !== null) parts.push(pathElement(points, false, attrs(['stroke="none"', ...fillDecls, ...fillRule])))
    const strokeOnly = attrs(['fill="none"', ...strokeDecls, ...strokeShape])
    // standalone では、短くした線に元の形（全部の輪郭）を残し、端の図形と残りの輪郭に印を付ける。
    // 取り込み（editor/svg/convert.ts の kdrShape）が、端の形を持つ 1 つのパスに戻すため
    const original = standalone ? ` data-kdr-d="${contoursData([{ vertices: [...points], closed: false }, ...others])}"` : ''
    const mark = (part: string) => (standalone ? ` data-kdr-part="${part}"` : '')
    parts.push(
      line
        ? lineElement(shortened.line, attrs([...strokeDecls, ...strokeShape]) + original)
        : pathElement(shortened.line, false, strokeOnly + original, []),
    )
    if (others.length > 0) parts.push(`<path d="${contoursData(others)}"${strokeOnly}${mark('rest')}/>`)
    // 端の図形は線の色で塗る。グラデーションなら同じグラデーションで
    const strokeColor = stroke!
    const color = strokeColor.type === 'solid' || strokeDecls.length === 0
      ? escapeXml(options.color(paintColor(strokeColor)))
      : `url(#${escapeXml(`${options.id}-stroke`)})`
    const capOpacity = standalone && strokeColor.type === 'solid' && strokeColor.opacity < 1 ? ` fill-opacity="${tidy(strokeColor.opacity)}"` : ''
    for (const cap of shortened.caps) {
      parts.push(
        cap.kind === 'circle'
          ? `<circle cx="${tidy(cap.center.x)}" cy="${tidy(cap.center.y)}" r="${tidy(cap.radius)}" fill="${color}"${capOpacity} stroke="none"${mark('cap')}/>`
          : `<polygon points="${pointList(cap.points)}" fill="${color}"${capOpacity} stroke="none"${mark('cap')}/>`,
      )
    }
  }
  return { defs, elements: parts }
}

/** SVG の points 属性の値 */
function pointList(ps: readonly Point[]): string {
  return ps.map((point) => `${tidy(point.x)},${tidy(point.y)}`).join(' ')
}

/** 画像を埋め込む data URI */
export function dataUri(asset: Asset): string {
  let binary = ''
  // 引数の数に上限があるので、少しずつ文字列にする
  for (let i = 0; i < asset.bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...asset.bytes.subarray(i, i + 0x8000))
  }
  return `data:${asset.mime};base64,${btoa(binary)}`
}
