import { isMaskNode } from '../document/mask.ts'
import type { Shadow, NodeId, Paint, Scene, SceneNode, TextNode } from '../document/types.ts'
import { hasStroke, isShadow, shownPaints } from '../document/paint.ts'
import { colorAlpha, formatColor } from './colors.ts'
import { cssFontFamily } from './fontFamily.ts'
import { type CodeStyle, DEFAULT_CODE_STYLE, type InspectSection, shadowCss } from './inspect.ts'

// ページで使われている色と文字の設定の一覧。何も選んでいないときに見せる。

/** count は使われている数（塗りと線の両方に使えば 2）、nodes は使っているノード（重ねない） */
export type ColorUse = { color: string; count: number; nodes: NodeId[] }
export type TextStyleUse = Pick<TextNode, 'fontFamily' | 'fontSize' | 'fontWeight' | 'lineHeight'> & {
  count: number
  nodes: NodeId[]
}
export type ShadowUse = { shadow: Shadow; count: number; nodes: NodeId[] }

/** 下の塗りを隠すか。グラデーションも枠全体を覆う（端の色が外まで続く）ので、どの色も（色ごとの不透明度も）不透明なら隠す */
function isOpaque(paint: Paint): boolean {
  if (paint.opacity < 1) return false
  return paint.type === 'solid' ? colorAlpha(paint.color) >= 1 : paint.stops.every((stop) => stop.opacity >= 1 && colorAlpha(stop.color) >= 1)
}

/**
 * 重ねた塗り（下から順）のうち、見えるもの。隠した塗り（visible が false）は数えない。
 * 上から見ていき、不透明な塗りより下は隠れるので数えない。
 * seeThrough なら、塗りを 1 枚ずつ半透明で重ねて描くので、どれも透けて見える。
 */
export function visiblePaints(all: readonly Paint[], seeThrough = false): Paint[] {
  const paints = shownPaints(all)
  if (seeThrough) return [...paints]
  for (let i = paints.length - 1; i >= 0; i--) {
    if (isOpaque(paints[i])) return paints.slice(i)
  }
  return [...paints]
}

/**
 * ノードの塗りを 1 枚ずつ半透明で描くか（render.ts の drawNode と同じ決まり）。不透明度が 1 未満のノードはそう描くが、
 * 中身のあるフレームだけは、自分の塗りと子を別のキャンバスにふつうに描いてから 1 枚の絵として透かすので、下の塗りは隠れたまま
 */
function paintsSeeThrough(node: SceneNode): boolean {
  return node.opacity < 1 && !(node.type === 'frame' && node.children.length > 0)
}

/**
 * 表示されているノードの、見えている塗りと線の色、テキストの書式を数える。
 * 不透明な塗りの下に重ねて隠れた塗りの色は数えない（visiblePaints）。隠れた色は一覧に出ないので、
 * そこから使っている図形は選べない。確かめるときは、図形を選んでインスペクトの「塗り」を見る（そこには重ねた塗りを全部出す。隠した塗りは出さない）。
 * 色は使われている数の多い順、文字は大きい順に並べる。影の色は、濃さを別に持つので数えない。
 */
export function summarizePage(scene: Scene): {
  colors: ColorUse[]
  textStyles: TextStyleUse[]
  shadows: ShadowUse[]
} {
  const colors = new Map<string, ColorUse>()
  const textStyles = new Map<string, TextStyleUse>()
  const shadows = new Map<string, ShadowUse>()

  function visit(node: SceneNode) {
    // 非表示や不透明度 0 のものは、その中身も画面に出ない（描画も省く）
    // マスクも描かないので、その色は数えない
    if (!node.visible || node.opacity === 0 || isMaskNode(node)) return
    const countColor = (value: string) => {
      const color = value.toLowerCase()
      const use = colors.get(color) ?? { color, count: 0, nodes: [] }
      use.count++
      if (use.nodes.at(-1) !== node.id) use.nodes.push(node.id)
      colors.set(color, use)
    }
    const seeThrough = paintsSeeThrough(node)
    const countPaints = (paints: readonly Paint[]) => {
      for (const paint of visiblePaints(paints, seeThrough)) {
        if (paint.type === 'solid') countColor(paint.color)
        // 完全に透明な色（不透明度 0）は見えないので数えない
        else for (const stop of paint.stops) if (stop.opacity > 0) countColor(stop.color)
      }
    }
    if (node.type === 'text') {
      countPaints(node.fills)
      const key = textStyleKey(node)
      const { fontFamily, fontSize, fontWeight, lineHeight } = node
      const style = textStyles.get(key) ?? { fontFamily, fontSize, fontWeight, lineHeight, count: 0, nodes: [] }
      style.count++
      style.nodes.push(node.id)
      textStyles.set(key, style)
    } else if (node.type !== 'image') {
      countPaints(node.fills)
      if (hasStroke(node)) countPaints(node.strokes)
    }
    for (const shadow of 'effects' in node ? shownPaints(node.effects).filter(isShadow) : []) {
      const key = shadowKey(shadow)
      const use = shadows.get(key) ?? { shadow, count: 0, nodes: [] }
      use.count++
      if (use.nodes.at(-1) !== node.id) use.nodes.push(node.id)
      shadows.set(key, use)
    }
    // ブーリアン演算のノードの子は描かない（形の材料だけ）ので、その色は数えない
    if (node.type === 'frame' && node.booleanOperation === null) for (const id of node.children) visit(scene.nodes[id])
  }
  for (const id of scene.rootIds) visit(scene.nodes[id])

  return {
    colors: [...colors.values()].sort(compareColorUses),
    textStyles: [...textStyles.values()].sort(compareTextStyleUses),
    shadows: [...shadows.values()].sort(compareShadowUses),
  }
}

// 同じものとして数える決まりと並べ方。CLI（colors・text-styles・shadows）が、ページをまたいで足し合わせるときにも使う

/** 同じ文字の書式として数える項目 */
export function textStyleKey(text: Pick<TextNode, 'fontFamily' | 'fontSize' | 'fontWeight' | 'lineHeight'>): string {
  return [text.fontFamily, text.fontSize, text.fontWeight, text.lineHeight].join('\n')
}

/** 同じ影として数える項目 */
export function shadowKey(shadow: Shadow): string {
  const { type, x, y, blur, spread, color, opacity } = shadow
  return [type, x, y, blur, spread, color.toLowerCase(), opacity].join('\n')
}

/** 色は使われている数の多い順 */
export const compareColorUses = (a: ColorUse, b: ColorUse) => b.count - a.count || a.color.localeCompare(b.color)

/** 文字は大きい順 */
export const compareTextStyleUses = (a: TextStyleUse, b: TextStyleUse) =>
  b.fontSize - a.fontSize || b.fontWeight - a.fontWeight || a.fontFamily.localeCompare(b.fontFamily) || a.lineHeight - b.lineHeight

/** 影は使われている数の多い順。同じ数なら、ぼかしの大きい（強い）順 */
export const compareShadowUses = (a: ShadowUse, b: ShadowUse) => b.count - a.count || b.shadow.blur - a.shadow.blur

/** 文字の書式を、CSS の font にそのまま書ける形で */
export function textStyleCss(text: Pick<TextNode, 'fontFamily' | 'fontSize' | 'fontWeight' | 'lineHeight'>): string {
  return `${text.fontWeight} ${text.fontSize}px/${text.lineHeight} ${cssFontFamily(text.fontFamily)}`
}

/** summarizePage の結果を、パネルに出す形にする。文字は、CSS の font にそのまま書ける形で出す */
export function inspectPage(scene: Scene, style: CodeStyle = DEFAULT_CODE_STYLE): InspectSection[] {
  const { colors, textStyles, shadows } = summarizePage(scene)
  const uses = (count: number) => `${count} か所`
  const sections: InspectSection[] = []
  if (colors.length > 0) {
    sections.push({
      title: 'このページの色',
      rows: colors.map(({ color, count, nodes }) => ({ label: uses(count), value: formatColor(color, style.color, { upper: true }), color, nodes })),
    })
  }
  if (textStyles.length > 0) {
    sections.push({
      title: 'このページの文字',
      rows: textStyles.map((text) => ({
        label: uses(text.count),
        value: textStyleCss(text),
        nodes: text.nodes,
      })),
    })
  }
  if (shadows.length > 0) {
    // 影は、色と濃さとずれをまとめた CSS の値で出す（色だけ並べると、濃さが分からない）
    sections.push({
      title: 'このページの影',
      rows: shadows.map(({ shadow, count, nodes }) => ({
        label: uses(count),
        value: shadowCss(shadow, style),
        color: shadow.color,
        nodes,
      })),
    })
  }
  return sections
}
