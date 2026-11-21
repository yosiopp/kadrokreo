import { type Point, getAbsoluteBounds, getWorldCenter } from '../src/document/geometry.ts'
import { IMAGE_MIME_TYPES, KDR_FORMAT, KDR_VERSION } from '../src/document/kdr.ts'
import { lineBetween, pathFromPoints } from '../src/document/path.ts'
import type { DesignDocument, NodeId, Page, Scene, SceneNode } from '../src/document/types.ts'
import { createInstance, detachComponent, listComponents, makeComponent } from '../src/editor/components.ts'
import { enableAutoLayout, setLayoutFill, wrapInAutoLayout } from '../src/editor/layout.ts'
import {
  createEllipse,
  createFrame,
  createId,
  createImage,
  createLine,
  createPath,
  createRect,
  createText,
} from '../src/editor/nodes.ts'
import {
  type ReorderDirection,
  addAsset,
  addPage,
  copyFragment,
  createDocument,
  createPage,
  insertNode,
  moveNode,
  pasteIntoPage,
  patchNodes,
  pruneAssets,
  removeNodes,
  removePage,
  renameDocument,
  renamePage,
  reorderNodes,
  updateNode,
} from '../src/editor/operations.ts'
import { type ColorFormat } from '../src/viewer/colors.ts'
import { type Unit, nodeCss } from '../src/viewer/inspect.ts'
import { nodeMarkup, standaloneHtml } from '../src/viewer/markup.ts'
import { searchLayers } from '../src/viewer/traverse.ts'
import { type Step, UsageError } from './args.ts'
import { readImageInfo } from './image.ts'
import { type Session, checkNewId, renameNodeId, resolvePage } from './session.ts'
import { estimateTextSize } from './textMeasure.ts'
import { buildPatch } from './values.ts'

/**
 * source: 新しいドキュメントを作る（先頭にだけ置ける）
 * edit: ドキュメントを変える（最後に kdr を書き出す）
 * query: 標準出力に文字を出す
 * nav: どちらでもない（いまのページを変えるなど）
 */
export type Kind = 'source' | 'edit' | 'query' | 'nav'

/** コマンドを実行するときに使えるもの */
export type Context = {
  session: Session
  print: (text: string) => void
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>
}

export type Command = {
  name: string
  kind: Kind
  usage: string
  summary: string
  /** 値を取らない --オプション */
  flags?: readonly string[]
  /** 「名前=値」を受け付ける */
  assignments?: true
  run: (ctx: Context, step: Step) => void | Promise<void>
}

// ── 引数の読み取り ──

function option(step: Step, key: string): string | undefined {
  const value = step.options.get(key)
  if (value === true) throw new UsageError(`${step.name}: --${key} に値を指定してください`)
  return value
}

function flag(step: Step, key: string): boolean {
  return step.options.has(key)
}

function numberOption(step: Step, key: string): number | undefined {
  const raw = option(step, key)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(value)) throw new UsageError(`${step.name}: --${key} は数値です: ${raw}`)
  return value
}

function point(raw: string, label: string): Point {
  const parts = raw.split(',').map((part) => Number(part.trim()))
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) {
    throw new UsageError(`${label} は「x,y」の形で指定してください: ${raw}`)
  }
  return { x: parts[0], y: parts[1] }
}

function positional(step: Step, index: number, label: string): string {
  const value = step.positionals[index]
  if (value === undefined) throw new UsageError(`${step.name}: ${label}を指定してください`)
  return value
}

/** 想定していない引数やオプションを黙って無視しない */
function checkStep(step: Step, allowed: { options?: readonly string[]; positionals?: number; assignments?: boolean }): void {
  for (const key of step.options.keys()) {
    if (!allowed.options?.includes(key)) throw new UsageError(`${step.name}: 不明なオプションです: --${key}`)
  }
  if (allowed.positionals !== undefined && step.positionals.length > allowed.positionals) {
    throw new UsageError(`${step.name}: 余分な引数があります: ${step.positionals.slice(allowed.positionals).join(' ')}`)
  }
  if (!allowed.assignments && step.assignments.length > 0) {
    throw new UsageError(`${step.name}: 「名前=値」は指定できません: ${step.assignments[0].join('=')}`)
  }
}

// ── 出力の形 ──

const round = (value: number) => Math.round(value * 100) / 100

function describe(node: SceneNode): string {
  const size = `${round(node.x)},${round(node.y)} ${round(node.width)}×${round(node.height)}`
  const notes = [
    node.type === 'frame' && node.component ? `component:${node.component.role}` : '',
    node.type === 'frame' && node.layout ? `auto-layout:${node.layout.direction}` : '',
    node.visible ? '' : 'hidden',
    node.type === 'text' ? JSON.stringify(node.text.length > 40 ? node.text.slice(0, 40) + '…' : node.text) : '',
  ].filter(Boolean)
  return [node.type, JSON.stringify(node.name), node.id, size, ...notes].join('  ')
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

// ── ノードの追加 ──

const NODE_TYPES = ['rect', 'ellipse', 'line', 'path', 'text', 'frame', 'image'] as const
type NodeType = (typeof NODE_TYPES)[number]
const TEXT_KEYS = new Set(['text', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'autoWidth', 'width'])

async function buildNode(ctx: Context, step: Step, type: NodeType): Promise<SceneNode> {
  const x = numberOption(step, 'x') ?? 0
  const y = numberOption(step, 'y') ?? 0
  const width = numberOption(step, 'width')
  const height = numberOption(step, 'height')
  const box = { x, y, width: width ?? 100, height: height ?? 100 }

  switch (type) {
    case 'rect':
      return createRect(box)
    case 'ellipse':
      return createEllipse(box)
    case 'frame':
      return createFrame(box)
    case 'line': {
      const from = option(step, 'from')
      const to = option(step, 'to')
      if (from === undefined || to === undefined) {
        return createLine({ ...box, height: height ?? 0 })
      }
      const between = lineBetween(point(from, '--from'), point(to, '--to'))
      return { ...createLine(between, between.direction), flipped: between.flipped }
    }
    case 'path': {
      const raw = option(step, 'points')
      if (raw === undefined) throw new UsageError('add path: --points "x,y x,y …" で頂点を指定してください')
      const points = raw.trim().split(/\s+/).map((part) => point(part, '--points'))
      if (points.length < 2) throw new UsageError('add path: 頂点は 2 つ以上です')
      return createPath(pathFromPoints(points), flag(step, 'closed'))
    }
    case 'text': {
      const text = createText(box, option(step, 'text') ?? '')
      // 幅を指定したら、その幅で折り返す
      return { ...text, autoWidth: width === undefined, width: width ?? text.width }
    }
    case 'image': {
      const file = option(step, 'src')
      const asset = option(step, 'asset')
      if (asset !== undefined) {
        if (!Object.hasOwn(ctx.session.document.assets, asset)) throw new UsageError(`画像がありません: ${asset}`)
        return createImage(box, asset)
      }
      if (file === undefined) throw new UsageError('add image: --src で画像ファイルを指定してください')
      const bytes = await ctx.readFile(file)
      const info = readImageInfo(bytes)
      if (!info || !IMAGE_MIME_TYPES.includes(info.mime)) {
        throw new UsageError(`${file}: PNG・JPEG・WebP・GIF の画像ではありません`)
      }
      const assetId = createId()
      ctx.session.applyDocument((doc) =>
        addAsset(doc, assetId, { mime: info.mime, data: Buffer.from(bytes).toString('base64') }),
      )
      // 大きさを片方だけ指定したら、縦横比を保つ
      const ratio = info.height === 0 ? 1 : info.width / info.height
      const w = width ?? (height !== undefined ? height * ratio : info.width)
      const h = height ?? (width !== undefined ? width / ratio : info.height)
      return createImage({ x, y, width: Math.max(1, w), height: Math.max(1, h) }, assetId)
    }
  }
}

async function add(ctx: Context, step: Step): Promise<void> {
  const type = positional(step, 0, '種類（' + NODE_TYPES.join(' / ') + '）') as NodeType
  if (!NODE_TYPES.includes(type)) throw new UsageError(`add: 不明な種類です: ${type}（${NODE_TYPES.join(' / ')}）`)
  checkStep(step, {
    options: ['x', 'y', 'width', 'height', 'parent', 'index', 'id', 'name', 'text', 'from', 'to', 'points', 'closed', 'src', 'asset'],
    positionals: 1,
    assignments: true,
  })
  const { session } = ctx
  const parentSelector = option(step, 'parent')
  const parentId = parentSelector === undefined ? null : session.resolveFrame(parentSelector)
  const index = numberOption(step, 'index')
  const id = option(step, 'id')
  if (id !== undefined) checkNewId(session.page, id)

  let node = await buildNode(ctx, step, type)
  const name = option(step, 'name')
  node = { ...node, ...(id === undefined ? {} : { id }), ...(name === undefined ? {} : { name }) }
  // 名前=値 は、作ったノードへ set と同じ決まりで当てる
  node = { ...node, ...buildPatch(node, step.assignments) } as SceneNode
  if (node.type === 'text') node = { ...node, ...estimateTextSize(node) }

  const created = node
  session.apply((page) => insertNode(page, created, parentId, index))
  session.last = [created.id]
}

// ── コマンドの一覧 ──

const LAYOUT_PREFIX = (assignments: readonly [string, string][]) =>
  assignments.map(([key, value]) => [key.startsWith('layout.') ? key : `layout.${key}`, value] as [string, string])

const commands: Command[] = [
  // source
  {
    name: 'new',
    kind: 'source',
    usage: 'new [名前]',
    summary: '新しいドキュメントを作る（先頭にだけ置ける）',
    run({ session }, step) {
      checkStep(step, { positionals: 1 })
      const name = step.positionals[0] ?? 'Untitled'
      session.applyDocument(() => createDocument(name))
    },
  },

  // query
  {
    name: 'info',
    kind: 'query',
    usage: 'info',
    summary: 'ドキュメントの名前・ページ・画像・コンポーネントの数を出す',
    run({ session, print }, step) {
      checkStep(step, { positionals: 0 })
      const doc = pruneAssets(session.document)
      const bytes = Object.values(doc.assets).reduce((sum, asset) => sum + Math.floor((asset.data.length * 3) / 4), 0)
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
        `components: ${listComponents(doc).length}`,
      ]
      print(lines.join('\n'))
    },
  },
  {
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
  },
  {
    name: 'get',
    kind: 'query',
    usage: 'get ノード [項目]',
    summary: 'ノードの設定を JSON で出す。項目は layout.gap のように . でつなぐ',
    run({ session, print }, step) {
      checkStep(step, { positionals: 2 })
      const id = session.resolveOne(positional(step, 0, 'ノード'))
      const node = session.page.nodes[id]
      const key = step.positionals[1]
      const value = key === undefined ? node : getIn(node, key)
      print(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
    },
  },
  {
    name: 'find',
    kind: 'query',
    usage: 'find 文字列',
    summary: '名前かテキストの内容に文字列を含むノードを、id・種類・道筋の順で出す（大文字と小文字は区別しない）',
    run({ session, print }, step) {
      checkStep(step, { positionals: 1 })
      const page = session.page
      const ids = searchLayers(page, positional(step, 0, '文字列'))
      if (ids.length > 0) print(ids.map((id) => `${id}\t${page.nodes[id].type}\t${namePath(page, id)}`).join('\n'))
    },
  },
  {
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
  },
  {
    name: 'css',
    kind: 'query',
    usage: 'css ノード [--unit px|rem] [--rem-base 16] [--color hex|rgb|hsl]',
    summary: 'viewer のインスペクトと同じ CSS を出す',
    run({ session, print }, step) {
      checkStep(step, { options: ['unit', 'rem-base', 'color'], positionals: 1 })
      const id = session.resolveOne(positional(step, 0, 'ノード'))
      print(nodeCss(session.page, id, codeStyle(step)))
    },
  },
  {
    name: 'html',
    kind: 'query',
    usage: 'html ノード [--standalone] [--unit px|rem] [--rem-base 16] [--color hex|rgb|hsl]',
    summary: 'ノードと中身の HTML と CSS を出す。--standalone ならブラウザで開ける 1 つの HTML（画像は埋め込み）',
    flags: ['standalone'],
    run({ session, print }, step) {
      checkStep(step, { options: ['standalone', 'unit', 'rem-base', 'color'], positionals: 1 })
      const id = session.resolveOne(positional(step, 0, 'ノード'))
      const standalone = flag(step, 'standalone')
      const markup = nodeMarkup(session.page, id, {
        style: codeStyle(step),
        assets: session.document.assets,
        images: standalone ? 'embed' : 'file',
      })
      print(
        standalone
          ? standaloneHtml(session.page.nodes[id].name, markup).trimEnd()
          : `<style>\n${markup.css}\n</style>\n${markup.html}`,
      )
    },
  },
  {
    name: 'json',
    kind: 'query',
    usage: 'json [--pretty]',
    summary: 'kdr の中身（展開した JSON）を出す',
    flags: ['pretty'],
    run({ session, print }, step) {
      checkStep(step, { options: ['pretty'], positionals: 0 })
      const value = { format: KDR_FORMAT, version: KDR_VERSION, document: pruneAssets(session.document) }
      print(JSON.stringify(value, null, flag(step, 'pretty') ? 2 : undefined))
    },
  },
  {
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
  },

  // nav
  {
    name: 'page',
    kind: 'nav',
    usage: 'page ページ',
    summary: '以降のコマンドが扱うページを切り替える（id・名前・1 から数えた番号）',
    run({ session }, step) {
      checkStep(step, { positionals: 1 })
      session.setPage(resolvePage(session.document, positional(step, 0, 'ページ')).id)
    },
  },

  // edit: ドキュメントとページ
  {
    name: 'doc-name',
    kind: 'edit',
    usage: 'doc-name 名前',
    summary: 'ドキュメントの名前を変える',
    run({ session }, step) {
      checkStep(step, { positionals: 1 })
      const name = positional(step, 0, '名前')
      session.applyDocument((doc) => renameDocument(doc, name))
    },
  },
  {
    name: 'page-add',
    kind: 'edit',
    usage: 'page-add 名前 [--id ID]',
    summary: 'ページを末尾に足し、そのページに切り替える',
    run({ session }, step) {
      checkStep(step, { options: ['id'], positionals: 1 })
      const page: Page = { ...createPage(positional(step, 0, '名前')) }
      const id = option(step, 'id')
      if (id !== undefined) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new UsageError(`id には英数字と _ - だけを使えます: ${id}`)
        if (session.document.pages.some((other) => other.id === id)) throw new UsageError(`ページの id が重複しています: ${id}`)
        page.id = id
      }
      session.applyDocument((doc) => addPage(doc, page))
      session.setPage(page.id)
    },
  },
  {
    name: 'page-rename',
    kind: 'edit',
    usage: 'page-rename 名前',
    summary: 'いまのページの名前を変える',
    run({ session }, step) {
      checkStep(step, { positionals: 1 })
      const name = positional(step, 0, '名前')
      const pageId = session.page.id
      session.applyDocument((doc) => renamePage(doc, pageId, name))
    },
  },
  {
    name: 'page-rm',
    kind: 'edit',
    usage: 'page-rm [ページ]',
    summary: 'ページを消す（省略するといまのページ）。最後の 1 ページは消せない',
    run({ session }, step) {
      checkStep(step, { positionals: 1 })
      const selector = step.positionals[0]
      const page = selector === undefined ? session.page : resolvePage(session.document, selector)
      if (session.document.pages.length === 1) throw new UsageError('page-rm: 最後の 1 ページは消せません')
      session.applyDocument((doc) => removePage(doc, page.id))
    },
  },

  // edit: ノード
  {
    name: 'add',
    kind: 'edit',
    assignments: true,
    usage:
      'add 種類 [--x N --y N --width N --height N] [--parent フレーム] [--index N] [--id ID] [--name 名前] [名前=値…]\n' +
      '      種類: rect ellipse frame text（--text 文字）line（--from x,y --to x,y）\n' +
      '            path（--points "x,y x,y …" [--closed]）image（--src 画像 | --asset ID）',
    summary: 'ノードを足す。座標は親の左上が原点。作ったノードは次のコマンドで「@」で指せる',
    flags: ['closed'],
    run: add,
  },
  {
    name: 'set',
    kind: 'edit',
    assignments: true,
    usage: 'set ノード… 名前=値…',
    summary: '設定を変える（例: fill=#ff0000 cornerRadius=8 shadow.blur=4 text=こんにちは）。null で塗りなどを外す',
    run({ session }, step) {
      checkStep(step, { assignments: true })
      if (step.assignments.length === 0) throw new UsageError('set: 「名前=値」を指定してください')
      const ids = session.resolveAll(step.positionals)
      const page = session.page
      const patches = new Map(ids.map((id) => [id, buildPatch(page.nodes[id], step.assignments)]))
      const refit = step.assignments.some(([key]) => TEXT_KEYS.has(key.split('.')[0]))
      session.apply((base) =>
        patchNodes(base, ids, (node) => {
          const patch = patches.get(node.id)!
          if (!refit || node.type !== 'text') return patch
          return { ...patch, ...estimateTextSize({ ...node, ...patch } as typeof node) }
        }),
      )
    },
  },
  {
    name: 'rm',
    kind: 'edit',
    usage: 'rm ノード…',
    summary: 'ノードを中身ごと消す',
    run({ session }, step) {
      checkStep(step, {})
      const ids = session.resolveAll(step.positionals)
      session.apply((page) => removeNodes(page, ids))
    },
  },
  {
    name: 'mv',
    kind: 'edit',
    usage: 'mv ノード… (--parent フレーム | --root) [--index N]',
    summary: '別のフレームへ入れる・ページ直下へ出す。ページ上の見た目の位置は保つ。--index は兄弟の中での重なり順（0 が最背面）',
    flags: ['root'],
    run({ session }, step) {
      checkStep(step, { options: ['parent', 'root', 'index'] })
      const ids = session.resolveAll(step.positionals)
      const parent = option(step, 'parent')
      if ((parent === undefined) === !flag(step, 'root')) throw new UsageError('mv: --parent か --root のどちらかを指定してください')
      const parentId = parent === undefined ? null : session.resolveFrame(parent)
      const index = numberOption(step, 'index')
      session.apply((page) =>
        ids.reduce((next, id, i) => moveNode(next, id, parentId, index === undefined ? undefined : index + i), page),
      )
    },
  },
  {
    name: 'order',
    kind: 'edit',
    usage: 'order front|back|forward|backward ノード…',
    summary: '重なり順を変える（最前面・最背面・1 つ手前・1 つ奥）',
    run({ session }, step) {
      checkStep(step, {})
      const direction = positional(step, 0, '向き') as ReorderDirection
      if (!['front', 'back', 'forward', 'backward'].includes(direction)) {
        throw new UsageError(`order: 向きは front / back / forward / backward です: ${direction}`)
      }
      const ids = session.resolveAll(step.positionals.slice(1))
      session.apply((page) => reorderNodes(page, ids, direction))
    },
  },
  {
    name: 'dup',
    kind: 'edit',
    usage: 'dup ノード… [--offset 20]',
    summary: '複製する。複製は元から右下へ offset ずらして置き、「@」で指せる',
    run({ session }, step) {
      checkStep(step, { options: ['offset'] })
      const ids = session.resolveAll(step.positionals)
      const offset = numberOption(step, 'offset') ?? 20
      const fragment = copyFragment(session.page, session.document.assets, ids)
      let created: NodeId[] = []
      const pageId = session.page.id
      session.applyDocument((doc) => {
        const result = pasteIntoPage(doc, pageId, fragment, offset)
        created = result.ids
        return result.document
      })
      session.last = created
    },
  },

  // edit: オートレイアウト
  {
    name: 'auto-layout',
    kind: 'edit',
    assignments: true,
    usage: 'auto-layout フレーム [--off] [direction=vertical gap=8 padding=16 align=center wrap=true crossGap=8 …]',
    summary: 'フレームの中身を自動で並べるようにする（--off でやめる）。名前=値 で並べ方を変える',
    flags: ['off'],
    run({ session }, step) {
      checkStep(step, { options: ['off'], positionals: 1, assignments: true })
      const id = session.resolveFrame(positional(step, 0, 'フレーム'))
      if (flag(step, 'off')) {
        session.apply((page) => updateNode(page, id, { layout: null }))
        return
      }
      session.apply((page) => {
        const enabled = enableAutoLayout(page, id)
        return updateNode(enabled, id, buildPatch(enabled.nodes[id], LAYOUT_PREFIX(step.assignments)))
      })
    },
  },
  {
    name: 'wrap',
    kind: 'edit',
    assignments: true,
    usage: 'wrap ノード… [--name 名前] [--id ID] [direction=… gap=… padding=…]',
    summary: 'ノードを、自動で並べる新しいフレームにまとめる。まとめたフレームは「@」で指せる',
    run({ session }, step) {
      checkStep(step, { options: ['name', 'id'], assignments: true })
      const ids = session.resolveAll(step.positionals)
      const name = option(step, 'name') ?? 'Frame'
      const wanted = option(step, 'id')
      if (wanted !== undefined) checkNewId(session.page, wanted)
      let created: NodeId | null = null
      session.apply((page) => {
        const result = wrapInAutoLayout(page, ids, name)
        if (result.id === null) return page
        created = wanted ?? result.id
        const renamed = wanted === undefined ? result.scene : renameNodeId(result.scene, result.id, wanted)
        return updateNode(renamed, created, buildPatch(renamed.nodes[created], LAYOUT_PREFIX(step.assignments)))
      })
      session.last = created === null ? [] : [created]
    },
  },
  {
    name: 'layout-fill',
    kind: 'edit',
    usage: 'layout-fill width|height ノード… [--off]',
    summary: '自動で並べるフレームの子を、その向きに親いっぱいまで伸ばす（--off でやめる）',
    flags: ['off'],
    run({ session }, step) {
      checkStep(step, { options: ['off'] })
      const axis = positional(step, 0, '向き（width / height）')
      if (axis !== 'width' && axis !== 'height') throw new UsageError(`layout-fill: 向きは width か height です: ${axis}`)
      const ids = session.resolveAll(step.positionals.slice(1))
      session.apply((page) => setLayoutFill(page, ids, axis, !flag(step, 'off')))
    },
  },

  // edit: コンポーネント
  {
    name: 'component',
    kind: 'edit',
    usage: 'component フレーム',
    summary: 'フレームをコンポーネントの元にする',
    run({ session }, step) {
      checkStep(step, { positionals: 1 })
      const id = session.resolveFrame(positional(step, 0, 'フレーム'))
      session.apply((page) => makeComponent(page, id))
    },
  },
  {
    name: 'detach',
    kind: 'edit',
    usage: 'detach フレーム',
    summary: 'コンポーネントとのつながりを外す（元から外すと、インスタンスはただのフレームになる）',
    run({ session }, step) {
      checkStep(step, { positionals: 1 })
      const id = session.resolveFrame(positional(step, 0, 'フレーム'))
      session.apply((page) => detachComponent(page, id))
    },
  },
  {
    name: 'instance',
    kind: 'edit',
    usage: 'instance 元 [--parent フレーム] [--x N --y N] [--id ID] [--name 名前]',
    summary: 'コンポーネントのインスタンスを置く。元は全ページから id か名前で探す。置いたものは「@」で指せる',
    run({ session }, step) {
      checkStep(step, { options: ['parent', 'x', 'y', 'id', 'name'], positionals: 1 })
      const componentId = findComponent(session.document, positional(step, 0, '元'))
      const parent = option(step, 'parent')
      const parentId = parent === undefined ? null : session.resolveFrame(parent)
      const wanted = option(step, 'id')
      if (wanted !== undefined) checkNewId(session.page, wanted)
      const x = numberOption(step, 'x')
      const y = numberOption(step, 'y')
      const name = option(step, 'name')
      const pageId = session.page.id
      let created: NodeId | null = null
      session.applyDocument((doc) => {
        const page = doc.pages.find((candidate) => candidate.id === pageId)!
        const at = parentId === null ? undefined : { center: getWorldCenter(page, parentId), parentId }
        const result = createInstance(doc, pageId, componentId, at)
        if (result.id === null) throw new UsageError('instance: インスタンスを置けません')
        if (parentId !== null && result.document.pages.find((p) => p.id === pageId)!.nodes[result.id].parentId !== parentId) {
          throw new UsageError('instance: そのフレームの中には置けません（インスタンスの中か、元が自分自身を含むことになります）')
        }
        const id = wanted ?? result.id
        created = id
        return {
          ...result.document,
          pages: result.document.pages.map((candidate) => {
            if (candidate.id !== pageId) return candidate
            const renamed = renameNodeId(candidate, result.id!, id)
            const patch = { ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }), ...(name === undefined ? {} : { name }) }
            return updateNode(renamed, id, patch)
          }),
        }
      })
      session.last = created === null ? [] : [created]
    },
  },
]

function findComponent(doc: DesignDocument, selector: string): string {
  const mains = listComponents(doc)
  const byId = mains.filter(({ node }) => node.id === selector || node.component.id === selector)
  const found = byId.length > 0 ? byId : mains.filter(({ node }) => node.name === selector)
  if (found.length === 0) throw new UsageError(`コンポーネントの元が見つかりません: ${selector}`)
  if (found.length > 1) {
    throw new UsageError(`${selector}: 同じ名前の元が ${found.length} 個あります。id で指定してください（${found.map(({ node }) => node.id).join(', ')}）`)
  }
  return found[0].node.component.id
}

function codeStyle(step: Step): { unit?: Unit; remBase?: number; color?: ColorFormat } {
  const unit = option(step, 'unit')
  const color = option(step, 'color')
  if (unit !== undefined && unit !== 'px' && unit !== 'rem') throw new UsageError(`--unit は px か rem です: ${unit}`)
  if (color !== undefined && !['hex', 'rgb', 'hsl'].includes(color)) throw new UsageError(`--color は hex / rgb / hsl です: ${color}`)
  const remBase = numberOption(step, 'rem-base')
  if (remBase !== undefined && remBase <= 0) throw new UsageError('--rem-base は正の数です')
  return {
    ...(unit === undefined ? {} : { unit }),
    ...(color === undefined ? {} : { color: color as ColorFormat }),
    ...(remBase === undefined ? {} : { remBase }),
  }
}

export const COMMANDS: ReadonlyMap<string, Command> = new Map(commands.map((command) => [command.name, command]))
