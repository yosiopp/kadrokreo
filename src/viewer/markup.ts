import { cappedStroke, lineEndpoints, pathPoints } from '../document/path.ts'
import { type Point, tidy } from '../document/geometry.ts'
import type { Asset, AssetId, LineNode, NodeId, PathNode, Scene, SceneNode } from '../document/types.ts'
import { formatColor } from './colors.ts'
import { type CodeStyle, DEFAULT_CODE_STYLE, nodeCss } from './inspect.ts'

// 選んだノードを、中身（子孫）まで含めた HTML と CSS で表す。実装の手がかりにするためのもので、ドキュメントは変えない。
// 一つひとつの要素の CSS は nodeCss と同じもの。要素にはレイヤー名から作ったクラス名を付ける。

export type Markup = { html: string; css: string }

/** 画像の src。snippet はファイル名だけ（元の画像を保存して置く前提）、standalone はファイルに埋め込む */
type ImageSource = 'file' | 'embed'

const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg' }

/** 画像のファイル名に付ける拡張子 */
export function imageExtension(mime: string): string {
  return EXTENSIONS[mime] ?? mime.replace('image/', '')
}

/**
 * id のノードと、その表示されている子孫の HTML と CSS。
 * 選んだノードは、もとの親の中での置き方（absolute など）を外し、いちばん外側の要素として書く。
 */
export function nodeMarkup(
  scene: Scene,
  id: NodeId,
  options: { style?: Partial<CodeStyle>; assets?: Record<AssetId, Asset>; images?: ImageSource } = {},
): Markup {
  const { style = {}, assets = {}, images = 'file' } = options
  // 選んだノードを根にした木として扱う
  const root = scene.nodes[id]
  const tree: Scene = { nodes: { ...scene.nodes, [id]: { ...root, parentId: null } }, rootIds: [id] }

  const used = new Map<string, number>()
  const rules: string[] = []
  const lines: string[] = []

  function className(node: SceneNode): string {
    const base = slug(node.name) || node.type
    const count = (used.get(base) ?? 0) + 1
    used.set(base, count)
    return count === 1 ? base : `${base}-${count}`
  }

  function visit(node: SceneNode, depth: number) {
    const indent = '  '.repeat(depth)
    const name = className(node)
    let css = nodeCss(tree, node.id, style)
    // SVG は枠の外に出る線の太さの分を切らない
    if (node.type === 'line' || node.type === 'path') css += '\noverflow: visible;'
    rules.push(`.${name} {\n${css.replace(/^/gm, '  ')}\n}`)

    const attr = `class="${name}"`
    switch (node.type) {
      case 'frame': {
        const children = node.children.map((child) => tree.nodes[child]).filter((child) => child.visible)
        if (children.length === 0) {
          lines.push(`${indent}<div ${attr}></div>`)
        } else {
          lines.push(`${indent}<div ${attr}>`)
          for (const child of children) visit(child, depth + 1)
          lines.push(`${indent}</div>`)
        }
        break
      }
      case 'text':
        lines.push(`${indent}<div ${attr}>${escapeHtml(node.text).replace(/\n/g, '<br>')}</div>`)
        break
      case 'image': {
        const asset = Object.hasOwn(assets, node.assetId) ? assets[node.assetId] : undefined
        const src =
          images === 'embed' && asset
            ? `data:${asset.mime};base64,${asset.data}`
            : `${slug(node.name) || 'image'}.${asset ? imageExtension(asset.mime) : 'png'}`
        lines.push(`${indent}<img ${attr} src="${escapeHtml(src)}" alt="${escapeHtml(node.name)}">`)
        break
      }
      case 'line':
      case 'path': {
        const box = `viewBox="0 0 ${tidy(node.width)} ${tidy(node.height)}"`
        const points = node.type === 'line' ? lineEndpoints(node) : pathPoints(node)
        const shapes = svgShapes(node, points, style)
        lines.push(`${indent}<svg ${attr} ${box}>${shapes}</svg>`)
        break
      }
      default:
        lines.push(`${indent}<div ${attr}></div>`)
    }
  }
  visit(tree.nodes[id], 0)

  return { html: lines.join('\n'), css: rules.join('\n\n') }
}

/**
 * 直線とパスの SVG の中身。色や太さはクラスの CSS で付ける。
 * 端に矢印があれば、描画と同じく線を矢印の分だけ短くし、矢印は線の色で塗った三角形にする。
 */
function svgShapes(node: LineNode | PathNode, points: Point[], style: Partial<CodeStyle>): string {
  const list = (ps: readonly Point[]) => ps.map((point) => `${tidy(point.x)},${tidy(point.y)}`).join(' ')
  const element = (ps: readonly Point[], extra = '') =>
    ps.length === 2
      ? `<line x1="${tidy(ps[0].x)}" y1="${tidy(ps[0].y)}" x2="${tidy(ps[1].x)}" y2="${tidy(ps[1].y)}"${extra}/>`
      : `<polyline points="${list(ps)}"${extra}/>`
  const closed = node.type === 'path' && node.closed
  const capped = !closed && node.stroke !== null && (node.startCap !== 'none' || node.endCap !== 'none')
  if (!capped) {
    if (node.type === 'line') return element(points)
    return `<${closed ? 'polygon' : 'polyline'} points="${list(points)}"/>`
  }
  const { line, heads } = cappedStroke(points, node)
  const parts: string[] = []
  // 塗りは短くしない元の形で
  if (node.type === 'path' && node.fill !== null) parts.push(`<polyline points="${list(points)}" stroke="none"/>`)
  parts.push(element(line, node.type === 'path' ? ' fill="none"' : ''))
  const color = formatColor(node.stroke!, style.color ?? DEFAULT_CODE_STYLE.color)
  for (const head of heads) parts.push(`<polygon points="${list(head)}" fill="${escapeHtml(color)}" stroke="none"/>`)
  return parts.join('')
}

/** そのままブラウザで開ける HTML ファイル。画像は埋め込む */
export function standaloneHtml(title: string, markup: Markup): string {
  // ファイルの中身は信頼できない入力（kdr）から作るので、<style> を閉じられないようにする
  const css = markup.css.replace(/</g, '\\3c ')
  return [
    '<!doctype html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    '* { box-sizing: border-box; margin: 0; }',
    '',
    css,
    '</style>',
    '</head>',
    '<body>',
    markup.html,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/** レイヤー名からクラス名を作る。英数字以外は - にまとめ、使える文字がなければ空文字 */
export function slug(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // クラス名は数字から始められない
  return /^[0-9]/.test(words) ? `n-${words}` : words
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
