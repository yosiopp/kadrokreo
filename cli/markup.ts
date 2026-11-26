// ノードの木を XML のマークアップで宣言的に書いたものを、ノードにする（kdr build / kdr place）。
//
//   <kdr name="Demo">
//     <page name="Page 1">
//       <frame name="Screen" width="375" height="812" fill="#ffffff" layout="column">
//         <text fontSize="17">タイトル</text>
//       </frame>
//     </page>
//   </kdr>
//
// 決まり:
// - 入れ子が親子、並び順が重なり順（先に書いたものが背面。kdr の document.json と同じ）
// - 属性は set / add の「名前=値」と同じ語彙（values.ts の buildPatch に通す）。書かなかった項目は kdr ファイルの既定値
//   （塗りなし・線なし・余白 0・間隔 0）。テキストだけは、黒・16px の sans-serif から始める（塗りのないテキストは見えないため）
// - 位置と大きさは、並べ直しと文字の測り直しが決める。組み立ては「全部のノードを置く → 並べ直しとインスタンスの同期を
//   落ち着くまでかける → インスタンスの上書きを当てる」の順で、途中の大きさ（仮の 100）で子が辺に追従しないよう、最初の後始末は自分でかける
// - id を省くと、木の道筋（名前と、同じ名前の兄弟の中での番号）のハッシュにする。同じマークアップからは同じ id になる
// - 書き間違いは「ファイル:行: 内容」のエラー（MarkupError）にする。値の誤りも、ノードごとに kdr の検証を通して行を付ける
import { OVERRIDE_KEYS, derivedId, isInstance, owningInstance } from '../src/document/component.ts'
import { subtreeIds } from '../src/document/componentSource.ts'
import { KdrError, MAX_DEPTH, kdrFile, parseKdr } from '../src/document/kdr.ts'
import { pathFromPoints } from '../src/document/path.ts'
import { sha256Hex } from '../src/document/sha256.ts'
import type { Asset, AssetId, DesignDocument, FrameNode, NodeId, Page, SceneNode } from '../src/document/types.ts'
import { canHoldInstance, listComponents, componentName, nestedInstanceOf, sameJson, swapNestedInstance, syncComponents } from '../src/editor/components.ts'
import { relayout } from '../src/editor/layout.ts'
import { createEllipse, createFrame, createImage, createLine, createPath, createRect, createText } from '../src/editor/nodes.ts'
import { addOrReuseAsset, updatePage } from '../src/editor/operations/document.ts'
import { type NodePatch, patchNodes } from '../src/editor/operations/tree.ts'
import { lineCounter, readXml } from '../src/editor/xml.ts'
import { UsageError } from './args.ts'
import { point } from './commands/common.ts'
import { pathFromData } from './commands/create.ts'
import type { Session } from './session.ts'
import { estimateTextSize, fitTextEstimated } from './textMeasure.ts'
import { buildPatch, orderAssignments } from './values.ts'

export class MarkupError extends Error {
  override name = 'MarkupError'
}

export type MarkupAttribute = { name: string; value: string; line: number }

export type MarkupElement = {
  name: string
  line: number
  attributes: MarkupAttribute[]
  children: MarkupElement[]
  /** 要素の直下の文字をつないだもの */
  text: string
  /** 空白でない文字が最初に出てきた行。なければ null */
  textLine: number | null
}

/** 読めるマークアップの大きさ（文字数）と要素の数 */
const MAX_LENGTH = 16 * 1024 * 1024
const MAX_ELEMENTS = 100_000

const NODE_ELEMENTS = ['frame', 'component', 'instance', 'rect', 'ellipse', 'line', 'path', 'text', 'image'] as const
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

type Fail = (line: number, message: string) => MarkupError

function failer(file: string): Fail {
  return (line, message) => new MarkupError(`${file}:${line}: ${message}`)
}

// ── 読み取り ──

/** マークアップを要素の木にする。file はエラーに出す名前 */
export function parseMarkup(source: string, file: string): MarkupElement {
  const fail = failer(file)
  if (source.length > MAX_LENGTH) throw fail(1, 'マークアップが大きすぎます（16MB まで）')
  const text = source.replace(/^﻿/, '')
  const lineOf = lineCounter(text)
  // 実体の定義は読まない（定義済みの 5 つと文字参照だけ）。DOCTYPE があれば、黙って読み飛ばさずに断る
  const doctype = /<!DOCTYPE|<!ENTITY/i.exec(text)
  if (doctype) throw fail(lineOf(doctype.index), 'DOCTYPE・ENTITY は書けません')
  const top: MarkupElement = { name: '#document', line: 1, attributes: [], children: [], text: '', textLine: null }
  const stack = [top]
  let count = 0
  readXml(
    text,
    {
      open({ name, attributes, selfClosing, offset, attributeOffsets }) {
        const line = lineOf(offset)
        if (++count > MAX_ELEMENTS) throw fail(line, '要素が多すぎます')
        // 上限は kdr の入れ子の深さ（<kdr> と <page> の分だけ深い）
        if (stack.length > MAX_DEPTH + 3) throw fail(line, '入れ子が深すぎます')
        if (stack.length === 1 && top.children.length > 0) throw fail(line, '最上位の要素は 1 つだけです')
        const element: MarkupElement = {
          name,
          line,
          attributes: Object.entries(attributes).map(([key, value]) => ({ name: key, value, line: lineOf(attributeOffsets![key]) })),
          children: [],
          text: '',
          textLine: null,
        }
        stack.at(-1)!.children.push(element)
        if (!selfClosing) stack.push(element)
      },
      close(name, offset) {
        const current = stack.at(-1)!
        if (stack.length <= 1 || current.name !== name) {
          throw fail(lineOf(offset), stack.length <= 1 ? `開いていない要素を閉じています: </${name}>` : `閉じタグが合いません: <${current.name}>（${current.line} 行目）を </${name}> で閉じています`)
        }
        stack.pop()
      },
      text(value, offset) {
        const current = stack.at(-1)!
        if (value.trim() === '') {
          if (current !== top) current.text += value
          return
        }
        // 字下げの後の、最初の空白でない文字の行
        const line = lineOf(offset + value.length - value.trimStart().length)
        if (current === top) throw fail(line, '要素の外に文字があります')
        current.text += value
        current.textLine ??= line
      },
    },
    { fail: (message, offset) => fail(lineOf(offset), message), positions: true, strict: true },
  )
  if (stack.length > 1) throw fail(stack.at(-1)!.line, `閉じていない要素があります: <${stack.at(-1)!.name}>`)
  const root = top.children[0]
  if (!root) throw fail(1, '要素がありません')
  return root
}

// ── 組み立て ──

/** マークアップが指す画像（src の値ごと）。読み込みはコマンドの側でする */
export type MarkupImage = { assetId: AssetId; width: number; height: number }

/** 画像の src を集める（読む順を決めるため、書いた順に、重複なく） */
export function imageSources(root: MarkupElement): { src: string; line: number }[] {
  const found = new Map<string, number>()
  const visit = (element: MarkupElement) => {
    if (element.name === 'image' || element.name === 'override') {
      const src = element.attributes.find((attribute) => attribute.name === 'src')
      if (src && !found.has(src.value)) found.set(src.value, src.line)
    }
    for (const child of element.children) visit(child)
  }
  visit(root)
  return [...found].map(([src, line]) => ({ src, line }))
}

/** 読んだ画像をドキュメントのアセットに足す（同じ中身ならあるものを使う。id は中身のハッシュ）。assets は書き換える */
export function addMarkupImage(assets: Record<AssetId, Asset>, src: string, asset: Asset): AssetId {
  const added = addOrReuseAsset({ name: '', pages: [], assets, fonts: [] }, asset, () => hashId(`asset:${src}`))
  assets[added.assetId] = added.document.assets[added.assetId]
  return added.assetId
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** 種（木の道筋など）から決まる id。editor が振る id と同じ 12 文字（英数字だけ） */
function hashId(seed: string): string {
  const hex = sha256Hex(new TextEncoder().encode(seed))
  let id = ''
  for (let i = 0; i < 12; i++) id += ID_ALPHABET[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % ID_ALPHABET.length]
  return id
}

/** まだ使っていない id を、種から決める（ぶつかったら種に番号を足して決め直す）。taken に足す */
function uniqueId(seed: string, taken: Set<string>): string {
  for (let n = 0; ; n++) {
    const id = hashId(n === 0 ? seed : `${seed}~${n}`)
    if (taken.has(id)) continue
    taken.add(id)
    return id
  }
}

type ComponentTarget = { componentId: string; name: string }

/** あとで当てる、インスタンスの上書き */
type PendingInstance = {
  pageId: string
  instanceId: NodeId
  element: MarkupElement
  /** インスタンスの根に書いた、元の値の上書き（fill など） */
  root: MarkupAttribute[]
}

type Scope = {
  fail: Fail
  images: ReadonlyMap<string, MarkupImage>
  assets: Record<AssetId, Asset>
  /** <instance of="…"> の指す元 */
  component: (of: MarkupAttribute) => ComponentTarget
  /** 要素に振った id */
  ids: Map<MarkupElement, NodeId>
  /** <component> に振ったコンポーネントの id */
  componentIds: Map<MarkupElement, string>
  pending: PendingInstance[]
}

/** kdr として読める値かを、ノード 1 つで確かめる（子とコンポーネントのつながりは、最後の全体の検証が見る） */
function validateNode(node: SceneNode, assets: Record<AssetId, Asset>): void {
  const lone = node.type === 'frame' ? { ...node, parentId: null, children: [], component: null } : { ...node, parentId: null }
  const page = { id: 'p', name: 'p', nodes: { [node.id]: lone }, rootIds: [node.id] }
  parseKdr(JSON.parse(JSON.stringify(kdrFile({ name: 'x', pages: [page] }))), assets)
}

/** UsageError・KdrError の文面から、コマンドやファイルの中の場所の前置きを除く */
function plainMessage(error: Error): string {
  return error.message
    .replace(/^pages\[0\]\.children\[0\]\.?/, '')
    .replace(/^: /, '')
    .replace(' は set では変えられません', ' は指定できません')
}

/**
 * 属性を set / add と同じ決まりでノードに当てる。誤りがあれば、どの属性かを 1 つずつ足して探し、その行のエラーにする
 */
function patchNode<N extends SceneNode>(scope: Scope, element: MarkupElement, node: N, attributes: readonly MarkupAttribute[]): N {
  const attempt = (pairs: readonly [string, string][]) => {
    const next = { ...node, ...buildPatch(node, pairs) } as N
    validateNode(next, scope.assets)
    return next
  }
  const pairs = attributes.map(({ name, value }) => [name, value] as [string, string])
  try {
    return attempt(pairs)
  } catch (error) {
    if (!(error instanceof UsageError || error instanceof KdrError)) throw error
    const ordered = orderAssignments(pairs)
    for (let count = 1; count <= ordered.length; count++) {
      try {
        attempt(ordered.slice(0, count))
      } catch (inner) {
        if (!(inner instanceof UsageError || inner instanceof KdrError)) throw inner
        const [name, value] = ordered[count - 1]
        const line = attributes.find((attribute) => attribute.name === name)!.line
        const message = plainMessage(inner)
        throw scope.fail(line, `${name}="${value}": ${message.startsWith(`${name}: `) ? message.slice(name.length + 2) : message}`)
      }
    }
    throw scope.fail(element.line, plainMessage(error))
  }
}

/** UsageError（座標やパスの書き方の誤り）を、その行のエラーにする */
function guard<T>(scope: Scope, line: number, run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof UsageError) throw scope.fail(line, error.message)
    throw error
  }
}

/** <text> の中身。前後の空行と、各行の字下げは除く。途中の改行はそのまま改行になる */
function textContent(element: MarkupElement): string {
  const lines = element.text.split(/\r?\n/).map((line) => line.trim())
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  return lines.join('\n')
}

/** ノードの属性のうち、種類ごとに自分で読むもの（残りは buildPatch に渡す） */
const STRUCTURAL: Record<(typeof NODE_ELEMENTS)[number], readonly string[]> = {
  frame: ['id'],
  component: ['id'],
  instance: ['id', 'of'],
  rect: ['id'],
  ellipse: ['id'],
  line: ['id', 'from', 'to'],
  path: ['id', 'd', 'points', 'closed'],
  text: ['id'],
  image: ['id', 'src'],
}

/** 属性では決められない項目（木の形から決まる） */
const FORBIDDEN = new Set(['type', 'parentId', 'children', 'component', 'assetId'])

/** インスタンスが自分で持つ項目（ほかは元で決まる。塗りと線は上書きにできる） */
const INSTANCE_OWN = new Set(['name', 'x', 'y', 'rotation', 'visible', 'locked', 'opacity', 'blendMode', 'width', 'height'])
const INSTANCE_ROOT_OVERRIDES = new Set(['fills', 'strokes', 'strokeDashes', 'strokeDashOffset'])

const isNodeElement = (name: string): name is (typeof NODE_ELEMENTS)[number] => (NODE_ELEMENTS as readonly string[]).includes(name)

/** 要素 1 つ（と子孫）をノードにして scene に足す。parent は入れる先のフレーム（ページ直下なら null） */
function buildElement(
  scope: Scope,
  scene: { id: string; nodes: Record<NodeId, SceneNode>; rootIds: NodeId[] },
  element: MarkupElement,
  parent: FrameNode | null,
  depth: number,
): void {
  const { fail } = scope
  const kind = element.name
  if (!isNodeElement(kind)) {
    throw fail(element.line, kind === 'override' ? '<override> は <instance> の中にだけ書けます' : `知らない要素です: <${kind}>（${NODE_ELEMENTS.join(' ')}）`)
  }
  if (depth > MAX_DEPTH) throw fail(element.line, 'フレームの入れ子が深すぎます')
  const attribute = (name: string) => element.attributes.find((candidate) => candidate.name === name)
  const required = (name: string, hint: string) => {
    const found = attribute(name)
    if (!found) throw fail(element.line, `<${kind}> には ${name} が要ります（${hint}）`)
    return found
  }
  for (const { name, line } of element.attributes) {
    if (FORBIDDEN.has(name)) throw fail(line, `${name} は属性では指定できません`)
  }
  if (kind !== 'text' && element.textLine !== null) throw fail(element.textLine, `<${kind}> の中に文字は書けません（文字は <text> に書く）`)
  if (kind !== 'frame' && kind !== 'component' && kind !== 'instance' && element.children.length > 0) {
    throw fail(element.children[0].line, `<${kind}> の中に要素は書けません（子を持てるのは <frame> と <component>）`)
  }

  const id = scope.ids.get(element)!
  const rest = element.attributes.filter(({ name }) => !STRUCTURAL[kind].includes(name))
  const at = { x: 0, y: 0, width: 100, height: 100 }
  let node: SceneNode

  if (kind === 'instance') {
    const target = scope.component(required('of', '元の <component> の id か名前'))
    const own = rest.filter(({ name }) => INSTANCE_OWN.has(name))
    for (const { name, value, line } of own) {
      if ((name === 'width' || name === 'height') && value.trim() !== 'fill') {
        throw fail(line, `${name}="${value}": インスタンスの大きさは元の <component> で決まります（指定できるのは fill だけ）`)
      }
    }
    const frame: FrameNode = {
      ...createFrame(at),
      id,
      fills: [],
      name: target.name,
      component: { id: target.componentId, role: 'instance', overrides: {}, flipX: false, flipY: false },
    }
    node = patchNode(scope, element, frame, own)
    for (const child of element.children) {
      if (child.name !== 'override') throw fail(child.line, `<instance> の中に書けるのは <override> だけです: <${child.name}>`)
    }
    scope.pending.push({ pageId: scene.id, instanceId: id, element, root: rest.filter(({ name }) => !INSTANCE_OWN.has(name)) })
  } else {
    let created: SceneNode
    switch (kind) {
      case 'rect':
        created = { ...createRect(at), fills: [] }
        break
      case 'ellipse':
        created = { ...createEllipse(at), fills: [] }
        break
      case 'frame':
        created = { ...createFrame(at), fills: [] }
        break
      case 'component':
        created = { ...createFrame(at), fills: [], component: { id: scope.componentIds.get(element)!, role: 'main', description: '', properties: [] } }
        break
      case 'line': {
        const from = required('from', '始点 "x,y"')
        const to = required('to', '終点 "x,y"')
        const ends = [guard(scope, from.line, () => point(from.value, 'from')), guard(scope, to.line, () => point(to.value, 'to'))]
        created = { ...createLine(pathFromPoints(ends)), fills: [], strokes: [] }
        break
      }
      case 'path': {
        const d = attribute('d')
        const points = attribute('points')
        const closedAttribute = attribute('closed')
        if (closedAttribute && closedAttribute.value !== 'true' && closedAttribute.value !== 'false') {
          throw fail(closedAttribute.line, `closed="${closedAttribute.value}": true か false を指定してください`)
        }
        const closed = closedAttribute?.value === 'true'
        if (d && points) throw fail(points.line, 'd と points は一緒に指定できません')
        if (d) created = { ...guard(scope, d.line, () => pathFromData(d.value, closed, 'd')), fills: [], strokes: [] }
        else if (points) {
          const vertices = guard(scope, points.line, () => points.value.trim().split(/\s+/).map((part) => point(part, 'points')))
          if (vertices.length < 2) throw fail(points.line, 'points: 頂点は 2 つ以上です')
          created = { ...createPath(pathFromPoints(vertices), closed), fills: [], strokes: [] }
        } else throw fail(element.line, '<path> には d（SVG の path の d）か points（"x,y x,y …"）が要ります')
        break
      }
      case 'text': {
        const written = attribute('text')
        if (written && element.textLine !== null) throw fail(written.line, '文字は、要素の中身か text 属性のどちらかに書きます')
        const height = attribute('height')
        if (height) throw fail(height.line, 'テキストの高さは中身で決まるので、height は指定できません')
        created = createText(at, written ? '' : textContent(element))
        break
      }
      case 'image': {
        const src = required('src', '画像ファイル。マークアップのファイルからの相対パス')
        const image = scope.images.get(src.value)!
        // 大きさを片方だけ書いたら、縦横比を保つ（add image と同じ）
        const numeric = (name: string) => {
          const value = attribute(name)?.value.trim() ?? ''
          return /^\d+(\.\d+)?$/.test(value) ? Number(value) : undefined
        }
        const width = numeric('width')
        const height = numeric('height')
        const ratio = image.height === 0 ? 1 : image.width / image.height
        created = createImage(
          {
            x: 0,
            y: 0,
            width: Math.max(1, width ?? (height !== undefined ? height * ratio : image.width)),
            height: Math.max(1, height ?? (width !== undefined ? width / ratio : image.height)),
          },
          image.assetId,
        )
        break
      }
    }
    node = patchNode(scope, element, { ...created, id }, rest)
    // 大きさを書かなくてよいのは、中身や形から決まるもの（自動で並べるフレーム・テキスト・画像・線・パス）だけ
    const sized = node.type === 'rect' || node.type === 'ellipse' || (node.type === 'frame' && !node.layout)
    for (const axis of ['width', 'height'] as const) {
      if (sized && !attribute(axis)) throw fail(element.line, `<${kind}> には ${axis} が要ります（数値か fill。自動で並べるフレームなら省ける）`)
      if (node.sizing[axis] === 'hug' && node.type === 'frame' && !node.layout) {
        throw fail(attribute(axis)?.line ?? element.line, `${axis}="hug" は、自動で並べるフレーム（layout="row|column"）とテキストの幅にだけ使えます`)
      }
    }
    if (node.type === 'text') node = { ...node, ...estimateTextSize(node) }
  }

  // 親いっぱいに伸ばす（fill）のは、伸ばす先が決まるときだけ
  for (const axis of ['width', 'height'] as const) {
    if (node.sizing[axis] !== 'fill') continue
    const line = attribute(axis)?.line ?? element.line
    if (!parent?.layout) throw fail(line, `${axis}="fill" は、自動で並べるフレーム（layout="row|column"）の子でだけ使えます`)
    const along = (parent.layout.direction === 'horizontal') === (axis === 'width')
    if (along && parent.sizing[axis] === 'hug') {
      throw fail(line, `${axis}="fill": 親の ${axis} が中身に合わせる（hug）なので伸ばせません。親の ${axis} を数値か fill にしてください`)
    }
  }

  const placed = { ...node, parentId: parent?.id ?? null } as SceneNode
  scene.nodes[id] = placed
  if (parent) parent.children.push(id)
  else scene.rootIds.push(id)
  if (placed.type === 'frame' && kind !== 'instance') {
    // children は createFrame が作った、このノードだけの配列
    for (const child of element.children) buildElement(scope, scene, child, placed, depth + 1)
  }
}

/** 要素と子孫に id を振る。書いてあればそれ、なければ木の道筋から決める */
function assignIds(scope: Scope, elements: readonly MarkupElement[], seed: string, taken: Set<string>): void {
  // 書いてある id を先に確かめる（決めた id が、後に書いてある id とぶつからないように）
  const explicit = (element: MarkupElement) => {
    if (element.name === 'override') return
    const id = element.attributes.find((attribute) => attribute.name === 'id')
    if (id) {
      if (!ID_PATTERN.test(id.value)) throw scope.fail(id.line, `id="${id.value}": id には英数字と _ - だけを 64 文字まで使えます`)
      if (taken.has(id.value)) throw scope.fail(id.line, `id="${id.value}": id が重複しています`)
      taken.add(id.value)
    }
    element.children.forEach(explicit)
  }
  elements.forEach(explicit)
  const derive = (siblings: readonly MarkupElement[], path: string) => {
    const seen = new Map<string, number>()
    for (const element of siblings) {
      if (element.name === 'override') continue
      const written = element.attributes.find((attribute) => attribute.name === 'id')?.value
      // 道筋の 1 段は、id を書いていればそれ、なければ名前（なければ要素名）と、同じ名前の兄弟の中での番号
      const label = written !== undefined ? `#${written}` : (element.attributes.find((attribute) => attribute.name === 'name')?.value ?? `<${element.name}>`)
      const nth = seen.get(label) ?? 0
      seen.set(label, nth + 1)
      const here = `${path}/${label}${nth === 0 ? '' : `~${nth}`}`
      scope.ids.set(element, written ?? uniqueId(here, taken))
      derive(element.children, here)
    }
  }
  derive(elements, seed)
}

type LocalComponent = ComponentTarget & { id: string | undefined }

/** マークアップの中の <component> を集め、コンポーネントの id を決める */
function collectComponents(scope: Scope, elements: readonly MarkupElement[], pageKey: string, taken: Set<string>, found: LocalComponent[]): void {
  for (const element of elements) {
    if (element.name === 'component') {
      const componentId = uniqueId(`component:${pageKey}:${scope.ids.get(element)}`, taken)
      scope.componentIds.set(element, componentId)
      found.push({
        componentId,
        name: element.attributes.find((attribute) => attribute.name === 'name')?.value ?? 'Frame',
        id: element.attributes.find((attribute) => attribute.name === 'id')?.value,
      })
    }
    collectComponents(scope, element.children, pageKey, taken, found)
  }
}

/** of="…" の指す元を探す関数。マークアップの中の <component>（id、名前の順）、なければ今のドキュメントの元 */
function componentResolver(fail: Fail, locals: readonly LocalComponent[], doc: DesignDocument | null): Scope['component'] {
  return (of) => {
    const pick = (candidates: readonly ComponentTarget[], what: string): ComponentTarget | null => {
      if (candidates.length > 1) throw fail(of.line, `of="${of.value}": 同じ${what}の元が ${candidates.length} 個あります。<component> に id を付けて、その id で指してください`)
      return candidates[0] ?? null
    }
    const local = pick(locals.filter((component) => component.id === of.value), ' id ') ?? pick(locals.filter((component) => component.name === of.value), '名前')
    if (local) return local
    const mains = doc ? listComponents(doc) : []
    const existing = (matches: typeof mains) => matches.map((main) => ({ componentId: main.node.component.id, name: componentName(main) }))
    const found =
      pick(existing(mains.filter(({ node }) => node.id === of.value || node.component.id === of.value)), ' id ') ??
      pick(existing(mains.filter(({ node }) => node.name === of.value)), '名前')
    if (!found) throw fail(of.line, `of="${of.value}": コンポーネントの元（<component>）が見つかりません`)
    return found
  }
}

function checkAttributes(fail: Fail, element: MarkupElement, allowed: readonly string[]): void {
  for (const { name, line } of element.attributes) {
    if (!allowed.includes(name)) throw fail(line, `<${element.name}> に ${name} は指定できません（${allowed.join(' ')}）`)
  }
  if (element.textLine !== null) throw fail(element.textLine, `<${element.name}> の中に文字は書けません（文字は <text> に書く）`)
}

export type MarkupBuild = {
  /** あとで当てる、インスタンスの上書き（applyMarkupOverrides に渡す） */
  pending: PendingInstance[]
  scope: Scope
}

function newScope(file: string, images: ReadonlyMap<string, MarkupImage>, assets: Record<AssetId, Asset>): Scope {
  const fail = failer(file)
  return {
    fail,
    images,
    assets,
    component: (of) => {
      throw fail(of.line, 'of は <instance> にだけ書けます')
    },
    ids: new Map(),
    componentIds: new Map(),
    pending: [],
  }
}

/** インスタンスを入れると元が自分自身を含むことにならないかを確かめる */
function checkCycles(scope: Scope, doc: DesignDocument): void {
  for (const { pageId, instanceId, element } of scope.pending) {
    const page = doc.pages.find((candidate) => candidate.id === pageId)!
    const node = page.nodes[instanceId] as FrameNode
    if (node.parentId !== null && !canHoldInstance(doc, page, node.parentId, node.component!.id)) {
      throw scope.fail(element.line, 'ここに <instance> を置くと、元の <component> が自分自身を含むことになります')
    }
  }
}

/**
 * <kdr> を根にしたマークアップから、ドキュメント全体を作る（並べ直しと同期はまだ。settleMarkup を通す）。
 * assets は、読んだ画像を入れたアセット（addMarkupImage）
 */
export function buildMarkupDocument(
  root: MarkupElement,
  file: string,
  images: ReadonlyMap<string, MarkupImage>,
  assets: Record<AssetId, Asset>,
): { document: DesignDocument; build: MarkupBuild } {
  const scope = newScope(file, images, assets)
  const { fail } = scope
  if (root.name !== 'kdr') {
    throw fail(root.line, isNodeElement(root.name) ? `最上位は <kdr> です（<${root.name}> から始まる木の一部は、kdr place で今の kdr に足せます）` : `最上位は <kdr> です: <${root.name}>`)
  }
  checkAttributes(fail, root, ['name'])
  if (root.children.length === 0) throw fail(root.line, '<kdr> には <page> が 1 つ以上要ります')
  const pageIds = new Set<string>()
  for (const element of root.children) {
    if (element.name !== 'page') throw fail(element.line, `<kdr> の直下に書けるのは <page> だけです: <${element.name}>`)
    checkAttributes(fail, element, ['name', 'id'])
    const id = element.attributes.find((attribute) => attribute.name === 'id')
    if (id) {
      if (!ID_PATTERN.test(id.value)) throw fail(id.line, `id="${id.value}": id には英数字と _ - だけを 64 文字まで使えます`)
      if (pageIds.has(id.value)) throw fail(id.line, `id="${id.value}": ページの id が重複しています`)
      pageIds.add(id.value)
    }
  }
  const names = new Map<string, number>()
  const pages = root.children.map((element, index) => {
    const name = element.attributes.find((attribute) => attribute.name === 'name')?.value ?? `Page ${index + 1}`
    const nth = names.get(name) ?? 0
    names.set(name, nth + 1)
    const id = element.attributes.find((attribute) => attribute.name === 'id')?.value ?? uniqueId(`page:${name}${nth === 0 ? '' : `~${nth}`}`, pageIds)
    return { element, scene: { id, name, nodes: {} as Record<NodeId, SceneNode>, rootIds: [] as NodeId[] } }
  })
  // ノードの id はページの中でだけ一意
  for (const { element } of pages) assignIds(scope, element.children, '', new Set())
  const locals: LocalComponent[] = []
  const componentIds = new Set<string>()
  for (const { element, scene } of pages) collectComponents(scope, element.children, scene.id, componentIds, locals)
  scope.component = componentResolver(fail, locals, null)
  for (const { element, scene } of pages) {
    for (const child of element.children) buildElement(scope, scene, child, null, 0)
  }
  const document: DesignDocument = {
    name: root.attributes.find((attribute) => attribute.name === 'name')?.value ?? 'Untitled',
    pages: pages.map(({ scene }) => scene),
    assets,
    fonts: [],
  }
  checkCycles(scope, document)
  return { document, build: { pending: scope.pending, scope } }
}

/**
 * ノードの要素を根にしたマークアップ（木の一部）を、doc の page の parent（null ならページ直下）に足す。
 * id を省いたノードの id は、入れる先と木の道筋から決める（同じものを 2 度置いてもぶつからない）
 */
export function placeMarkupFragment(
  root: MarkupElement,
  file: string,
  images: ReadonlyMap<string, MarkupImage>,
  doc: DesignDocument,
  pageId: string,
  parentId: NodeId | null,
  index: number | undefined,
  at: { x?: number; y?: number },
): { document: DesignDocument; id: NodeId; build: MarkupBuild } {
  const scope = newScope(file, images, doc.assets)
  const { fail } = scope
  if (!isNodeElement(root.name)) {
    throw fail(root.line, root.name === 'kdr' ? '<kdr> から始まるマークアップは、kdr build でドキュメントにします（place に渡すのはノードの要素 1 つ）' : `知らない要素です: <${root.name}>（${NODE_ELEMENTS.join(' ')}）`)
  }
  const page = doc.pages.find((candidate) => candidate.id === pageId)!
  const parent = parentId === null ? null : (page.nodes[parentId] as FrameNode)
  assignIds(scope, [root], `place:${parentId ?? ''}`, new Set(Object.keys(page.nodes)))
  const locals: LocalComponent[] = []
  collectComponents(scope, [root], pageId, new Set(listComponents(doc).map(({ node }) => node.component.id)), locals)
  scope.component = componentResolver(fail, locals, doc)

  // 親の並べ方（fill を書けるか）を見るために親を渡すが、親の children には足さない（足すのは insert のとき）
  const scene = { id: pageId, nodes: {} as Record<NodeId, SceneNode>, rootIds: [] as NodeId[] }
  buildElement(scope, scene, root, parent ? { ...parent, children: [] } : null, parent ? depthOf(page, parent.id) + 1 : 0)
  const id = scope.ids.get(root)!
  const { [id]: built, ...descendants } = scene.nodes
  const placed = { ...built, ...(at.x === undefined ? {} : { x: at.x }), ...(at.y === undefined ? {} : { y: at.y }) }
  const siblings = parent ? [...parent.children] : [...page.rootIds]
  siblings.splice(index === undefined ? siblings.length : Math.max(0, Math.min(siblings.length, index)), 0, id)
  const nodes: Record<NodeId, SceneNode> = { ...page.nodes, ...descendants, [id]: placed }
  if (parent) nodes[parent.id] = { ...parent, children: siblings }
  const next: Page = { ...page, nodes, rootIds: parent ? page.rootIds : siblings }
  const document = updatePage(doc, pageId, () => next)
  checkCycles(scope, document)
  return { document, id, build: { pending: scope.pending, scope } }
}

function depthOf(page: Page, id: NodeId): number {
  let depth = 0
  for (let parent = page.nodes[id].parentId; parent !== null; parent = page.nodes[parent].parentId) depth++
  return depth
}

// ── 並べ直しと同期 ──

/**
 * pageIds のページを並べ直し、インスタンスを元に合わせるのを、落ち着くまで繰り返す。
 * ストアの後始末は 1 回の変更で数回までしか繰り返さないので、木をまとめて置いたとき（親いっぱいに伸ばす指定が何段も続くとき）は足りない。
 * また、大きさが仮のままストアに渡すと、並べ直しで大きさが決まったフレームの子が、仮の大きさからの変化に追従してずれる
 */
export function settleMarkup(doc: DesignDocument, pageIds: ReadonlySet<string>): DesignDocument {
  let current = doc
  for (let round = 0; round < 64; round++) {
    const pages = current.pages.map((page) => (pageIds.has(page.id) ? relayout(page, fitTextEstimated) : page))
    const arranged = pages.every((page, index) => page === current.pages[index]) ? current : { ...current, pages }
    const synced = syncComponents(arranged, fitTextEstimated)
    if (synced === current) break
    current = synced
  }
  return current
}

// ── インスタンスの上書き ──

/** インスタンスの中身（写し）を、元の側の id か、レイヤー名（「親/子」の道筋でもよい）で探す */
function findCopies(page: Page, instanceId: NodeId, selector: string): NodeId[] {
  const inside = subtreeIds(page, instanceId).filter((id) => id !== instanceId)
  const direct = derivedId(instanceId, selector)
  if (inside.includes(direct)) return [direct]
  const names = selector.split('/')
  return inside.filter((id) => {
    let current: SceneNode | undefined = page.nodes[id]
    for (let i = names.length - 1; i >= 0; i--) {
      if (current === undefined || current.id === instanceId || current.name !== names[i]) return false
      current = current.parentId === null ? undefined : page.nodes[current.parentId]
    }
    return true
  })
}

const TEXT_KEYS = ['text', 'fontSize', 'fontFamily', 'fontWeight', 'letterSpacing']

/**
 * <instance> の上書き（根に書いた fill など・<override node="…">）を当てる。中身は同期してから入るので、settleMarkup を通した後で呼ぶ。
 * 写しを書き換えるだけで、上書きとして覚えるのはストアの後始末（editor で写しを編集するのと同じ道）
 */
export function applyMarkupOverrides(session: Session, { pending, scope }: MarkupBuild): void {
  const { fail } = scope
  const pageOf = (pageId: string) => session.document.pages.find((page) => page.id === pageId)!
  const target = (item: PendingInstance, override: MarkupElement): NodeId => {
    const node = override.attributes.find((attribute) => attribute.name === 'node')
    if (!node) throw fail(override.line, '<override> には node が要ります（上書きするレイヤーの名前。「親/子」の道筋でもよい）')
    if (override.children.length > 0) throw fail(override.children[0].line, '<override> の中に要素は書けません')
    if (override.textLine !== null) throw fail(override.textLine, '<override> の中に文字は書けません（文言は text="…" で）')
    const page = pageOf(item.pageId)
    const found = findCopies(page, item.instanceId, node.value)
    if (found.length === 1) return found[0]
    if (found.length > 1) throw fail(node.line, `node="${node.value}": 同じ名前のレイヤーが ${found.length} 個あります。「親/子」の道筋で指してください`)
    const names = [...new Set(subtreeIds(page, item.instanceId).filter((id) => id !== item.instanceId).map((id) => page.nodes[id].name))]
    throw fail(node.line, `node="${node.value}": インスタンスの中に、その名前のレイヤーがありません（あるのは ${names.join('、')}）`)
  }

  // 入れ子のインスタンスの差し替え（中身の形が変わるので、ほかの上書きより先に、1 つずつ同期する）
  for (const item of pending) {
    for (const override of item.element.children) {
      const of = override.attributes.find((attribute) => attribute.name === 'of')
      if (!of) continue
      const copyId = target(item, override)
      const { componentId } = scope.component(of)
      const nested = nestedInstanceOf(session.document, pageOf(item.pageId), copyId)
      if (!nested) throw fail(of.line, `of="${of.value}": 差し替えられるのは、元の中に置いたインスタンスだけです`)
      if (nested.componentId === componentId) continue
      const before = session.document
      session.applyDocument((doc) => swapNestedInstance(doc, item.pageId, copyId, componentId))
      if (session.document === before) throw fail(of.line, `of="${of.value}": 差し替えられません（元が自分自身を含むことになります）`)
    }
  }

  // 値の上書き。写しをまとめて書き換える
  type Patched = { patch: Record<string, unknown>; before: Record<string, unknown>; line: number }
  const patches = new Map<string, Map<NodeId, Patched>>()
  const add = (item: PendingInstance, nodeId: NodeId, element: MarkupElement, attributes: readonly MarkupAttribute[], allowed: ReadonlySet<string>, extra: NodePatch) => {
    const node = pageOf(item.pageId).nodes[nodeId]
    const pairs = attributes.map(({ name, value }) => [name, value] as [string, string])
    // 上書きにできない項目は、当てても次の同期で元に戻る。黙って捨てずに断る
    for (const attribute of attributes) {
      let keys: string[]
      try {
        keys = Object.keys(buildPatch(node, [[attribute.name, attribute.value]]))
      } catch (error) {
        if (error instanceof UsageError) throw fail(attribute.line, `${attribute.name}="${attribute.value}": ${error.message}`)
        throw error
      }
      const refused = keys.find((key) => !allowed.has(key))
      if (refused !== undefined) {
        throw fail(attribute.line, `${attribute.name}: インスタンスごとには変えられない項目です（変えられるのは ${[...allowed].join(' ')}。ほかは元の <component> で決める）`)
      }
    }
    const patched = patchNode(scope, element, node, attributes)
    const patch: Record<string, unknown> = { ...buildPatch(node, pairs), ...extra }
    const keys = Object.keys(patch)
    if (keys.length === 0) return
    const before = Object.fromEntries(keys.map((key) => [key, (node as unknown as Record<string, unknown>)[key]]))
    if (patched.type === 'text' && keys.some((key) => TEXT_KEYS.includes(key))) Object.assign(patch, estimateTextSize({ ...patched, ...extra } as typeof patched))
    let page = patches.get(item.pageId)
    if (!page) patches.set(item.pageId, (page = new Map()))
    if (page.has(nodeId)) throw fail(element.line, '同じレイヤーへの <override> が 2 つあります。1 つにまとめてください')
    page.set(nodeId, { patch, before, line: element.line })
  }
  const overridable = new Set<string>(OVERRIDE_KEYS.filter((key) => key !== 'componentId' && key !== 'assetId'))
  for (const item of pending) {
    if (item.root.length > 0) add(item, item.instanceId, item.element, item.root, INSTANCE_ROOT_OVERRIDES, {})
    for (const override of item.element.children) {
      const copyId = target(item, override)
      const src = override.attributes.find((attribute) => attribute.name === 'src')
      const extra: NodePatch = {}
      if (src) {
        if (pageOf(item.pageId).nodes[copyId].type !== 'image') throw fail(src.line, 'src: 画像のレイヤーにだけ指定できます')
        Object.assign(extra, { assetId: scope.images.get(src.value)!.assetId })
      }
      const attributes = override.attributes.filter(({ name }) => name !== 'node' && name !== 'of' && name !== 'src')
      if (attributes.length === 0 && !src && !override.attributes.some(({ name }) => name === 'of')) {
        throw fail(override.line, '<override> に上書きする項目がありません（text="…" fill="…" visible="false" など）')
      }
      add(item, copyId, override, attributes, overridable, extra)
    }
  }
  if (patches.size === 0) return
  session.applyDocument((doc) =>
    [...patches].reduce(
      (next, [pageId, byNode]) =>
        updatePage(next, pageId, (page) => patchNodes(page, [...byNode.keys()], (node) => (byNode.get(node.id)?.patch as NodePatch | undefined) ?? null)),
      doc,
    ),
  )
  // 当てた値が同期のあとも残っているか（テキストの塗りを外す、など上書きにならないものは、元の値に戻っている）
  for (const [pageId, byNode] of patches) {
    const page = pageOf(pageId)
    for (const [nodeId, { patch, before, line }] of byNode) {
      const node = page.nodes[nodeId] as unknown as Record<string, unknown> | undefined
      const lost = Object.keys(before).find((key) => !node || (!sameJson(before[key], patch[key]) && sameJson(node[key], before[key])))
      if (lost !== undefined) throw fail(line, `${lost} は、このレイヤーでは上書きできません`)
    }
  }
}

/** インスタンスかその中身か（place で、入れる先に選べないもの） */
export function insideInstance(page: Page, id: NodeId): boolean {
  return isInstance(page.nodes[id]) || owningInstance(page, id) !== null
}
