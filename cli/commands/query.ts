import { getAbsoluteBounds } from '../../src/document/geometry.ts'
import { KDR_FORMAT, KDR_VERSION } from '../../src/document/kdr.ts'
import { contoursData, mapVertices, nodeKind, pathContours } from '../../src/document/path.ts'
import type { NodeId, Scene, SceneNode } from '../../src/document/types.ts'
import { listComponents } from '../../src/editor/components.ts'
import { pruneAssets } from '../../src/editor/operations/document.ts'
import { searchLayers } from '../../src/viewer/traverse.ts'
import { UsageError } from '../args.ts'
import { type Command, checkStep, flag, positional, round } from './common.ts'

// 調べるコマンド（標準出力に文字を出す）

function describe(node: SceneNode): string {
  const size = `${round(node.x)},${round(node.y)} ${round(node.width)}×${round(node.height)}`
  const notes = [
    node.type === 'frame' && node.component ? `component:${node.component.role}` : '',
    node.type === 'frame' && node.layout ? `auto-layout:${node.layout.direction}` : '',
    node.visible ? '' : 'hidden',
    node.type === 'text' ? JSON.stringify(node.text.length > 40 ? node.text.slice(0, 40) + '…' : node.text) : '',
  ].filter(Boolean)
  return [nodeKind(node), JSON.stringify(node.name), node.id, size, ...notes].join('  ')
}

function tree(scene: Scene, ids: readonly NodeId[], depth: number, lines: string[]): void {
  // レイヤーパネルと同じく、手前のものを上に出す
  for (const id of ids.toReversed()) {
    const node = scene.nodes[id]
    lines.push('  '.repeat(depth) + describe(node))
    if (node.type === 'frame') tree(scene, node.children, depth + 1, lines)
  }
}

function nestedJson(scene: Scene, id: NodeId): unknown {
  const node = scene.nodes[id]
  if (node.type !== 'frame') return node
  return { ...node, children: node.children.map((child) => nestedJson(scene, child)) }
}

function getIn(value: unknown, path: string): unknown {
  let current = value
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) {
      throw new UsageError(`項目がありません: ${path}`)
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function namePath(scene: Scene, id: NodeId): string {
  const names: string[] = []
  for (let current: NodeId | null = id; current !== null; current = scene.nodes[current].parentId) {
    names.unshift(scene.nodes[current].name)
  }
  return names.join('/')
}

/** パスの形を SVG の path の d で表す。座標は親の座標系（回転は含めない。`add path --d` で同じ形に戻る） */
function nodePathData(node: SceneNode): string {
  if (node.type !== 'path') throw new UsageError(`get: d はパスと直線だけにあります: ${node.id}`)
  // 輪郭が複数あれば、M で始まるまとまりを並べる
  const moved = pathContours(node).map((contour) => ({
    vertices: mapVertices(contour.vertices, (point) => ({ x: point.x + node.x, y: point.y + node.y })),
    closed: contour.closed,
  }))
  return contoursData(moved)
}

export const info: Command = {
  name: 'info',
  kind: 'query',
  usage: 'info',
  summary: 'ドキュメントの名前・ページ・画像・埋め込んだ書体・コンポーネントの数を出す',
  run({ session, print }, step) {
    checkStep(step, { positionals: 0 })
    const doc = pruneAssets(session.document)
    const bytes = Object.values(doc.assets).reduce((sum, asset) => sum + asset.bytes.length, 0)
    const lines = [
      `name: ${doc.name}`,
      `format: ${KDR_FORMAT} v${KDR_VERSION}`,
      `pages: ${doc.pages.length}`,
      ...doc.pages.map(
        (page, i) =>
          `  ${i + 1}. ${JSON.stringify(page.name)}  ${page.id}  nodes:${Object.keys(page.nodes).length}` +
          (page.id === session.page.id ? '  (current)' : ''),
      ),
      `assets: ${Object.keys(doc.assets).length} (${bytes} bytes)`,
      `fonts: ${doc.fonts.length}`,
      ...doc.fonts.map((font) => `  ${JSON.stringify(font.family)}  ${font.weight}${font.style === 'italic' ? ' italic' : ''}  ${font.assetId}`),
      `components: ${listComponents(doc).length}`,
    ]
    print(lines.join('\n'))
  },
}

export const ls: Command = {
  name: 'ls',
  kind: 'query',
  usage: 'ls [ノード] [--all] [--json]',
  summary: 'いまのページ（--all なら全ページ）のノードを木の形で出す。手前のものが上',
  flags: ['all', 'json'],
  run({ session, print }, step) {
    checkStep(step, { options: ['all', 'json'], positionals: 1 })
    const pages = flag(step, 'all') ? session.document.pages : [session.page]
    const root = step.positionals[0]
    if (root !== undefined && pages.length > 1) throw new UsageError('ls: --all とノードは一緒に指定できません')
    if (flag(step, 'json')) {
      const value = pages.map((page) => ({
        id: page.id,
        name: page.name,
        nodes: (root === undefined ? page.rootIds : session.resolve(root)).map((id) => nestedJson(page, id)),
      }))
      print(JSON.stringify(flag(step, 'all') ? value : value[0], null, 2))
      return
    }
    const lines: string[] = []
    for (const page of pages) {
      if (pages.length > 1) lines.push(`# ${page.name}  ${page.id}`)
      tree(page, root === undefined ? page.rootIds : session.resolve(root), 0, lines)
    }
    if (lines.length > 0) print(lines.join('\n'))
  },
}

export const get: Command = {
  name: 'get',
  kind: 'query',
  usage: 'get ノード [項目]',
  summary: 'ノードの設定を JSON で出す。項目は layout.gap のように . でつなぐ。パスの d は形を SVG の path の d で出す',
  run({ session, print }, step) {
    checkStep(step, { positionals: 2 })
    const id = session.resolveOne(positional(step, 0, 'ノード'))
    const node = session.page.nodes[id]
    const key = step.positionals[1]
    const value = key === undefined ? node : key === 'd' ? nodePathData(node) : getIn(node, key)
    print(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  },
}

export const find: Command = {
  name: 'find',
  kind: 'query',
  usage: 'find 文字列',
  summary: '名前かテキストの内容に文字列を含むノードを、id・種類・道筋の順で出す（大文字と小文字は区別しない）',
  run({ session, print }, step) {
    checkStep(step, { positionals: 1 })
    const page = session.page
    const ids = searchLayers(page, positional(step, 0, '文字列'))
    if (ids.length > 0) print(ids.map((id) => `${id}\t${nodeKind(page.nodes[id])}\t${namePath(page, id)}`).join('\n'))
  },
}

export const bounds: Command = {
  name: 'bounds',
  kind: 'query',
  usage: 'bounds ノード',
  summary: 'ページ上での位置と大きさ（回転を含めて囲む矩形）を x y width height で出す',
  run({ session, print }, step) {
    checkStep(step, { positionals: 1 })
    const id = session.resolveOne(positional(step, 0, 'ノード'))
    const box = getAbsoluteBounds(session.page, id)
    print([box.x, box.y, box.width, box.height].map(round).join(' '))
  },
}

export const componentList: Command = {
  name: 'components',
  kind: 'query',
  usage: 'components',
  summary: 'コンポーネントの元を、ページ・id・名前・インスタンスの数で出す',
  run({ session, print }, step) {
    checkStep(step, { positionals: 0 })
    const doc = session.document
    const counts = new Map<string, number>()
    for (const page of doc.pages) {
      for (const node of Object.values(page.nodes)) {
        if (node.type === 'frame' && node.component?.role === 'instance') {
          counts.set(node.component.id, (counts.get(node.component.id) ?? 0) + 1)
        }
      }
    }
    const lines = listComponents(doc).map(
      ({ page, node }) =>
        `${JSON.stringify(page.name)}\t${node.id}\t${JSON.stringify(node.name)}\tinstances:${counts.get(node.component.id) ?? 0}`,
    )
    if (lines.length > 0) print(lines.join('\n'))
  },
}
