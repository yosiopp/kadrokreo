import { type Bounds, type Matrix, type Point, type Size, getWorldMatrix, normalizeAngle, transformRect, unionBounds } from './geometry.ts'
import { capReach, flattenPath, pathOutlines } from './path.ts'
import type { Blur, CornerRadius, Effect, ImageNode, LinearGradient, NodeId, Paint, PathNode, RadialGradient, Scene, Shadow, Style, TextNode } from './types.ts'

// 塗り（Paint）の配列を読む関数。配列は先頭が一番下なので、いちばん上に見えるのは最後の要素

/** いちばん上の塗り。なければ null */
function topPaint(paints: readonly Paint[]): Paint | null {
  return paints.length === 0 ? null : paints[paints.length - 1]
}

/** いちばん上の塗りが単色ならその色。グラデーションや塗りなしなら null */
export function solidColor(paints: readonly Paint[]): string | null {
  const paint = topPaint(paints)
  return paint?.type === 'solid' ? paint.color : null
}

/** グラデーションか（色の位置を持つか） */
export function isGradient(paint: Paint): paint is Exclude<Paint, { type: 'solid' }> {
  return paint.type !== 'solid'
}

/** 塗りの代表の色。単色ならその色、グラデーションなら最初の色 */
export function paintColor(paint: Paint): string {
  return paint.type === 'solid' ? paint.color : paint.stops[0].color
}

/** グラデーションの色を Canvas・CSS の色の文字列にする。不透明なら #rrggbb のまま、透明度があれば rgba() */
export function stopCssColor(stop: { color: string; opacity: number }): string {
  if (stop.opacity >= 1) return stop.color
  const channel = (i: number) => parseInt(stop.color.slice(1 + i * 2, 3 + i * 2), 16)
  return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${Math.round(stop.opacity * 1000) / 1000})`
}

/** 2 つの #rrggbb を t（0 なら a、1 なら b）の割合で混ぜた色（RGB で混ぜる）。既定は中間 */
export function mixColor(a: string, b: string, t = 0.5): string {
  const channel = (color: string, i: number) => parseInt(color.slice(1 + i * 2, 3 + i * 2), 16)
  return `#${[0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t).toString(16).padStart(2, '0')).join('')}`
}

/** 単色の塗り（表示する、描画モードは通常） */
export function solidPaint(color: string, opacity = 1): Paint {
  return { type: 'solid', color, opacity, visible: true, blendMode: 'normal' }
}

/** 単色 1 つだけの塗り。色が null なら塗りなし */
export function solid(color: string | null): Paint[] {
  return color === null ? [] : [solidPaint(color)]
}

/** 線を引くか（表示している線の塗りがあり、太さが 0 でない） */
export function hasStroke(style: Pick<Style, 'strokes' | 'strokeWidth'>): boolean {
  return style.strokeWidth > 0 && style.strokes.some((stroke) => stroke.visible)
}

/** 表示している塗り・効果だけ。全部表示していれば同じ配列を返す */
export function shownPaints<T extends { visible: boolean }>(list: readonly T[]): T[] {
  return list.every((item) => item.visible) ? (list as T[]) : list.filter((item) => item.visible)
}

/**
 * 隠した塗り・線・効果（visible が false）を除いたノード。描画と各出力（CSS・SVG・色の一覧）は、これを通してから読む。
 * 何も隠していなければ同じオブジェクトを返す
 */
export function withoutHidden<T extends object>(node: T): T {
  const lists = node as { fills?: Paint[]; strokes?: Paint[]; effects?: Effect[] }
  const hidden = (list: readonly { visible: boolean }[] | undefined) => list !== undefined && list.some((item) => !item.visible)
  if (!hidden(lists.fills) && !hidden(lists.strokes) && !hidden(lists.effects)) return node
  const out: Record<string, unknown> = { ...(node as Record<string, unknown>) }
  for (const key of ['fills', 'strokes', 'effects'] as const) {
    const list = lists[key]
    if (list !== undefined) out[key] = shownPaints<{ visible: boolean }>(list)
  }
  return out as T
}

/** 影の効果か（ぼかしでない） */
export function isShadow(effect: Effect): effect is Shadow {
  return effect.type === 'drop-shadow' || effect.type === 'inner-shadow'
}

/** 落ち影と内側の影に分ける（ぼかしは入らない） */
export function splitEffects(effects: readonly Effect[]): { drop: Shadow[]; inner: Shadow[] } {
  return {
    drop: effects.filter((effect): effect is Shadow => effect.type === 'drop-shadow'),
    inner: effects.filter((effect): effect is Shadow => effect.type === 'inner-shadow'),
  }
}

/**
 * ぼかしの効果（type の種類）をまとめた 1 つのぼかしの半径。なければ 0。
 * ガウスぼかしを重ねると標準偏差は 2 乗の和の平方根になるので、同じ種類が 2 つ以上あればそうまとめる
 */
export function blurRadius(effects: readonly Effect[], type: Blur['type']): number {
  let sum = 0
  for (const effect of effects) if (effect.type === type) sum += effect.blur * effect.blur
  return Math.sqrt(sum)
}

/**
 * 円形のグラデーションの、半径 1 の円を楕円に写す変換（ノードの座標系へ）。横・縦の半径に伸ばしてから angle だけ回し、中心へ動かす。
 * 描画（canvas）と SVG の gradientTransform で同じ楕円にする
 */
export function radialTransform(paint: Pick<RadialGradient, 'cx' | 'cy' | 'rx' | 'ry' | 'angle'>, size: Size): Matrix {
  const rx = paint.rx * size.width
  const ry = paint.ry * size.height
  // 極端に大きい角度でラジアンが Infinity にならないよう、先に 1 周に収める
  const radians = ((paint.angle % 360) * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  // 0 のとき -0 や 1e-17 が混ざらないよう、回さない向きはそのまま
  if (paint.angle % 360 === 0) return [rx, 0, 0, ry, paint.cx * size.width, paint.cy * size.height]
  return [rx * cos, rx * sin, -ry * sin, ry * cos, paint.cx * size.width, paint.cy * size.height]
}

/**
 * 円形のグラデーションの焦点を、単位円の中（上を含む）に収めて小数 4 桁にしたもの。円の外なら円の上に寄せる。
 * 丸めで円の外に出るとき（読み込みで拒まれる）だけ、切り捨てる
 */
export function fitFocus(point: Point): { fx: number; fy: number } {
  const length = Math.hypot(point.x, point.y)
  const x = length > 1 ? point.x / length : point.x
  const y = length > 1 ? point.y / length : point.y
  const rounded = { fx: Math.round(x * 10000) / 10000 + 0, fy: Math.round(y * 10000) / 10000 + 0 }
  if (rounded.fx ** 2 + rounded.fy ** 2 <= 1 + 1e-9) return rounded
  return { fx: Math.trunc(x * 10000) / 10000 + 0, fy: Math.trunc(y * 10000) / 10000 + 0 }
}

/**
 * 円形のグラデーションの焦点（楕円を単位円に写した座標）。描画用に、円のちょうど上なら少しだけ内側に寄せる
 * （始まりの円が終わりの円に接すると、Canvas はその外側を塗らないため）
 */
export function radialFocus(paint: Pick<RadialGradient, 'fx' | 'fy'>): Point {
  const length = Math.hypot(paint.fx, paint.fy)
  const limit = 0.999
  return length > limit ? { x: (paint.fx / length) * limit, y: (paint.fy / length) * limit } : { x: paint.fx, y: paint.fy }
}

/** 直線状のグラデーションの始点と終点（ノードの座標系）。描画（canvas）と SVG の出力で同じ線にする */
export function gradientLine(paint: Pick<LinearGradient, 'x1' | 'y1' | 'x2' | 'y2'>, size: Size): [Point, Point] {
  return [
    { x: paint.x1 * size.width, y: paint.y1 * size.height },
    { x: paint.x2 * size.width, y: paint.y2 * size.height },
  ]
}

/**
 * 向き（度）だけを決めたときの、直線状のグラデーションの始点と終点（ノードの座標系）。枠の中心を通る angle の向きの線で、
 * 長さは枠の角がちょうど両端の色になる長さ（CSS の linear-gradient の角度と同じ線）
 */
export function angleLine(angle: number, size: Size): [Point, Point] {
  const radians = (angle * Math.PI) / 180
  const dx = Math.cos(radians)
  const dy = Math.sin(radians)
  const half = (Math.abs(size.width * dx) + Math.abs(size.height * dy)) / 2
  const cx = size.width / 2
  const cy = size.height / 2
  return [
    { x: cx - dx * half, y: cy - dy * half },
    { x: cx + dx * half, y: cy + dy * half },
  ]
}

/** 向き（度）だけを決めた直線状のグラデーションの始点・終点（枠に対する割合）。幅や高さが 0 の向きは中央にする */
export function linearFromAngle(angle: number, size: Size): Pick<LinearGradient, 'x1' | 'y1' | 'x2' | 'y2'> {
  const [from, to] = angleLine(angle, size)
  const ratio = (value: number, length: number) => (length > 0 ? tidyRatio(value / length) : 0.5)
  return { x1: ratio(from.x, size.width), y1: ratio(from.y, size.height), x2: ratio(to.x, size.width), y2: ratio(to.y, size.height) }
}

/** 直線状のグラデーションの向き（度。-180 より大きく 180 以下）。始点と終点が重なっていれば 0 */
export function linearAngle(paint: Pick<LinearGradient, 'x1' | 'y1' | 'x2' | 'y2'>, size: Size): number {
  const [from, to] = gradientLine(paint, size)
  if (from.x === to.x && from.y === to.y) return 0
  return normalizeAngle(Math.round(((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI) * 100) / 100)
}

/** 始点・終点が、向きだけを決めたときの線（linearFromAngle）と同じか */
export function isAngleLine(paint: Pick<LinearGradient, 'x1' | 'y1' | 'x2' | 'y2'>, size: Size): boolean {
  const line = linearFromAngle(linearAngle(paint, size), size)
  return (['x1', 'y1', 'x2', 'y2'] as const).every((key) => Math.abs(line[key] - paint[key]) < 1e-3)
}

/** 割合を小数 6 桁に（計算の端数を残さない。向きに直したとき 0.01° もずれない桁） */
function tidyRatio(value: number): number {
  return Math.round(value * 1e6) / 1e6 + 0
}

/**
 * 画像を枠に置く矩形（ノードの座標系）。fit で決まる大きさを scale 倍し、余り（はみ出し）を positionX / positionY の割合で配る。
 * 枠からはみ出した分は描くときに切り落とす。描画（canvas）と CSS の object-view-box で同じ置き方にする
 */
export function imageRect(
  node: Pick<ImageNode, 'width' | 'height' | 'fit' | 'positionX' | 'positionY' | 'scale'>,
  image: Size,
): Bounds {
  const { width, height, fit, positionX, positionY, scale } = node
  let w = width
  let h = height
  if (fit !== 'stretch' && image.width > 0 && image.height > 0) {
    const ratio = (fit === 'cover' ? Math.max : Math.min)(width / image.width, height / image.height)
    w = image.width * ratio
    h = image.height * ratio
  }
  w *= scale
  h *= scale
  // + 0 で -0 を 0 にする
  return { x: (width - w) * positionX + 0, y: (height - h) * positionY + 0, width: w, height: h }
}

/** 角丸の 4 隅の半径（左上・右上・右下・左下） */
export function cornerRadii(radius: CornerRadius): [number, number, number, number] {
  return typeof radius === 'number' ? [radius, radius, radius, radius] : radius
}

/** 4 隅の半径を、揃っていれば数値 1 つにまとめる */
export function compactRadius(radii: readonly [number, number, number, number]): CornerRadius {
  return radii.every((r) => r === radii[0]) ? radii[0] : [...radii]
}

/** 4 隅の半径を、枠の短い辺の半分までに収める（描画・SVG・マスクの輪郭で同じ） */
export function clampedRadii(radius: CornerRadius, width: number, height: number): [number, number, number, number] {
  const max = Math.min(width / 2, height / 2)
  return cornerRadii(radius).map((r) => Math.max(0, Math.min(r, max))) as [number, number, number, number]
}

/** テキストの行揃えを、余った幅のうち行の左に置く割合に（左 0・中央 0.5・右 1） */
export function alignFactor(align: TextNode['textAlign']): number {
  return { left: 0, center: 0.5, right: 1 }[align]
}

/** 角丸があるか（どれかの隅が 0 より大きい） */
export function isRounded(radius: CornerRadius): boolean {
  return cornerRadii(radius).some((r) => r > 0)
}

/**
 * 書き出す範囲（PNG・SVG）。ノードの枠を囲む矩形に、線の太さ（枠の外へ出る半分。パスの端の形も）と、
 * 落ち影とレイヤーのぼかしのはみ出しを足す（既存のデザインツールの書き出しと同じく影まで含める）。線は枠の内側で太らせてから回す。
 * 影のずれは回転に従わないので、ページの向きで足す。ぼかしは半径の 1.5 倍（標準偏差の 3 倍）まで見る。
 * 中身を切り取らないフレームは、はみ出した子（とその影）も含める。隠したノード・効果は数えない。
 * 線の角のとがり（miter）と、テキストの枠からはみ出す行は含めない（書体の幅を測れないため）
 */
export function getPaintedBounds(scene: Scene, ids: readonly NodeId[], textLines?: TextLinesOf): Bounds | null {
  return unionBounds(ids.flatMap((id) => paintedBoundsOf(scene, id, textLines) ?? []))
}

/** テキストを描く行（canvas/text.ts の layoutText と同じ結果）。width は行の幅（px。分からなければ省く） */
export type TextLinesOf = (node: TextNode) => readonly { text: string; width?: number }[]

/**
 * テキストの行が実際に描かれる範囲（ノードの座標系）。描画（canvas/render.ts）と同じく、行は枠の上から行の高さずつ並び、
 * 横は行揃えに従って置く。枠の下や横へはみ出す行も含める。行の幅が分からなければ横は枠の幅とみなす
 */
export function textInkBox(node: TextNode, lines: readonly { text: string; width?: number }[]): Bounds {
  const height = lines.length * node.fontSize * node.lineHeight
  if (lines.some((line) => line.width === undefined)) return { x: 0, y: 0, width: node.width, height }
  const align = alignFactor(node.textAlign)
  let left = 0
  let right = node.width
  for (const line of lines) {
    const x = (node.width - line.width!) * align
    left = Math.min(left, x)
    right = Math.max(right, x + line.width!)
  }
  return { x: left, y: 0, width: right - left, height }
}

/** 線が枠の外へ出る長さ（線は輪郭の真ん中に引くので太さの半分。パスは端の形の張り出しも） */
function strokeOutset(node: Scene['nodes'][string]): number {
  if (node.type === 'text' || node.type === 'image' || !hasStroke(node)) return 0
  // 閉じたパスは端がないので capReach は 0 になる。線の太さの半分は必ず外へ出る
  return node.type === 'path' ? Math.max(capReach(node), node.strokeWidth / 2) : node.strokeWidth / 2
}

/** マイターのつなぎ目の長さの上限（線の太さに対する倍率。Canvas の miterLimit の既定。超えればベベルになる） */
const MITER_LIMIT = 10

/**
 * パスの線の角のとがり（マイター）の先の点のうち、太さの半分より遠くへ出るもの（ノードの座標系）。
 * 描画と同じく、つなぎ目の長さが太さの 10 倍を超える角はベベルになるので数えない。曲線は細かい折れ線に直して見る
 */
export function miterTips(node: PathNode): Point[] {
  const half = node.strokeWidth / 2
  const tips: Point[] = []
  for (const contour of pathOutlines(node)) {
    const points = flattenPath(contour.vertices, contour.closed)
    const n = points.length
    for (let i = 0; i < n; i++) {
      if (!contour.closed && (i === 0 || i === n - 1)) continue
      const p = points[i]
      const a = points[(i - 1 + n) % n]
      const b = points[(i + 1) % n]
      const ua = unit(a.x - p.x, a.y - p.y)
      const ub = unit(b.x - p.x, b.y - p.y)
      if (!ua || !ub) continue
      // 2 辺のなす角 θ に対して、つなぎ目の長さは太さ / sin(θ / 2)。先は角の外側（2 辺の向きの和の逆）
      const cos = Math.max(-1, Math.min(1, ua.x * ub.x + ua.y * ub.y))
      const sinHalf = Math.sqrt((1 - cos) / 2)
      if (sinHalf === 0 || 1 / sinHalf > MITER_LIMIT) continue
      const reach = half / sinHalf
      const out = unit(-(ua.x + ub.x), -(ua.y + ub.y))
      if (!out) continue
      tips.push({ x: p.x + out.x * reach, y: p.y + out.y * reach })
    }
  }
  return tips
}

function unit(x: number, y: number): Point | null {
  const length = Math.hypot(x, y)
  return length < 1e-9 ? null : { x: x / length, y: y / length }
}

function paintedBoundsOf(scene: Scene, id: NodeId, textLines?: TextLinesOf): Bounds | null {
  const node = scene.nodes[id]
  const world = getWorldMatrix(scene, id)
  let box = transformRect(world, { x: 0, y: 0, width: node.width, height: node.height })
  let content = box
  if (node.type === 'frame' && !node.clipContent) {
    content =
      unionBounds([box, ...node.children.flatMap((child) => (scene.nodes[child].visible ? (paintedBoundsOf(scene, child, textLines) ?? []) : []))]) ?? box
  } else if (node.type === 'text' && textLines) {
    // テキストは枠からはみ出す行も描くので、描かれる範囲を足す（影もそこから落ちる）
    box = content = unionBounds([box, transformRect(world, textInkBox(node, textLines(node)))]) ?? box
  }
  const effects = shownPaints(node.effects)
  const parts = [content]
  const stroke = strokeOutset(node)
  if (stroke > 0) {
    const local = { x: -stroke, y: -stroke, width: node.width + stroke * 2, height: node.height + stroke * 2 }
    parts.push(transformRect(world, local))
    // パスの鋭い角は、線のつなぎ目（マイター）が太さの半分より遠くへとがる
    if (node.type === 'path') {
      const tips = miterTips(node)
      if (tips.length > 0) {
        parts.push(unionBounds(tips.map((tip) => transformRect(world, { ...tip, width: 0, height: 0 })))!)
      }
    }
  }
  for (const effect of effects) {
    if (effect.type === 'drop-shadow') {
      const reach = effect.blur * 1.5 + effect.spread
      if (reach < 0 && effect.x === 0 && effect.y === 0) continue
      parts.push({
        x: box.x + effect.x - reach,
        y: box.y + effect.y - reach,
        width: Math.max(0, box.width + reach * 2),
        height: Math.max(0, box.height + reach * 2),
      })
    }
  }
  let bounds = unionBounds(parts)!
  // 描画・SVG・CSS と同じく、レイヤーのぼかしは 1 つの半径にまとめてから 1.5 倍する
  const blur = blurRadius(effects, 'layer-blur') * 1.5
  if (blur > 0) bounds = { x: bounds.x - blur, y: bounds.y - blur, width: bounds.width + blur * 2, height: bounds.height + blur * 2 }
  return bounds
}
