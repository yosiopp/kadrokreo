import { drawnNode } from '../document/booleanNode.ts'
import { type Point, applyMatrix, getWorldMatrix, invert } from '../document/geometry.ts'
import { type MaskNode, clipsByOutline, insidePolygons, isMaskNode, isShape, maskFillRule, maskOutline, masksOf, shapeContours } from '../document/mask.ts'
import { blurRadius, hasStroke, shownPaints } from '../document/paint.ts'
import { capReach, flattenPath } from '../document/path.ts'
import type { ColorStop, NodeId, Paint, Scene, SceneNode } from '../document/types.ts'
import { BLEND_MODE_LABELS } from '../ui/labels.ts'
import { colorAlpha } from './colors.ts'

// テキストと背景のコントラスト比（WCAG 2 の relative luminance と contrast ratio）。
// 画面と切り離した関数にしてあり、viewer のインスペクトとコマンドラインの検査が同じ求め方を使う。ドキュメントは読むだけ。
//
// 背景の求め方: テキストより先に描かれる（後ろにある）ノードを描く順にたどり、テキストの枠（回転を含む）にかかるものだけを
// 描画と同じ決まり（塗りの重ね、ノードの不透明度、半透明のフレームはまとめてから透かす、通過）で色として重ねる。
// - 枠の全体を覆うものは、その色で重ねる。かからないものは飛ばす。一部だけにかかる塗り・線があれば、背景が 1 色に決まらないので「求められない」
// - 画像・ほかのテキストが枠にかかる、描画モードが「通常」でないもの・ぼかしたもの・不透明度などのマスクがかかるときも「求められない」
// - 祖先のフレームの線は子より手前に描くので見ない
// - グラデーションは、テキストの下にかかる範囲を求めず、止めの間も含めた全体の色を候補にして、いちばん低い比を出す（控えめに判定する）
// - 何も覆っていなければ（透けて残る分も）、白の地の上として求める（ページには地の色を持たない）
// 文字の側も同じで、半透明の文字は背景と合成した色、グラデーションの文字は全体の色で比べる。影・ぼかし・手前に重なるものは見ない。

/** 合成に使う色。sRGB の 0〜1 で、不透明度を掛けた（premultiplied）値 */
type Pixel = readonly [number, number, number, number]

const WHITE: Pixel = [1, 1, 1, 1]
const CLEAR: Pixel = [0, 0, 0, 0]

/** WCAG の基準。大きな文字は 18pt（24px）以上、太字（700 以上）なら 14pt（約 18.66px）以上 */
export const CONTRAST_AA = 4.5
export const CONTRAST_AA_LARGE = 3
export const CONTRAST_AAA = 7
export const CONTRAST_AAA_LARGE = 4.5

/** #rrggbb の相対輝度（WCAG 2。sRGB を線形に直して 0.2126 / 0.7152 / 0.0722 で足す） */
export function relativeLuminance(color: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => linear(parseInt(color.slice(start, start + 2), 16) / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function linear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

/** 2 色（#rrggbb）のコントラスト比（1〜21）。明るいほうの輝度 + 0.05 を暗いほうの輝度 + 0.05 で割る */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** WCAG の「大きな文字」か（fontSize は px） */
export function isLargeText(fontSize: number, fontWeight: number): boolean {
  return fontSize >= 24 || (fontWeight >= 700 && fontSize >= 18.66)
}

/** 比が AA / AAA を満たすか。比は丸めずに比べる（4.499 は 4.5 を満たさない） */
export function contrastLevels(ratio: number, large: boolean): { aa: boolean; aaa: boolean } {
  return { aa: ratio >= (large ? CONTRAST_AA_LARGE : CONTRAST_AA), aaa: ratio >= (large ? CONTRAST_AAA_LARGE : CONTRAST_AAA) }
}

/** 比を見せる形（小数 2 桁）。丸めると基準をまたいで見えるので、切り捨てる（4.499 → 4.49） */
export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 100 + 1e-9) / 100).toFixed(2)}:1`
}

/** 文字と背景の色の組（どちらも合成した後の不透明な #rrggbb）と、その比 */
export type ContrastPair = { text: string; background: string; ratio: number }

export type TextContrast =
  | {
      kind: 'measured'
      /** 比のいちばん低い組。基準の判定はこれで行う */
      lowest: ContrastPair
      /** 比のいちばん高い組。グラデーションなどで組がいくつもあるときだけ lowest と違う */
      highest: ContrastPair
      /** 文字・背景の色の候補がいくつもある（グラデーション）か */
      varies: boolean
      /** 後ろに何も覆っていない所があり、白の地の上として求めたか */
      overWhite: boolean
      large: boolean
      aa: boolean
      aaa: boolean
    }
  | { kind: 'unknown'; reason: string }

/** 求められないときの理由 */
class Unknown {
  readonly reason: string
  constructor(reason: string) {
    this.reason = reason
  }
}

/**
 * テキストのノードの、文字と背景のコントラスト比。テキストでない・表示していない（祖先を含む）・塗りがないときは null。
 * 背景の求め方は、このファイルの先頭のとおり
 */
export function textContrast(scene: Scene, id: NodeId): TextContrast | null {
  const node = scene.nodes[id]
  // マスクにしたテキストは描かれない
  if (node?.type !== 'text' || node.isMask) return null
  const chain: SceneNode[] = []
  for (let current: NodeId | null = id; current !== null; current = scene.nodes[current].parentId) chain.unshift(scene.nodes[current])
  if (chain.some((n) => !n.visible || n.opacity === 0)) return null
  if (shownPaints(node.fills).length === 0) return null

  // テキストの枠の四隅（ページ座標）。背景のノードがここを覆うかを調べる
  const world = getWorldMatrix(scene, id)
  const corners = [
    { x: 0, y: 0 },
    { x: node.width, y: 0 },
    { x: node.width, y: node.height },
    { x: 0, y: node.height },
  ].map((p) => applyMatrix(world, p))
  const walker = new Walker(scene, corners)
  let pairs: { background: Pixel; text: Pixel }[]
  let overWhite = false
  try {
    // 最上位は透明から始めて、最後に白の地に重ねる（透けて残っていれば白の上として求めたことになる）
    pairs = walker.level(scene.rootIds, chain, 0, CLEAR).map(({ background, text }) => {
      if (background[3] < 1 - 1e-6) overWhite = true
      return { background: over(background, WHITE), text: over(text, WHITE) }
    })
  } catch (error) {
    if (error instanceof Unknown) return { kind: 'unknown', reason: error.reason }
    throw error
  }

  const seen = new Map<string, ContrastPair>()
  for (const pair of pairs) {
    const text = toHex(pair.text)
    const background = toHex(pair.background)
    const key = `${text}${background}`
    if (!seen.has(key)) seen.set(key, { text, background, ratio: contrastRatio(text, background) })
  }
  const all = [...seen.values()].sort((a, b) => a.ratio - b.ratio)
  const lowest = all[0]
  const highest = all[all.length - 1]
  const large = isLargeText(node.fontSize, node.fontWeight)
  return { kind: 'measured', lowest, highest, varies: all.length > 1, overWhite, large, ...contrastLevels(lowest.ratio, large) }
}

/** 覆い方。all は枠の全体、none はまったくかからない、some は一部だけ */
type Coverage = 'all' | 'none' | 'some'

class Walker {
  /** ノードごとの relation の結果 */
  private readonly relations = new Map<SceneNode, { inside: boolean; crossing: boolean; distance: number }>()

  private readonly scene: Scene
  /** テキストの枠の四隅（ページ座標） */
  private readonly corners: readonly Point[]

  constructor(scene: Scene, corners: readonly Point[]) {
    this.scene = scene
    this.corners = corners
  }

  /**
   * 兄弟の並び ids のうち、chain[depth]（テキストか、テキストを含む祖先）より後ろのものを below の上に描き、
   * chain[depth] に進んで、背景と文字の色の組を返す
   */
  level(ids: readonly NodeId[], chain: readonly SceneNode[], depth: number, below: Pixel): { background: Pixel; text: Pixel }[] {
    const branch = chain[depth]
    const index = ids.indexOf(branch.id)
    const masks = masksOf(this.scene, ids)
    let stack: Pixel[] = [below]
    for (let i = 0; i < index; i++) {
      const mask = masks[i]
      const clip = mask === null ? null : (this.scene.nodes[mask] as MaskNode)
      stack = unique(stack.flatMap((pixel) => this.draw(ids[i], pixel, clip)))
    }
    const pairs = stack.flatMap((pixel) => this.branch(chain, depth, pixel))
    if (pairs.length > MAX_CANDIDATES * 8) throw tooMany()
    return pairs
  }

  /** テキストか、テキストを含む祖先を below の上に描く */
  private branch(chain: readonly SceneNode[], depth: number, below: Pixel): { background: Pixel; text: Pixel }[] {
    const node = chain[depth]
    if (node.blendMode !== 'normal') throw new Unknown(`「${node.name}」の描画モードが「${BLEND_MODE_LABELS[node.blendMode]}」`)
    if (blurred(node)) throw new Unknown(`「${node.name}」をぼかしている`)
    if (node.type === 'text') {
      // 文字の塗りを背景の上に重ねる。ノードの不透明度は塗りごとに掛かる（描画と同じ）
      return paintLayers(node.fills, node.opacity, node.name).map((layers) => ({ background: below, text: composite(layers, below) }))
    }
    if (node.type !== 'frame') return []
    const inner = (start: Pixel) => {
      // フレームの線は子より手前に描くので、テキストの後ろにはならない（見ない）
      const own = this.selfPaint(node, start, node.children.length > 0 && node.opacity < 1 ? 1 : node.opacity, false)
      return own.flatMap((pixel) => this.level(node.children, chain, depth + 1, pixel))
    }
    if (node.opacity >= 1) return inner(below)
    if (node.passThrough) {
      // 通過: 子を後ろに直接重ね、その結果と後ろを不透明度で混ぜる
      return inner(below).map(({ background, text }) => ({ background: lerp(below, background, node.opacity), text: lerp(below, text, node.opacity) }))
    }
    // 半透明のフレームは、中身を透明から描いてまとめ、不透明度で透かして後ろに重ねる
    return inner(CLEAR).map(({ background, text }) => ({
      background: over(fade(background, node.opacity), below),
      text: over(fade(text, node.opacity), below),
    }))
  }

  /** テキストより後ろにあるノード（とその中身）を below の上に描いた色の候補。clip はかかっているマスク */
  private draw(id: NodeId, below: Pixel, clip: MaskNode | null): Pixel[] {
    const node = drawnNode(this.scene, this.scene.nodes[id])
    if (!node.visible || node.opacity === 0 || isMaskNode(node)) return [below]
    const reach = this.reach(node)
    if (reach === 'none') return [below]
    if (clip !== null) {
      // マスクの外は描かれない。マスクが枠にかからなければ何も描かれず、一部だけなら背景が決まらない
      const masked = this.coverage(clip)
      if (masked === 'none') return [below]
      if (masked === 'some') throw new Unknown(`「${node.name}」がマスクで一部だけ切り取られて重なる`)
      // 不透明度・明るさ・テキストの形のマスクは、形の内側でも透け方が場所で変わる
      if (!clipsByOutline(clip)) throw new Unknown(`「${node.name}」に${clip.type === 'text' ? 'テキストの形' : '不透明度・明るさ'}のマスクがかかる`)
    }
    if (node.blendMode !== 'normal') throw new Unknown(`後ろの「${node.name}」の描画モードが「${BLEND_MODE_LABELS[node.blendMode]}」`)
    if (node.type === 'image') throw new Unknown(`画像「${node.name}」の上にある`)
    if (node.type === 'text') throw new Unknown(`後ろのテキスト「${node.name}」と重なる`)
    if (blurred(node)) throw new Unknown(`後ろの「${node.name}」をぼかしている`)
    if (node.type !== 'frame' || node.children.length === 0) return this.selfPaint(node, below, node.opacity)

    const children = (start: Pixel) => {
      const own = this.selfPaint(node, start, node.opacity < 1 ? 1 : node.opacity)
      if (node.clipContent && this.coverage(node) !== 'all') {
        // 切り取るフレームが枠の一部にしかかからないなら、中身が枠にかかると背景が決まらない
        if (node.children.some((child) => this.reach(drawnNode(this.scene, this.scene.nodes[child])) !== 'none' && this.scene.nodes[child].visible)) {
          throw new Unknown(`「${node.name}」の中身が切り取られて一部だけ重なる`)
        }
        return own
      }
      if (node.booleanOperation !== null) return own
      const masks = masksOf(this.scene, node.children)
      let stack = own
      node.children.forEach((child, i) => {
        const mask = masks[i]
        const childClip = mask === null ? null : (this.scene.nodes[mask] as MaskNode)
        stack = unique(stack.flatMap((pixel) => this.draw(child, pixel, childClip)))
      })
      return stack
    }
    if (node.opacity >= 1) return children(below)
    if (node.passThrough) return children(below).map((pixel) => lerp(below, pixel, node.opacity))
    return children(CLEAR).map((pixel) => over(fade(pixel, node.opacity), below))
  }

  /** ノード自身の塗りと線を below の上に重ねる。alpha は塗りごとに掛ける不透明度 */
  private selfPaint(node: SceneNode, below: Pixel, alpha: number, withStrokes = true): Pixel[] {
    if (node.type === 'text' || node.type === 'image') return [below]
    const fills = shownPaints(node.fills)
    const strokes = withStrokes && hasStroke(node) ? shownPaints(node.strokes) : []
    let stack: Pixel[] = [below]
    if (fills.length > 0) {
      const fillCoverage = this.coverage(node)
      if (fillCoverage === 'some') throw new Unknown(`「${node.name}」の塗りが一部だけ重なる`)
      if (fillCoverage === 'all') {
        const combos = paintLayers(node.fills, alpha, node.name)
        stack = unique(stack.flatMap((pixel) => combos.map((layers) => composite(layers, pixel))))
      }
    }
    if (strokes.length > 0 && this.nearOutline(node, strokeReach(node))) throw new Unknown(`「${node.name}」の線が重なる`)
    return stack
  }

  /** ノード（の塗りか線か中身）がテキストの枠にかかりうるか。はみ出す子を描くフレームは、中身を見るまで決めない */
  private reach(node: SceneNode): Coverage {
    if (node.type === 'frame' && node.children.length > 0 && !node.clipContent && node.booleanOperation === null) return 'some'
    const { inside, crossing, distance } = this.relation(node)
    const stroke = 'strokes' in node && hasStroke(node) ? strokeReach(node) : 0
    if (!crossing && !inside && distance >= stroke) return 'none'
    return 'some'
  }

  /** ノードの形がテキストの枠をどう覆うか */
  private coverage(node: SceneNode): Coverage {
    const { inside, crossing } = this.relation(node)
    return crossing ? 'some' : inside ? 'all' : 'none'
  }

  /** 枠の上のどこかが、形の輪郭から distance より近いか（輪郭を中心に引く線がかかるか） */
  private nearOutline(node: SceneNode, distance: number): boolean {
    const relation = this.relation(node)
    return relation.crossing || relation.distance < distance
  }

  /**
   * ノードの形とテキストの枠の関係（ノードの座標系で比べる）。crossing は輪郭が枠を横切るか（枠の中に輪郭の点がある）、
   * inside は（横切らないとき）枠が形の内側か、distance は枠と輪郭のいちばん近い距離
   */
  private relation(node: SceneNode): { inside: boolean; crossing: boolean; distance: number } {
    const cached = this.relations.get(node)
    if (cached) return cached
    const shapes = isShape(node) ? shapeContours(node) : maskOutline(node as MaskNode)
    const contours = shapes.map((contour) => flattenPath(contour.vertices, true))
    const m = invert(getWorldMatrix(this.scene, node.id))
    const box = this.corners.map((point) => applyMatrix(m, point))
    let crossing = false
    let distance = Infinity
    for (const points of contours) {
      for (let i = 0; i < points.length && !crossing; i++) {
        const a = points[i]
        const b = points[(i + 1) % points.length]
        // 両端が枠の辺の上にある辺も、中点が枠の内側なら枠を横切る（枠と同じ幅の帯など）
        if (strictlyInside(a, box) || strictlyInside({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, box)) crossing = true
        for (let j = 0; j < box.length && !crossing; j++) {
          const c = box[j]
          const d = box[(j + 1) % box.length]
          if (segmentsCross(a, b, c, d)) crossing = true
          else distance = Math.min(distance, distanceToSegment(a, c, d), distanceToSegment(b, c, d), distanceToSegment(c, a, b), distanceToSegment(d, a, b))
        }
      }
    }
    const center = { x: (box[0].x + box[2].x) / 2, y: (box[0].y + box[2].y) / 2 }
    const result = { inside: !crossing && insidePolygons(center, contours, maskFillRule(node)), crossing, distance: crossing ? 0 : distance }
    this.relations.set(node, result)
    return result
  }
}

/** ぼかし（レイヤーのぼかし）を持つか。縁がにじんで、位置ごとに色が変わる */
function blurred(node: SceneNode): boolean {
  return blurRadius(shownPaints(node.effects), 'layer-blur') > 0
}

/**
 * 線が輪郭から外へ出るいちばん遠い距離。輪郭を中心に太さの半分ずつ引き、とがらせる角は角の外へ伸びる
 * （直角なら太さの半分の √2 倍。それより鋭い角は大きく見積もる）。開いたパスの端の形（矢印など）も見る
 */
function strokeReach(node: SceneNode): number {
  if (!('strokes' in node)) return 0
  const half = node.strokeWidth / 2
  if (node.type === 'ellipse' || node.strokeJoin !== 'miter') return node.type === 'path' ? Math.max(half, capReach(node)) : half
  // 矩形・フレームは直角。パスは角の鋭さが分からないので、Canvas の miterLimit（10）まで見込む
  return node.type === 'path' ? Math.max(half * 10, capReach(node)) : half * Math.SQRT2
}

/** 点が四角形の内側（辺の上は含めない）か */
function strictlyInside(p: Point, quad: readonly Point[]): boolean {
  if (!insidePolygons(p, [quad], 'nonzero')) return false
  for (let i = 0; i < quad.length; i++) if (distanceToSegment(p, quad[i], quad[(i + 1) % quad.length]) < 1e-6) return false
  return true
}

/** 2 つの線分が、端以外の所で交わるか（端どうしが触れるだけ・重なって沿うだけは交わらないとみなす） */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const eps = 1e-9
  const d1 = side(c, d, a)
  const d2 = side(c, d, b)
  const d3 = side(a, b, c)
  const d4 = side(a, b, d)
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

/** グラデーションの止めの間に置く候補の数（止めの間の色も、いちばん低い比を探すのに使う） */
const GRADIENT_STEPS = 16

/** 色の候補の数の上限。グラデーションを何枚も重ねると候補が掛け算で増えるので、超えたら求めない */
const MAX_CANDIDATES = 512

/**
 * 重ねた塗り（下から順）を、色の候補の組の並びにする。1 つの組は、下から順に重ねる色（塗りの不透明度と alpha を掛けたもの）。
 * グラデーションは止めと止めの間の色を候補にする
 */
function paintLayers(paints: readonly Paint[], alpha: number, name: string): Pixel[][] {
  let combos: Pixel[][] = [[]]
  for (const paint of shownPaints(paints)) {
    if (paint.blendMode !== 'normal') throw new Unknown(`「${name}」の塗りの描画モードが「${BLEND_MODE_LABELS[paint.blendMode]}」`)
    const colors = paint.type === 'solid' ? [pixel(paint.color, paint.opacity * alpha)] : gradientPixels(paint.stops, paint.opacity * alpha)
    if (combos.length * colors.length > MAX_CANDIDATES) throw tooMany()
    combos = combos.flatMap((combo) => colors.map((color) => [...combo, color]))
  }
  return combos
}

function gradientPixels(stops: readonly ColorStop[], alpha: number): Pixel[] {
  const sorted = [...stops].sort((a, b) => a.offset - b.offset)
  const colors = sorted.map((stop) => pixel(stop.color, stop.opacity * alpha))
  const result: Pixel[] = [colors[0]]
  for (let i = 1; i < colors.length; i++) {
    for (let step = 1; step <= GRADIENT_STEPS; step++) result.push(lerp(colors[i - 1], colors[i], step / GRADIENT_STEPS))
  }
  return unique(result)
}

/** 色を下から順に重ねる */
function composite(layers: readonly Pixel[], below: Pixel): Pixel {
  return layers.reduce((dst, src) => over(src, dst), below)
}

function pixel(color: string, alpha: number): Pixel {
  const a = colorAlpha(color) * alpha
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16) / 255)
  return [r * a, g * a, b * a, a]
}

/** src を dst の上に重ねる（source-over） */
function over(src: Pixel, dst: Pixel): Pixel {
  const k = 1 - src[3]
  return [src[0] + dst[0] * k, src[1] + dst[1] * k, src[2] + dst[2] * k, src[3] + dst[3] * k]
}

function fade(p: Pixel, alpha: number): Pixel {
  return [p[0] * alpha, p[1] * alpha, p[2] * alpha, p[3] * alpha]
}

function lerp(a: Pixel, b: Pixel, t: number): Pixel {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]
}

/** 不透明な色を #rrggbb に（画面の色と同じく 0〜255 に丸める） */
function toHex(p: Pixel): string {
  const a = p[3] || 1
  return `#${[p[0], p[1], p[2]].map((c) => Math.round(Math.min(1, Math.max(0, c / a)) * 255).toString(16).padStart(2, '0')).join('')}`
}

/** 同じ色の候補を 1 つにまとめる（グラデーションを重ねても候補が増えすぎないように） */
function unique(list: readonly Pixel[]): Pixel[] {
  const seen = new Map<string, Pixel>()
  for (const p of list) {
    const key = p.map((c) => Math.round(c * 1024)).join(',')
    if (!seen.has(key)) seen.set(key, p)
    if (seen.size > MAX_CANDIDATES) throw tooMany()
  }
  return [...seen.values()]
}

function tooMany(): Unknown {
  return new Unknown('グラデーションの重なりが多く、色の組み合わせを数えきれない')
}

