import { tidy } from '../document/geometry.ts'
import { withoutHidden } from '../document/paint.ts'
import { dataUri, escapeXml as escapeHtml, pathSvg } from '../document/svgShapes.ts'
import type { Asset, AssetId, NodeId, PathNode, Scene, SceneNode } from '../document/types.ts'
import { formatColor } from './colors.ts'
import { type CodeStyle, DEFAULT_CODE_STYLE, nodeCss } from './inspect.ts'
import { camelClass, componentName, jsxStyle, parseDeclarations, tailwindClasses } from './codeFormat.ts'

// 選んだノードを、中身（子孫）まで含めた HTML と CSS で表す。実装の手がかりにするためのもので、ドキュメントは変えない。
// 一つひとつの要素の CSS は nodeCss と同じもの。要素にはレイヤー名から作ったクラス名を付ける。
// 出力形式（CodeStyle の format）が React や Tailwind なら、同じ木を JSX のコンポーネントにし、CSS をその形式で付ける。
// Vue なら、HTML と同じ木を <template> に、CSS を <style scoped> に入れた単一ファイルコンポーネント（.vue）にする。

/** html は形式が React などなら JSX のコード、Vue なら .vue ファイルの全体。css は、その形式で別に CSS が要らなければ空文字 */
export type Markup = { html: string; css: string }

/** 画像の src。snippet はファイル名だけ（元の画像を保存して置く前提）、standalone はファイルに埋め込む */
type ImageSource = 'file' | 'embed'

const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg' }

/** 画像のファイル名に付ける拡張子 */
export function imageExtension(mime: string): string {
  return EXTENSIONS[mime] ?? mime.replace('image/', '')
}

/** 1 つのノードの CSS を、出力形式に合わせて書いたもの（パネルの「CSS」の欄） */
export type NodeCode = { title: string; copyLabel: string; code: string }

export function nodeCode(scene: Scene, id: NodeId, options: Partial<CodeStyle> = {}): NodeCode {
  const css = nodeCss(scene, id, options)
  switch (options.format ?? DEFAULT_CODE_STYLE.format) {
    case 'react':
      return { title: 'style', copyLabel: 'style をコピー', code: jsxStyle(parseDeclarations(css), true) }
    case 'tailwind':
      return { title: 'Tailwind のクラス', copyLabel: 'クラスをコピー', code: tailwindClasses(parseDeclarations(css)).join(' ') }
    default:
      return { title: 'CSS', copyLabel: 'CSS をコピー', code: css }
  }
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
  const format = style.format ?? DEFAULT_CODE_STYLE.format
  const jsx = format !== 'html' && format !== 'vue'
  // 選んだノードを根にした木として扱う
  const root = scene.nodes[id]
  const tree: Scene = { nodes: { ...scene.nodes, [id]: { ...root, parentId: null } }, rootIds: [id] }

  const used = new Set<string>()
  /** 名前ごとに、次に試す番号。同じ名前が多くても毎回 2 から数え直さない（数え直すと子の数の 2 乗かかる） */
  const nextCount = new Map<string, number>()
  const rules: string[] = []
  const lines: string[] = []

  function className(node: SceneNode): string {
    const base = slug(node.name) || node.type
    const shape = (name: string) => (format === 'css-modules' ? camelClass(name) : name)
    let name = shape(base)
    let count = nextCount.get(base) ?? 2
    // 使った名前は減らないので、前回この名前で止まった番号より前はすべて使われている
    if (used.has(name)) {
      while (used.has((name = shape(`${base}-${count}`)))) count++
      count++
    }
    nextCount.set(base, count)
    used.add(name)
    return name
  }

  /** 要素に付ける属性（クラスか style） */
  function attribute(name: string, css: string): string {
    switch (format) {
      case 'react':
        return `style={${jsxStyle(parseDeclarations(css))}}`
      case 'css-modules':
        return `className={styles.${name}}`
      case 'tailwind':
        return `className="${tailwindClasses(parseDeclarations(css)).join(' ')}"`
      default:
        return `class="${name}"`
    }
  }

  function visit(node: SceneNode, depth: number) {
    const indent = '  '.repeat(depth)
    const name = className(node)
    let css = nodeCss(tree, node.id, style)
    // SVG は枠の外に出る線の太さの分を切らない
    if (node.type === 'path') css += '\noverflow: visible;'
    if (format !== 'react' && format !== 'tailwind') rules.push(`.${name} {\n${css.replace(/^/gm, '  ')}\n}`)

    const attr = attribute(name, css)
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
      case 'text': {
        // Vue のテンプレートも {{ }} を式と読むので、JSX と同じく { } を文字参照にする
        const text = jsx
          ? escapeJsx(node.text).replace(/\n/g, '<br />')
          : (format === 'vue' ? escapeJsx(node.text) : escapeHtml(node.text)).replace(/\n/g, '<br>')
        lines.push(`${indent}<div ${attr}>${text}</div>`)
        break
      }
      case 'image': {
        const asset = Object.hasOwn(assets, node.assetId) ? assets[node.assetId] : undefined
        const src =
          images === 'embed' && asset
            ? dataUri(asset)
            : `${slug(node.name) || 'image'}.${asset ? imageExtension(asset.mime) : 'png'}`
        lines.push(`${indent}<img ${attr} src="${escapeHtml(src)}" alt="${escapeHtml(node.name)}"${jsx ? ' />' : '>'}`)
        break
      }
      case 'path': {
        // SVG の中身は HTML と同じもの（属性名は JSX でもそのまま使える）
        const box = `viewBox="0 0 ${tidy(node.width)} ${tidy(node.height)}"`
        const shapes = svgShapes(node, name, style, jsx)
        lines.push(`${indent}<svg ${attr} ${box}>${shapes}</svg>`)
        break
      }
      default:
        lines.push(`${indent}<div ${attr}></div>`)
    }
  }
  visit(tree.nodes[id], jsx ? 2 : format === 'vue' ? 1 : 0)

  const css = rules.join('\n\n')
  if (format === 'vue') {
    // <style> を閉じられないようにする（中身は信頼できない入力の kdr から作る）
    const scoped = css.replace(/</g, '\\3c ')
    return { html: ['<template>', ...lines, '</template>', '', '<style scoped>', scoped, '</style>'].join('\n'), css: '' }
  }
  if (!jsx) return { html: lines.join('\n'), css }
  // JSX は、レイヤー名を名前にしたコンポーネントにする
  const component = componentName(slug(root.name))
  const head = format === 'css-modules' ? [`import styles from './${component}.module.css'`, ''] : []
  const code = [...head, `export function ${component}() {`, '  return (', ...lines, '  )', '}'].join('\n')
  return { html: code, css }
}

/**
 * 直線とパスの SVG の中身。色や太さはクラスの CSS で付ける（図形の書き方は SVG の書き出しと共有。document/svgShapes.ts）。
 * グラデーションの塗り・線は CSS の fill / stroke に書けない（CSS は始まりの色で代えている）ので、
 * linearGradient / radialGradient を defs に置き、要素の fill / stroke 属性で指す。CSS は外側の svg に付くので、中の要素の属性のほうが勝つ
 * （受け継いだ値より、要素自身の指定が優先）。id はクラス名から作る。jsx なら属性名を React の書き方（stopColor）にする
 */
function svgShapes(path: PathNode, name: string, style: Partial<CodeStyle>, jsx = false): string {
  // 隠した塗り・線は書かない
  const node = withoutHidden(path)
  const colorStyle = style.color ?? DEFAULT_CODE_STYLE.color
  const { defs, elements } = pathSvg(node, {
    id: name,
    color: (hex) => formatColor(hex, colorStyle),
    jsx,
    fill: node.fills.at(-1) ?? null,
    stroke: node.strokes.at(-1) ?? null,
    standalone: false,
  })
  return (defs.length > 0 ? `<defs>${defs.join('')}</defs>` : '') + elements.join('')
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

/** JSX の中の文字。HTML の書き方に加えて、{ } も式と読まれないようにする */
function escapeJsx(text: string): string {
  return escapeHtml(text).replace(/\{/g, '&#123;').replace(/\}/g, '&#125;')
}

