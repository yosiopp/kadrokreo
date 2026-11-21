import type { NodeId, Scene, SceneNode, Shadow, TextNode } from '../document/types.ts'
import { formatColor } from './colors.ts'
import { type CodeStyle, DEFAULT_CODE_STYLE, type InspectSection, shadowCss } from './inspect.ts'

// ページで使われている色と文字の設定の一覧。何も選んでいないときに見せる。

/** count は使われている数（塗りと線の両方に使えば 2）、nodes は使っているノード（重ねない） */
export type ColorUse = { color: string; count: number; nodes: NodeId[] }
export type TextStyleUse = Pick<TextNode, 'fontFamily' | 'fontSize' | 'fontWeight' | 'lineHeight'> & {
  count: number
  nodes: NodeId[]
}
export type ShadowUse = { shadow: Shadow; count: number; nodes: NodeId[] }

/**
 * 表示されているノードの塗りと線の色、テキストの書式を数える。
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
    // 非表示のものは、その中身も画面に出ない
    if (!node.visible) return
    const countColor = (value: string) => {
      const color = value.toLowerCase()
      const use = colors.get(color) ?? { color, count: 0, nodes: [] }
      use.count++
      if (use.nodes.at(-1) !== node.id) use.nodes.push(node.id)
      colors.set(color, use)
    }
    if (node.type === 'text') {
      countColor(node.fill)
      const key = [node.fontFamily, node.fontSize, node.fontWeight, node.lineHeight].join('\n')
      const { fontFamily, fontSize, fontWeight, lineHeight } = node
      const style = textStyles.get(key) ?? { fontFamily, fontSize, fontWeight, lineHeight, count: 0, nodes: [] }
      style.count++
      style.nodes.push(node.id)
      textStyles.set(key, style)
    } else if (node.type === 'line') {
      countColor(node.stroke)
    } else if (node.type !== 'image') {
      if (node.fillGradient) for (const stop of node.fillGradient.stops) countColor(stop.color)
      else if (node.fill !== null) countColor(node.fill)
      if (node.stroke !== null && node.strokeWidth > 0) countColor(node.stroke)
    }
    if ('shadow' in node && node.shadow) {
      const { x, y, blur, color, opacity } = node.shadow
      const key = [x, y, blur, color.toLowerCase(), opacity].join('\n')
      const use = shadows.get(key) ?? { shadow: node.shadow, count: 0, nodes: [] }
      use.count++
      use.nodes.push(node.id)
      shadows.set(key, use)
    }
    if (node.type === 'frame') for (const id of node.children) visit(scene.nodes[id])
  }
  for (const id of scene.rootIds) visit(scene.nodes[id])

  return {
    colors: [...colors.values()].sort((a, b) => b.count - a.count || a.color.localeCompare(b.color)),
    textStyles: [...textStyles.values()].sort(
      (a, b) =>
        b.fontSize - a.fontSize ||
        b.fontWeight - a.fontWeight ||
        a.fontFamily.localeCompare(b.fontFamily) ||
        a.lineHeight - b.lineHeight,
    ),
    // 使われている数の多い順。同じ数なら、ぼかしの大きい（強い）順
    shadows: [...shadows.values()].sort((a, b) => b.count - a.count || b.shadow.blur - a.shadow.blur),
  }
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
        value: `${text.fontWeight} ${text.fontSize}px/${text.lineHeight} ${text.fontFamily}`,
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
