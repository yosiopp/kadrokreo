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
import { type MainNode, OVERRIDE_KEYS, derivedId, findMain, isInstance, isMain, owningInstance } from '../src/document/component.ts'
import { canBindProperty, enclosingMainNode, instanceProperties } from '../src/document/componentProperties.ts'
import { namePath, pathIndex, subtreeIds } from '../src/document/componentSource.ts'
import { KDR_MAX_GUIDES, KdrError, MAX_DEPTH, VARIABLE_TYPES, kdrFile, parseKdr } from '../src/document/kdr.ts'
import { pathFromPoints } from '../src/document/path.ts'
import { polygonSize } from '../src/document/polygon.ts'
import { sha256Hex } from '../src/document/sha256.ts'
import { MAX_CODE_LENGTH, isCodeFrom, isCodeName, isCodePropName } from '../src/document/codeComponent.ts'
import type { Asset, AssetId, CodeComponent, CodeProp, ComponentProperty, DesignDocument, FrameNode, ModeSelection, NodeId, Page, PageGuide, PathNode, SceneNode, Variable, VariableCollection, VariableType, VariableValue } from '../src/document/types.ts'
import { applyVariables } from '../src/document/variables.ts'
import { DEFAULT_VARIABLE_VALUES } from '../src/editor/operations/variables.ts'
import { type VariantProps, formatVariantName, isVariantSet, parseVariantName, propValue, variantSetOf, variantsIn } from '../src/document/variants.ts'
import { alignVariantProperties, setInstanceProperty } from '../src/editor/componentProperties.ts'
import { canHoldInstance, listComponents, componentName, nestedInstanceOf, sameJson, swapNestedInstance, syncComponents } from '../src/editor/components.ts'
import { fillBlocked } from '../src/document/autoLayout.ts'
import { relayout } from '../src/editor/layout.ts'
import { createEllipse, createFrame, createImage, createLine, createPath, createRect, createText } from '../src/editor/nodes.ts'
import { addOrReuseAsset, updatePage } from '../src/editor/operations/document.ts'
import { type NodePatch, patchNodes } from '../src/editor/operations/tree.ts'
import { lineCounter, readXml } from '../src/editor/xml.ts'
import { UsageError } from './args.ts'
import { point } from './commands/common.ts'
import { pathFromData, polygonShape } from './commands/create.ts'
import type { Session } from './session.ts'
import { estimateTextSize, fitTextEstimated } from './textMeasure.ts'
import { buildPatch, findVariableByRef, orderAssignments } from './values.ts'

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
  /** <component> / <component-set> の中に書いた <code-prop>（実装側の部品の props の読み替え）。ノードの子とは分けて持つ */
  codeProps?: MarkupElement[]
}

/** 読めるマークアップの大きさ（文字数）と要素の数 */
const MAX_LENGTH = 16 * 1024 * 1024
const MAX_ELEMENTS = 100_000

const NODE_ELEMENTS = ['frame', 'component', 'component-set', 'instance', 'rect', 'ellipse', 'polygon', 'star', 'line', 'path', 'text', 'image'] as const
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
        const parent = stack.at(-1)!
        if (name === 'code-prop') {
          if (parent.name !== 'component' && parent.name !== 'component-set') {
            throw fail(line, '<code-prop> は <component> か <component-set> の中にだけ書けます')
          }
          ;(parent.codeProps ??= []).push(element)
        } else parent.children.push(element)
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
  const added = addOrReuseAsset({ name: '', pages: [], assets, fonts: [], collections: [] }, asset, () => hashId(`asset:${src}`))
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

/** あとで結ぶ、コンポーネントのプロパティ（prop="…" / prop.visible="…"） */
type PendingBinding = { pageId: string; mainId: NodeId; targetId: NodeId; type: ComponentProperty['type']; name: string; line: number }

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
  /** <instance of="…" variant="…"> の指す元 */
  component: (of: MarkupAttribute, variant?: MarkupAttribute) => ComponentTarget
  /** 要素に振った id */
  ids: Map<MarkupElement, NodeId>
  /** <component> に振ったコンポーネントの id */
  componentIds: Map<MarkupElement, string>
  pending: PendingInstance[]
  bindings: PendingBinding[]
  /** バリアントのまとまり（<component-set>、place の入れる先のまとまり）と、その中のバリアントの名前 */
  sets: Map<NodeId, { names: Set<string>; strict: boolean }>
  /** place で、入れる先を含むコンポーネントの元（prop の結び先になる） */
  outerMain: NodeId | null
  /** 変数のコレクション（属性の var(名前) とモードの指定が指す） */
  collections: VariableCollection[]
}

/** kdr として読める値かを、ノード 1 つで確かめる（子とコンポーネントのつながりは、最後の全体の検証が見る） */
function validateNode(node: SceneNode, assets: Record<AssetId, Asset>): void {
  const lone = node.type === 'frame' ? { ...node, parentId: null, children: [], component: null } : { ...node, parentId: null }
  const page = { id: 'p', name: 'p', nodes: { [node.id]: lone }, rootIds: [node.id], guides: [] }
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
    const next = { ...node, ...buildPatch(node, pairs, scope.collections) } as N
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

/** 実装側の部品の属性（<component> と <component-set> に書く） */
const CODE_ATTRIBUTES = ['code', 'code-from', 'code-default']

/**
 * <component> / <component-set> の実装側の部品。code（部品名）・code-from（import の場所）・code-default（既定の export）と、
 * 中に書いた <code-prop property="…" prop="…"><code-value of="kdr の値" to="props の値"/></code-prop>。code がなければ null
 */
function codeOfElement(fail: Fail, element: MarkupElement): CodeComponent | null {
  const attribute = (name: string) => element.attributes.find((candidate) => candidate.name === name)
  const name = attribute('code')
  if (!name) {
    const stray = attribute('code-from') ?? attribute('code-default') ?? element.codeProps?.[0]
    if (stray) throw fail(stray.line, 'code-from・code-default・<code-prop> を書くときは、code（部品名）も書きます')
    return null
  }
  if (!isCodeName(name.value)) throw fail(name.line, `code="${name.value}": 部品名は英大文字で始まる識別子か、. でつないだもの（200 文字まで）です`)
  const from = attribute('code-from')
  if (from && !isCodeFrom(from.value)) throw fail(from.line, 'code-from: 使えない文字があるか、長すぎます（200 文字まで）')
  const defaultAttribute = attribute('code-default')
  if (defaultAttribute && defaultAttribute.value !== 'true' && defaultAttribute.value !== 'false') {
    throw fail(defaultAttribute.line, `code-default="${defaultAttribute.value}": true か false を指定してください`)
  }
  const props: CodeProp[] = []
  for (const prop of element.codeProps ?? []) {
    checkAttributes(fail, prop, ['property', 'prop'])
    if (prop.textLine !== null) throw fail(prop.textLine, '<code-prop> の中に文字は書けません')
    const property = prop.attributes.find((candidate) => candidate.name === 'property')
    if (!property) throw fail(prop.line, '<code-prop> には property（コンポーネントのプロパティの名前）が要ります')
    if (props.some((other) => other.property === property.value)) throw fail(property.line, `property="${property.value}": 同じプロパティの <code-prop> が 2 つあります`)
    const target = prop.attributes.find((candidate) => candidate.name === 'prop')?.value ?? ''
    if (target !== '' && !isCodePropName(target)) throw fail(prop.line, `prop="${target}": props の名前は英字で始まる識別子です（v- で始まる名前・key・ref・is・slot は使えません）`)
    if (property.value.length > MAX_CODE_LENGTH) throw fail(property.line, 'property: 長すぎます（200 文字まで）')
    const values: [string, string][] = []
    for (const value of prop.children) {
      if (value.name !== 'code-value') throw fail(value.line, `<code-prop> の中に書けるのは <code-value> だけです: <${value.name}>`)
      checkAttributes(fail, value, ['of', 'to'])
      const of = value.attributes.find((candidate) => candidate.name === 'of')
      const to = value.attributes.find((candidate) => candidate.name === 'to')
      if (!of || !to) throw fail(value.line, '<code-value> には of（kdr の値）と to（props の値）が要ります')
      if (of.value.length > MAX_CODE_LENGTH || to.value.length > MAX_CODE_LENGTH) throw fail(value.line, '<code-value>: 値が長すぎます（200 文字まで）')
      values.push([of.value, to.value])
    }
    props.push({ property: property.value, prop: target, values: Object.fromEntries(values) })
  }
  return { name: name.value, from: from?.value ?? '', defaultExport: defaultAttribute?.value === 'true', props }
}

/** ノードの属性のうち、種類ごとに自分で読むもの（残りは buildPatch に渡す） */
const STRUCTURAL: Record<(typeof NODE_ELEMENTS)[number], readonly string[]> = {
  frame: ['id', 'modes'],
  component: ['id', 'description', 'variant', 'modes', ...CODE_ATTRIBUTES],
  'component-set': ['id', 'description', 'modes', ...CODE_ATTRIBUTES],
  instance: ['id', 'of', 'variant', 'modes'],
  rect: ['id'],
  ellipse: ['id'],
  polygon: ['id', 'count', 'ratio'],
  star: ['id', 'count', 'ratio'],
  line: ['id', 'from', 'to'],
  path: ['id', 'd', 'points', 'closed'],
  text: ['id'],
  image: ['id', 'src'],
}

/** コンポーネントのプロパティに結ぶ属性（どのノードにも書ける。元の中のノードでだけ意味がある） */
const BINDING_ATTRIBUTES = ['prop', 'prop.visible']

/** 子を持てる要素 */
const CONTAINERS = new Set(['frame', 'component', 'component-set'])

/** parent（と祖先）を含む、いちばん近いコンポーネントの元。scene の外（place の入れる先）まで来たら scope.outerMain */
function enclosingComponent(scope: Scope, scene: { nodes: Record<NodeId, SceneNode> }, parent: FrameNode | null): NodeId | null {
  for (let id = parent?.id ?? null; id !== null; ) {
    const node = scene.nodes[id]
    if (!node) return scope.outerMain
    if (isMain(node)) return id
    id = node.parentId
  }
  return null
}

/**
 * <component variant="種類=大, 状態=標準"> の名前（「プロパティ=値」をカンマでつないだもの）。variant がなければ null。
 * variant を書けるのは <component-set> の直下の <component> だけで、そこでは省けない。同じまとまりに同じ組み合わせは 2 つ書けない
 */
function variantName(scope: Scope, element: MarkupElement, parent: FrameNode | null): string | null {
  const { fail } = scope
  const variant = element.attributes.find((attribute) => attribute.name === 'variant')
  const set = parent ? scope.sets.get(parent.id) : undefined
  if (!set) {
    if (variant) throw fail(variant.line, 'variant は <component-set> の直下の <component> にだけ書けます')
    return null
  }
  const names = set.names
  if (!variant && !set.strict) return null
  if (!variant) throw fail(element.line, '<component-set> の直下の <component> には variant が要ります（variant="種類=大, 状態=標準" のように）')
  const name = element.attributes.find((attribute) => attribute.name === 'name')
  if (name) throw fail(name.line, 'バリアントの名前は variant から決まるので、name は書けません')
  const props = parseVariantName(variant.value)
  if (props === null) {
    throw fail(variant.line, `variant="${variant.value}": 「プロパティ=値」をカンマでつないで書きます（名前も値も空にできず、同じプロパティは 1 回だけ）`)
  }
  const written = formatVariantName(props)
  const key = canonicalVariant(props)
  if (names.has(key)) throw fail(variant.line, `variant="${variant.value}": 同じ組み合わせのバリアントが、このまとまりにもうあります`)
  names.add(key)
  return written
}

/** バリアントの組み合わせを、プロパティの並びによらない形にする（同じ組み合わせを見分けるため） */
function canonicalVariant(props: VariantProps): string {
  return JSON.stringify([...props].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** prop="名前"（文言・差し替え）と prop.visible="名前"（表示）を、あとで結ぶものとして覚える */
function bindingsOf(scope: Scope, scene: { id: string; nodes: Record<NodeId, SceneNode> }, element: MarkupElement, node: SceneNode, parent: FrameNode | null): void {
  const { fail } = scope
  for (const attribute of element.attributes) {
    if (!BINDING_ATTRIBUTES.includes(attribute.name)) continue
    const name = attribute.value.trim()
    if (name === '') throw fail(attribute.line, `${attribute.name}: プロパティの名前が空です`)
    const mainId = enclosingComponent(scope, scene, parent)
    if (mainId === null) {
      throw fail(attribute.line, `${attribute.name}: コンポーネントのプロパティに結べるのは、<component> の中のノードだけです`)
    }
    let type: ComponentProperty['type'] = 'boolean'
    if (attribute.name === 'prop') {
      if (node.type === 'text') type = 'text'
      else if (isInstance(node)) type = 'instance'
      else throw fail(attribute.line, `prop: 文言のプロパティは <text>、差し替えのプロパティは <instance> に書きます（表示を切り替えるなら prop.visible）`)
    }
    scope.bindings.push({ pageId: scene.id, mainId, targetId: node.id, type, name, line: attribute.line })
  }
}

/**
 * 覚えておいたプロパティを、書いた順に元へ結ぶ。同じ名前なら結び足し、元がバリアントなら、まとまりのほかのバリアントにも
 * 同じ名前で足して、レイヤー名のたどり方が同じノードを結ぶ（editor の addComponentProperty / bindComponentProperty と同じ結果）。
 * 1 つずつ editor の処理に通すと、ノードの表とプロパティの並びを毎回写すので、数が多いと時間が 2 乗で伸びる。まとめて作って 1 回で書き戻す
 */
function applyBindings(scope: Scope, doc: DesignDocument): DesignDocument {
  if (scope.bindings.length === 0) return doc
  const byPage = new Map<string, PendingBinding[]>()
  for (const binding of scope.bindings) {
    const list = byPage.get(binding.pageId)
    if (list) list.push(binding)
    else byPage.set(binding.pageId, [binding])
  }
  return [...byPage].reduce((current, [pageId, bindings]) => updatePage(current, pageId, (page) => bindAll(scope, page, bindings)), doc)
}

type Working = { properties: ComponentProperty[]; byName: Map<string, { property: ComponentProperty; targets: Set<NodeId> }> }

function bindAll(scope: Scope, page: Page, bindings: readonly PendingBinding[]): Page {
  const working = new Map<NodeId, Working>()
  const workingOf = (main: MainNode): Working => {
    let entry = working.get(main.id)
    if (!entry) {
      const properties = main.component.properties.map((property) => ({ ...property, targets: [...property.targets] }))
      entry = { properties, byName: new Map(properties.map((property) => [property.name, { property, targets: new Set(property.targets) }])) }
      working.set(main.id, entry)
    }
    return entry
  }
  const indexes = new Map<NodeId, Map<string, NodeId>>()
  const indexOf = (id: NodeId) => indexes.get(id) ?? indexes.set(id, pathIndex(page, id)).get(id)!
  // まとまりとその中のバリアントは、元ごと・まとまりごとに 1 回だけ求める（バリアントが多いと、名前を読み直すだけで重い）
  const sets = new Map<NodeId, FrameNode | null>()
  const setOf = (id: NodeId) => (sets.has(id) ? sets.get(id)! : sets.set(id, variantSetOf(page, id)).get(id)!)
  const members = new Map<NodeId, MainNode[]>()
  const membersOf = (setId: NodeId) => members.get(setId) ?? members.set(setId, variantsIn(page, setId)).get(setId)!
  for (const { mainId, targetId, type, name, line } of bindings) {
    const main = page.nodes[mainId]
    if (!isMain(main)) continue
    const existing = workingOf(main).byName.get(name)?.property
    if (existing && existing.type !== type) {
      throw scope.fail(line, `プロパティ ${name} は ${TYPE_NAMES[existing.type]}のプロパティです（ここでは${TYPE_NAMES[type]}として結ぼうとしています）`)
    }
    if (!canBindProperty(page, mainId, type, targetId)) throw scope.fail(line, `プロパティ ${name} に結べません`)
    const set = setOf(mainId)
    const variants = set ? membersOf(set.id) : [main]
    const path = set ? namePath(page, mainId, targetId) : null
    for (const variant of variants) {
      const mapped = variant.id === mainId ? targetId : path ? (indexOf(variant.id).get(path) ?? null) : null
      const bindable = mapped !== null && canBindProperty(page, variant.id, type, mapped)
      const own = workingOf(variant)
      const found = own.byName.get(name)
      if (!found) {
        const property: ComponentProperty = { name, type, targets: bindable ? [mapped] : [], preferred: [] }
        own.properties.push(property)
        own.byName.set(name, { property, targets: new Set(property.targets) })
      } else if (found.property.type === type && bindable && !found.targets.has(mapped)) {
        found.property.targets.push(mapped)
        found.targets.add(mapped)
      }
    }
  }
  return patchNodes(page, working.keys(), (node) =>
    isMain(node) ? { component: { ...node.component, properties: working.get(node.id)!.properties } } : null,
  )
}

const TYPE_NAMES: Record<ComponentProperty['type'], string> = { text: '文言', boolean: '表示', instance: '差し替え' }

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
  if (!CONTAINERS.has(kind) && kind !== 'instance' && element.children.length > 0) {
    throw fail(element.children[0].line, `<${kind}> の中に要素は書けません（子を持てるのは <frame> <component> <component-set>）`)
  }

  const id = scope.ids.get(element)!
  const rest = element.attributes.filter(({ name }) => !STRUCTURAL[kind].includes(name) && !BINDING_ATTRIBUTES.includes(name))
  const at = { x: 0, y: 0, width: 100, height: 100 }
  let node: SceneNode

  if (kind === 'instance') {
    const target = scope.component(required('of', '元の <component> の id か名前'), attribute('variant'))
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
      case 'polygon':
      case 'star': {
        // 頂点の数（星は内側の比も）で形を決めたふつうのパス。大きさは片方だけ書けば、正しい形になる縦横比から決める
        const number = (name: string) => {
          const found = attribute(name)
          if (!found) return undefined
          const value = Number(found.value)
          if (found.value.trim() === '' || !Number.isFinite(value)) throw fail(found.line, `${name}="${found.value}": 数値を指定してください`)
          return value
        }
        const count = number('count')
        const ratio = number('ratio')
        let shape
        try {
          shape = polygonShape(kind, count, ratio, `<${kind}>`, '')
        } catch (error) {
          // 誤りのある属性の行を指す
          const line = (error instanceof Error && error.message.includes('ratio') ? attribute('ratio') : attribute('count'))?.line ?? element.line
          if (error instanceof UsageError) throw fail(line, error.message)
          throw error
        }
        // 数値で書いた大きさだけを縦横比の計算に使う（fill などは、もう片方を書かなければ幅 100 の形の大きさになる）
        const size = (name: 'width' | 'height') => {
          const value = Number(attribute(name)?.value ?? '')
          return attribute(name) && attribute(name)!.value.trim() !== '' && Number.isFinite(value) && value >= 0 ? value : undefined
        }
        created = { ...createPath({ x: 0, y: 0, ...polygonSize(shape.aspect, size('width'), size('height')), points: shape.points }, true), fills: [], strokes: [] }
        break
      }
      case 'frame':
        created = { ...createFrame(at), fills: [] }
        break
      case 'component': {
        const description = attribute('description')?.value ?? ''
        created = { ...createFrame(at), fills: [], component: { id: scope.componentIds.get(element)!, role: 'main', description, properties: [], code: codeOfElement(fail, element) } }
        const variant = variantName(scope, element, parent)
        if (variant !== null) created = { ...created, name: variant }
        break
      }
      case 'component-set': {
        if (enclosingComponent(scope, scene, parent) !== null) {
          throw fail(element.line, '<component-set> は <component> の中には書けません（バリアントのまとまりは、元の外のフレーム）')
        }
        if (!element.children.some((child) => child.name === 'component')) {
          throw fail(element.line, '<component-set> には、バリアントの <component variant="…"> が 1 つ以上要ります')
        }
        created = { ...createFrame(at), fills: [], setDescription: attribute('description')?.value ?? '', setCode: codeOfElement(fail, element) }
        break
      }
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
        else if (points?.value.trim().startsWith('[')) {
          // kdr の頂点そのもの（枠に対する割合。kdr markup が、d では元と同じ形に戻らないときに書く）。大きさは width / height で決める
          let parsed: unknown
          try {
            parsed = JSON.parse(points.value)
          } catch {
            throw fail(points.line, 'points: JSON として読めません')
          }
          if (!Array.isArray(parsed) || parsed.length < 2) throw fail(points.line, 'points: 頂点は 2 つ以上です')
          for (const axis of ['width', 'height']) if (!attribute(axis)) throw fail(element.line, `points を JSON で書くときは ${axis} が要ります`)
          created = { ...createPath({ x: 0, y: 0, width: 1, height: 1, points: parsed as PathNode['points'] }, closed), fills: [], strokes: [] }
        } else if (points) {
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
        throw fail(attribute(axis)?.line ?? element.line, `${axis}="hug" は、自動で並べるフレーム（layout="row|column|grid"）とテキストの幅にだけ使えます`)
      }
    }
    if (node.type === 'text') node = { ...node, ...estimateTextSize(node) }
  }

  // 親いっぱいに伸ばす（fill）のは、伸ばす先が決まるときだけ
  for (const axis of ['width', 'height'] as const) {
    if (node.sizing[axis] !== 'fill') continue
    const line = attribute(axis)?.line ?? element.line
    if (!parent?.layout) throw fail(line, `${axis}="fill" は、自動で並べるフレーム（layout="row|column|grid"）の子でだけ使えます`)
    if (fillBlocked(parent, axis)) {
      throw fail(line, `${axis}="fill": 親の ${axis} が中身に合わせる（hug）なので伸ばせません。親の ${axis} を数値か fill にしてください`)
    }
  }

  // 変数のモードの指定（フレームの種類だけ）
  const modes = attribute('modes')
  if (modes && node.type === 'frame') {
    const selection = parseModes(scope, modes)
    if (selection) node = { ...node, modes: selection }
  }
  const placed = { ...node, parentId: parent?.id ?? null } as SceneNode
  scene.nodes[id] = placed
  if (parent) parent.children.push(id)
  else scene.rootIds.push(id)
  if (kind === 'component-set') scope.sets.set(id, { names: new Set(), strict: true })
  bindingsOf(scope, scene, element, placed, parent)
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
      const attributeValue = (name: string) => element.attributes.find((attribute) => attribute.name === name)?.value
      // バリアントは名前を書かないので、variant を名前の代わりに使う（属性を書いた順にはよらない）
      const named = attributeValue('name') ?? (element.name === 'component' ? attributeValue('variant') : undefined)
      const label = written !== undefined ? `#${written}` : (named ?? `<${element.name}>`)
      const nth = seen.get(label) ?? 0
      seen.set(label, nth + 1)
      const here = `${path}/${label}${nth === 0 ? '' : `~${nth}`}`
      scope.ids.set(element, written ?? uniqueId(here, taken))
      derive(element.children, here)
    }
  }
  derive(elements, seed)
}

/**
 * of="…" で指せる元。keys は指すのに使える id（書いた id・元のノードの id・コンポーネントの id・まとまりの id）、
 * name は名前（バリアントならまとまりの名前）。set はバリアントのまとまり（同じ値なら同じまとまり。並びはまとまりの中の順）
 */
type Candidate = ComponentTarget & { keys: string[]; names: string[]; set: string | null; props: VariantProps | null; order: number }

/** マークアップの中の <component> を集め、コンポーネントの id を決める */
function collectComponents(
  scope: Scope,
  elements: readonly MarkupElement[],
  pageKey: string,
  taken: Set<string>,
  found: Candidate[],
  set: MarkupElement | null = null,
): void {
  const written = (element: MarkupElement, name: string) => element.attributes.find((attribute) => attribute.name === name)?.value
  elements.forEach((element, order) => {
    if (element.name === 'component') {
      const componentId = uniqueId(`component:${pageKey}:${scope.ids.get(element)}`, taken)
      scope.componentIds.set(element, componentId)
      // まとまりの中の <component> は、variant の誤りがあってもまとまりの一員として扱う（誤りは組み立てるときに、その行で知らせる）
      const name = written(set ?? element, 'name') ?? 'Frame'
      found.push({
        componentId,
        name,
        names: [name],
        keys: [written(element, 'id'), set ? written(set, 'id') : undefined].filter((key) => key !== undefined),
        set: set ? `markup:${pageKey}:${scope.ids.get(set)}` : null,
        props: set ? parseVariantName(written(element, 'variant') ?? '') : null,
        order,
      })
    }
    collectComponents(scope, element.children, pageKey, taken, found, element.name === 'component-set' ? element : null)
  })
}

/** 今のドキュメントの元を、of="…" で指せるものにする。名前は、元のノードの名前とまとまりの名前のどちらでも指せる */
function documentCandidates(doc: DesignDocument): Candidate[] {
  const orders = new Map<string, Map<NodeId, number>>()
  return listComponents(doc).map((main) => {
    const set = variantSetOf(main.page, main.node.id)
    const key = set ? `doc:${main.page.id}:${set.id}` : null
    let order = 0
    if (set && key) {
      if (!orders.has(key)) orders.set(key, new Map(variantsIn(main.page, set.id).map((variant, index) => [variant.id, index])))
      order = orders.get(key)!.get(main.node.id) ?? 0
    }
    return {
      componentId: main.node.component.id,
      name: componentName(main),
      names: [...new Set([main.node.name, componentName(main)])],
      keys: [main.node.id, main.node.component.id, ...(set ? [set.id] : [])],
      set: key,
      props: set ? parseVariantName(main.node.name) : null,
      order,
    }
  })
}

/** id・名前・まとまりから元を引く表 */
type CandidateIndex = { byKey: Map<string, Candidate[]>; byName: Map<string, Candidate[]>; bySet: Map<string, Candidate[]> }

function indexCandidates(candidates: readonly Candidate[]): CandidateIndex {
  const index: CandidateIndex = { byKey: new Map(), byName: new Map(), bySet: new Map() }
  const add = (map: Map<string, Candidate[]>, key: string, candidate: Candidate) => {
    const list = map.get(key)
    if (list) list.push(candidate)
    else map.set(key, [candidate])
  }
  for (const candidate of candidates) {
    for (const key of new Set(candidate.keys)) add(index.byKey, key, candidate)
    for (const name of candidate.names) add(index.byName, name, candidate)
    if (candidate.set !== null) add(index.bySet, candidate.set, candidate)
  }
  for (const list of index.bySet.values()) list.sort((a, b) => a.order - b.order)
  return index
}

/**
 * of="…"（と variant="…"）の指す元を探す関数。マークアップの中の <component>（id、名前の順）、なければ今のドキュメントの元。
 * バリアントのまとまりを指したら（まとまりの id・名前、バリアントの id）、variant の組み合わせを持つバリアントを選ぶ。
 * variant に書かなかったプロパティは、指したバリアント（まとまりを指したなら最初のバリアント）の値に近いものを選ぶ
 */
function componentResolver(fail: Fail, locals: readonly Candidate[], doc: DesignDocument | null): Scope['component'] {
  const local = indexCandidates(locals)
  let existing: CandidateIndex | null = null
  return (of, variant) => {
    const choose = (index: CandidateIndex, candidates: readonly Candidate[] | undefined, what: string): ComponentTarget | null => {
      if (!candidates || candidates.length === 0) return null
      const set = candidates[0].set
      const inOneSet = set !== null && candidates.every((candidate) => candidate.set === set)
      if (candidates.length > 1 && !inOneSet) {
        throw fail(of.line, `${of.name}="${of.value}": 同じ${what}の元が ${candidates.length} 個あります。<component> に id を付けて、その id で指してください`)
      }
      // まとまりを指したら、まとまりの最初のバリアントから選ぶ
      const base = candidates.length === 1 ? candidates[0] : index.bySet.get(set!)![0]
      if (!variant) return base
      if (!inOneSet) throw fail(variant.line, `variant="${variant.value}": ${of.name}="${of.value}" の元は、バリアントのまとまり（<component-set>）の中のものではありません`)
      return pickVariantOf(fail, variant, index.bySet.get(set)!, base)
    }
    const search = (index: CandidateIndex) => choose(index, index.byKey.get(of.value), ' id ') ?? choose(index, index.byName.get(of.value), '名前')
    const found = search(local) ?? search((existing ??= indexCandidates(doc ? documentCandidates(doc) : [])))
    if (!found) throw fail(of.line, `${of.name}="${of.value}": コンポーネントの元（<component>）が見つかりません`)
    return found
  }
}

/** まとまりのバリアント（variants）から、variant="…" の組み合わせを持ち、ほかのプロパティが base に近いものを選ぶ */
function pickVariantOf(fail: Fail, variant: MarkupAttribute, variants: readonly Candidate[], base: Candidate): Candidate {
  const wanted = parseVariantName(variant.value)
  if (wanted === null) throw fail(variant.line, `variant="${variant.value}": 「プロパティ=値」をカンマでつないで書きます`)
  let best: Candidate | null = null
  let bestScore = -1
  for (const candidate of variants) {
    const props = candidate.props ?? []
    if (!wanted.every(([key, value]) => propValue(props, key) === value)) continue
    const score = (base.props ?? []).filter(([key, value]) => propValue(wanted, key) === undefined && propValue(props, key) === value).length
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  if (best) return best
  // 見つからなければ、どのプロパティ・値がないのかを知らせる
  for (const [key, value] of wanted) {
    const values = [...new Set(variants.flatMap((candidate) => (candidate.props ?? []).filter(([other]) => other === key).map(([, v]) => v)))]
    if (values.length === 0) {
      const keys = [...new Set(variants.flatMap((candidate) => (candidate.props ?? []).map(([other]) => other)))]
      throw fail(variant.line, `variant="${variant.value}": プロパティ ${key} がありません（あるもの: ${keys.join(', ')}）`)
    }
    if (!values.includes(value)) throw fail(variant.line, `variant="${variant.value}": ${key} に値 ${value} がありません（あるもの: ${values.join(', ')}）`)
  }
  throw fail(variant.line, `variant="${variant.value}": その組み合わせのバリアントがありません`)
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

function newScope(file: string, images: ReadonlyMap<string, MarkupImage>, assets: Record<AssetId, Asset>, collections: VariableCollection[] = []): Scope {
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
    bindings: [],
    sets: new Map(),
    outerMain: null,
    collections,
  }
}

/** modes="コレクション=モード; …" を、コレクションの id → モードの id にする。空なら null */
function parseModes(scope: Scope, attribute: MarkupAttribute): ModeSelection | null {
  const selection: ModeSelection = {}
  for (const part of attribute.value.split(';')) {
    if (part.trim() === '') continue
    const at = part.indexOf('=')
    if (at === -1) throw scope.fail(attribute.line, `modes="${attribute.value}": 「コレクション=モード」を ; で区切って書きます`)
    const name = part.slice(0, at).trim()
    const modeName = part.slice(at + 1).trim()
    const collection = scope.collections.find((item) => item.name === name)
    if (!collection) throw scope.fail(attribute.line, `modes: ${name} というコレクションがありません`)
    const mode = collection.modes.find((item) => item.name === modeName)
    if (!mode) throw scope.fail(attribute.line, `modes: ${name} に ${modeName} というモードがありません（${collection.modes.map((item) => item.name).join(' / ')}）`)
    selection[collection.id] = mode.id
  }
  return Object.keys(selection).length > 0 ? selection : null
}

/**
 * <variables> の中身を、変数のコレクションにする。id を省くと名前から決める（同じマークアップからは同じ id）。
 *   <collection name="Theme"> <mode name="Light"/> <mode name="Dark"/>
 *     <color name="color/primary" value="#5b4cf5"> <mode name="Dark" value="#a99fff"/> </color>
 *     <color name="color/link" alias="color/primary"/>
 *   </collection>
 */
function parseVariables(fail: Fail, element: MarkupElement): VariableCollection[] {
  checkAttributes(fail, element, [])
  // コレクション・モード・変数の id はドキュメント全体で一意
  const taken = new Map<string, number>()
  const idOf = (node: MarkupElement, seed: readonly string[]) => {
    const written = node.attributes.find((attribute) => attribute.name === 'id')
    if (written && !ID_PATTERN.test(written.value)) throw fail(written.line, `id="${written.value}": id には英数字と _ - だけを 64 文字まで使えます`)
    // 名前の組から決める id は、区切りが曖昧にならないよう JSON にしてからハッシュにする
    const id = written?.value ?? hashId(JSON.stringify(seed))
    if (taken.has(id)) throw fail(written?.line ?? node.line, `id="${id}": id が重複しています（${taken.get(id)} 行目と同じ）`)
    taken.set(id, written?.line ?? node.line)
    return id
  }
  const nameOf = (node: MarkupElement) => {
    const name = node.attributes.find((attribute) => attribute.name === 'name')?.value.trim()
    if (!name) throw fail(node.line, `<${node.name}> には name が要ります`)
    return name
  }
  /** value（値）か alias（別名の先の変数の名前）のどちらか 1 つ */
  const valueOf = (node: MarkupElement) => {
    const value = node.attributes.find((attribute) => attribute.name === 'value')
    const alias = node.attributes.find((attribute) => attribute.name === 'alias')
    if (value && alias) throw fail(alias.line, 'value と alias は一緒に書けません（値か、別名の先の変数の名前のどちらか）')
    if (!value && !alias) throw fail(node.line, `<${node.name}> には value（値）か alias（別名の先の変数の名前）が要ります`)
    return value ? { kind: 'value' as const, attribute: value } : { kind: 'alias' as const, attribute: alias! }
  }
  let collections: VariableCollection[] = []
  /** 別名は、全部の変数を読んでから id に直す */
  const pending: { collection: string; variable: string; mode: string; ref: string; line: number }[] = []
  for (const child of element.children) {
    if (child.name !== 'collection') throw fail(child.line, `<variables> の中に書けるのは <collection> だけです: <${child.name}>`)
    checkAttributes(fail, child, ['id', 'name'])
    const name = nameOf(child)
    const collectionId = idOf(child, ['collection', name])
    const modes = child.children.filter((item) => item.name === 'mode').map((mode) => {
      checkAttributes(fail, mode, ['id', 'name'])
      const modeName = nameOf(mode)
      return { id: idOf(mode, ['mode', name, modeName]), name: modeName }
    })
    if (modes.length === 0) modes.push({ id: idOf(child, ['mode', name, 'Mode 1']), name: 'Mode 1' })
    collections = addCollectionWith(fail, collections, child, collectionId, name, modes)
    for (const item of child.children) {
      if (item.name === 'mode') continue
      if (!(VARIABLE_TYPES as readonly string[]).includes(item.name)) {
        throw fail(item.line, `<collection> の中に書けるのは <mode> と ${VARIABLE_TYPES.map((type) => `<${type}>`).join(' ')} です: <${item.name}>`)
      }
      checkAttributes(fail, item, ['id', 'name', 'value', 'alias'])
      const type = item.name as VariableType
      const variableName = nameOf(item)
      const id = idOf(item, ['variable', name, variableName])
      const values: Record<string, VariableValue> = {}
      const base = valueOf(item)
      const baseValue = base.kind === 'value' ? variableLiteral(fail, type, base.attribute.value, base.attribute.line) : DEFAULT_VARIABLE_VALUES[type]
      for (const mode of modes) values[mode.id] = baseValue
      const overridden = new Set<string>()
      for (const override of item.children) {
        if (override.name !== 'mode') throw fail(override.line, `<${type}> の中に書けるのは <mode> だけです: <${override.name}>`)
        checkAttributes(fail, override, ['name', 'value', 'alias'])
        const modeName = nameOf(override)
        const mode = modes.find((candidate) => candidate.name === modeName)
        if (!mode) throw fail(override.line, `${name} に ${modeName} というモードがありません`)
        if (overridden.has(mode.id)) throw fail(override.line, `同じモード ${modeName} を 2 回書いています`)
        overridden.add(mode.id)
        const read = valueOf(override)
        if (read.kind === 'value') values[mode.id] = variableLiteral(fail, type, read.attribute.value, read.attribute.line)
        else pending.push({ collection: name, variable: variableName, mode: mode.id, ref: read.attribute.value.trim(), line: read.attribute.line })
      }
      // value の別名は、<mode> で書かなかったモードに入れる
      if (base.kind === 'alias') {
        for (const mode of modes) {
          if (!overridden.has(mode.id)) pending.push({ collection: name, variable: variableName, mode: mode.id, ref: base.attribute.value.trim(), line: base.attribute.line })
        }
      }
      collections = withVariableAdded(fail, collections, item, name, { id, name: variableName, type, values })
    }
  }
  // 別名を id に直す（同じ種類の変数だけ）
  const aliasLines = new Map<string, number>()
  for (const { collection, variable, mode, ref, line } of pending) {
    const target = findVariableByRefOrFail(fail, collections, ref, line)
    const owner = collections.find((item) => item.name === collection)!
    const index = owner.variables.findIndex((item) => item.name === variable)
    const entry = owner.variables[index]
    if (target.type !== entry.type) throw fail(line, `alias="${ref}" は ${entry.type} の変数ではありません`)
    owner.variables[index] = { ...entry, values: { ...entry.values, [mode]: { alias: target.id } } }
    if (!aliasLines.has(entry.id)) aliasLines.set(entry.id, line)
  }
  // 別名の循環は、ここで行の付いたエラーにする
  const byId = new Map(collections.flatMap((collection) => collection.variables.map((variable) => [variable.id, variable] as const)))
  for (const [start, line] of aliasLines) {
    const seen = new Set<string>()
    const stack = [start]
    while (stack.length > 0) {
      const current = stack.pop()!
      for (const value of Object.values(byId.get(current)?.values ?? {})) {
        if (typeof value !== 'object') continue
        if (value.alias === start) throw fail(line, `${byId.get(start)!.name}: 別名が循環しています`)
        if (!seen.has(value.alias)) {
          seen.add(value.alias)
          stack.push(value.alias)
        }
      }
    }
  }
  return collections
}

function addCollectionWith(fail: Fail, collections: VariableCollection[], element: MarkupElement, id: string, name: string, modes: VariableCollection['modes']): VariableCollection[] {
  if (collections.some((item) => item.name === name)) throw fail(element.line, `同じ名前のコレクションがあります: ${name}`)
  if (new Set(modes.map((mode) => mode.name)).size !== modes.length) throw fail(element.line, `${name}: 同じ名前のモードがあります`)
  return [...collections, { id, name, modes, variables: [] }]
}

function withVariableAdded(fail: Fail, collections: VariableCollection[], element: MarkupElement, collection: string, variable: Variable): VariableCollection[] {
  return collections.map((item) => {
    if (item.name !== collection) return item
    if (item.variables.some((other) => other.name === variable.name)) throw fail(element.line, `同じ名前の変数があります: ${variable.name}`)
    return { ...item, variables: [...item.variables, variable] }
  })
}

function variableLiteral(fail: Fail, type: VariableType, raw: string, line: number): VariableValue {
  switch (type) {
    case 'color':
      if (!/^#[0-9a-fA-F]{6}$/.test(raw.trim())) throw fail(line, `value="${raw}": 色は #rrggbb で書きます`)
      return raw.trim().toLowerCase()
    case 'number': {
      const value = Number(raw)
      if (raw.trim() === '' || !Number.isFinite(value)) throw fail(line, `value="${raw}": 数値ではありません`)
      return value
    }
    case 'boolean':
      if (raw !== 'true' && raw !== 'false') throw fail(line, `value="${raw}": true か false を書きます`)
      return raw === 'true'
    case 'string':
      return raw
  }
}

function findVariableByRefOrFail(fail: Fail, collections: readonly VariableCollection[], ref: string, line: number) {
  try {
    return findVariableByRef(collections, ref)
  } catch (error) {
    if (error instanceof UsageError) throw fail(line, error.message)
    throw error
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
  // 変数の表（<variables>）は、ページより前に 1 つだけ
  const variablesElements = root.children.filter((element) => element.name === 'variables')
  if (variablesElements.length > 1) throw fail(variablesElements[1].line, '<variables> は 1 つだけ書けます')
  if (variablesElements.length === 1 && root.children[0] !== variablesElements[0]) throw fail(variablesElements[0].line, '<variables> は <page> より前に書きます')
  scope.collections = variablesElements.length === 1 ? parseVariables(fail, variablesElements[0]) : []
  const pageElements = root.children.filter((element) => element.name !== 'variables')
  if (pageElements.length === 0) throw fail(root.line, '<kdr> には <page> が 1 つ以上要ります')
  const pageIds = new Set<string>()
  for (const element of pageElements) {
    if (element.name !== 'page') throw fail(element.line, `<kdr> の直下に書けるのは <variables> と <page> だけです: <${element.name}>`)
    checkAttributes(fail, element, ['name', 'id', 'guides', 'modes'])
    const id = element.attributes.find((attribute) => attribute.name === 'id')
    if (id) {
      if (!ID_PATTERN.test(id.value)) throw fail(id.line, `id="${id.value}": id には英数字と _ - だけを 64 文字まで使えます`)
      if (pageIds.has(id.value)) throw fail(id.line, `id="${id.value}": ページの id が重複しています`)
      pageIds.add(id.value)
    }
  }
  const names = new Map<string, number>()
  const pages = pageElements.map((element, index) => {
    const name = element.attributes.find((attribute) => attribute.name === 'name')?.value ?? `Page ${index + 1}`
    const nth = names.get(name) ?? 0
    names.set(name, nth + 1)
    const id = element.attributes.find((attribute) => attribute.name === 'id')?.value ?? uniqueId(`page:${name}${nth === 0 ? '' : `~${nth}`}`, pageIds)
    const guides = element.attributes.find((attribute) => attribute.name === 'guides')
    const modesAttribute = element.attributes.find((attribute) => attribute.name === 'modes')
    const modes = modesAttribute ? parseModes(scope, modesAttribute) : null
    return {
      element,
      scene: { id, name, nodes: {} as Record<NodeId, SceneNode>, rootIds: [] as NodeId[], guides: guides ? parseGuidesAttribute(fail, guides) : [], ...(modes ? { modes } : {}) },
    }
  })
  // ノードの id はページの中でだけ一意
  for (const { element } of pages) assignIds(scope, element.children, '', new Set())
  const locals: Candidate[] = []
  const componentIds = new Set<string>()
  for (const { element, scene } of pages) collectComponents(scope, element.children, scene.id, componentIds, locals)
  scope.component = componentResolver(fail, locals, null)
  for (const { element, scene } of pages) {
    for (const child of element.children) buildElement(scope, scene, child, null, 0)
  }
  const document = applyBindings(scope, {
    name: root.attributes.find((attribute) => attribute.name === 'name')?.value ?? 'Untitled',
    pages: pages.map(({ scene }) => scene),
    assets,
    fonts: [],
    collections: scope.collections,
  })
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
  const scope = newScope(file, images, doc.assets, doc.collections)
  const { fail } = scope
  if (!isNodeElement(root.name)) {
    throw fail(root.line, root.name === 'kdr' ? '<kdr> から始まるマークアップは、kdr build でドキュメントにします（place に渡すのはノードの要素 1 つ）' : `知らない要素です: <${root.name}>（${NODE_ELEMENTS.join(' ')}）`)
  }
  const page = doc.pages.find((candidate) => candidate.id === pageId)!
  const parent = parentId === null ? null : (page.nodes[parentId] as FrameNode)
  if (parentId !== null) {
    scope.outerMain = enclosingMainNode(page, parentId)?.id ?? null
    // 今の kdr のまとまり（名前で作ったものもある）には、variant を省いた <component> も今までどおり足せる
    if (isVariantSet(page, parentId)) {
      scope.sets.set(parentId, { names: new Set(variantsIn(page, parentId).map((variant) => canonicalVariant(parseVariantName(variant.name)!))), strict: false })
    }
  }
  assignIds(scope, [root], `place:${parentId ?? ''}`, new Set(Object.keys(page.nodes)))
  const locals: Candidate[] = []
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
  let document = applyBindings(scope, updatePage(doc, pageId, () => next))
  // まとまりにバリアントを足したら、まとまりのほかのバリアントのプロパティを揃える（editor でバリアントを増やしたときと同じ）
  if (parentId !== null && isMain(built) && variantSetOf(document.pages.find((candidate) => candidate.id === pageId)!, id)) {
    document = updatePage(document, pageId, (scene) => alignVariantProperties(scene, parentId, document))
  }
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
  // 変数は、置いた場所のモードで解決し直す（属性の var(名前) は最初のモードの値で入れている）。文字の項目が変わったテキストは測り直す
  let current = resolveMarkupVariables(doc)
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

  const attributeOf = (element: MarkupElement, name: string) => element.attributes.find((attribute) => attribute.name === name)
  const byProperty = (override: MarkupElement) => attributeOf(override, 'prop') !== undefined
  for (const item of pending) {
    for (const override of item.element.children) {
      const variant = attributeOf(override, 'variant')
      if (variant && !attributeOf(override, 'of') && !byProperty(override)) {
        throw fail(variant.line, 'variant は of="…"（差し替える元）か prop="…"（差し替えのプロパティ）と一緒に書きます')
      }
    }
  }

  // 入れ子のインスタンスの差し替え（中身の形が変わるので、ほかの上書きより先に、1 つずつ同期する）
  for (const item of pending) {
    for (const override of item.element.children) {
      const of = attributeOf(override, 'of')
      if (!of || byProperty(override)) continue
      const copyId = target(item, override)
      const { componentId } = scope.component(of, attributeOf(override, 'variant'))
      const nested = nestedInstanceOf(session.document, pageOf(item.pageId), copyId)
      if (!nested) throw fail(of.line, `of="${of.value}": 差し替えられるのは、元の中に置いたインスタンスだけです`)
      if (nested.componentId === componentId) continue
      const before = session.document
      session.applyDocument((doc) => swapNestedInstance(doc, item.pageId, copyId, componentId))
      if (session.document === before) throw fail(of.line, `of="${of.value}": 差し替えられません（元が自分自身を含むことになります）`)
    }
  }

  // コンポーネントのプロパティの値（<override prop="名前" value="値"/>）。結んだノードすべてへの上書きになる
  // 差し替えは中身の形が変わるので 1 つずつ、文言と表示はまとめて 1 回で当てる（数が多くても同期を何度もかけない）
  const values: { item: PendingInstance; name: string; value: string | boolean }[] = []
  for (const item of pending) {
    const seen = new Set<string>()
    for (const override of item.element.children) {
      if (!byProperty(override)) continue
      const resolved = propertyValue(session, scope, item, override)
      if (resolved && seen.has(resolved.name)) throw fail(override.line, `同じプロパティ ${resolved.name} への <override> が 2 つあります。1 つにまとめてください`)
      if (resolved) seen.add(resolved.name)
      if (resolved?.type === 'instance') applySwapProperty(session, scope, item, resolved)
      else if (resolved) values.push({ item, name: resolved.name, value: resolved.value })
    }
  }
  if (values.length > 0) {
    session.applyDocument((doc) => values.reduce((next, { item, name, value }) => setInstanceProperty(next, item.pageId, item.instanceId, name, value), doc))
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
        keys = Object.keys(buildPatch(node, [[attribute.name, attribute.value]], session.document.collections))
      } catch (error) {
        if (error instanceof UsageError) throw fail(attribute.line, `${attribute.name}="${attribute.value}": ${error.message}`)
        throw error
      }
      // var(名前) は値と一緒に変数へのつながり（bindings）も書く。つながりは、値の項目が上書きできれば上書きにできる
      const refused = keys.find((key) => key !== 'bindings' && !allowed.has(key))
      if (refused !== undefined) {
        throw fail(attribute.line, `${attribute.name}: インスタンスごとには変えられない項目です（変えられるのは ${[...allowed].join(' ')}。ほかは元の <component> で決める）`)
      }
    }
    const patched = patchNode(scope, element, node, attributes)
    const patch: Record<string, unknown> = { ...buildPatch(node, pairs, session.document.collections), ...extra }
    const keys = Object.keys(patch)
    if (keys.length === 0) return
    const before = Object.fromEntries(keys.map((key) => [key, (node as unknown as Record<string, unknown>)[key]]))
    if (patched.type === 'text' && keys.some((key) => TEXT_KEYS.includes(key))) Object.assign(patch, estimateTextSize({ ...patched, ...extra } as typeof patched))
    let page = patches.get(item.pageId)
    if (!page) patches.set(item.pageId, (page = new Map()))
    if (page.has(nodeId)) throw fail(element.line, '同じレイヤーへの <override> が 2 つあります。1 つにまとめてください')
    page.set(nodeId, { patch, before, line: element.line })
  }
  const overridable = new Set<string>(OVERRIDE_KEYS.filter((key) => key !== 'componentId' && key !== 'assetId' && key !== 'bindings'))
  for (const item of pending) {
    if (item.root.length > 0) add(item, item.instanceId, item.element, item.root, INSTANCE_ROOT_OVERRIDES, {})
    for (const override of item.element.children) {
      if (byProperty(override)) continue
      const copyId = target(item, override)
      const src = override.attributes.find((attribute) => attribute.name === 'src')
      const extra: NodePatch = {}
      if (src) {
        if (pageOf(item.pageId).nodes[copyId].type !== 'image') throw fail(src.line, 'src: 画像のレイヤーにだけ指定できます')
        Object.assign(extra, { assetId: scope.images.get(src.value)!.assetId })
      }
      const attributes = override.attributes.filter(({ name }) => name !== 'node' && name !== 'of' && name !== 'src' && name !== 'variant')
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

/** <override prop="名前" value="値" [variant="…"]/> を、インスタンスのプロパティの値として当てる（kdr prop と同じ） */
type ResolvedValue = { name: string; type: ComponentProperty['type']; value: string | boolean; line: number; written: string }

/** <override prop="名前" value="値" [variant="…"]/> を確かめ、プロパティの値にする（kdr prop と同じ値） */
function propertyValue(session: Session, scope: Scope, item: PendingInstance, override: MarkupElement): ResolvedValue | null {
  const { fail } = scope
  checkAttributes(fail, override, ['prop', 'value', 'variant'])
  if (override.children.length > 0) throw fail(override.children[0].line, '<override> の中に要素は書けません')
  const prop = override.attributes.find((attribute) => attribute.name === 'prop')!
  const value = override.attributes.find((attribute) => attribute.name === 'value')
  if (!value) throw fail(override.line, `<override prop="${prop.value}"> には value が要ります（文言なら文字、表示なら true か false、差し替えなら元の id か名前）`)
  const instance = session.document.pages.find((page) => page.id === item.pageId)!.nodes[item.instanceId]
  if (!isInstance(instance)) return null
  const properties = findMain(session.document, instance.component.id)?.node.component.properties ?? []
  const key = prop.value.trim()
  const property = properties.find((candidate) => candidate.name === key)
  if (!property) {
    const names = properties.map((candidate) => candidate.name)
    throw fail(prop.line, `prop="${prop.value}": 元にそのプロパティがありません（${names.length > 0 ? `あるもの: ${names.join(', ')}` : '元にプロパティがありません'}）`)
  }
  const variant = override.attributes.find((attribute) => attribute.name === 'variant')
  if (variant && property.type !== 'instance') throw fail(variant.line, `variant は差し替えのプロパティにだけ書けます（${prop.value} は ${TYPE_NAMES[property.type]}のプロパティ）`)
  let resolved: string | boolean = value.value
  if (property.type === 'boolean') {
    if (value.value !== 'true' && value.value !== 'false') throw fail(value.line, `value="${value.value}": ${prop.value} は表示のプロパティなので true か false です`)
    resolved = value.value === 'true'
  } else if (property.type === 'instance') {
    resolved = scope.component(value, variant).componentId
  }
  // 結んだノードがこのバリアントにないプロパティは、値を入れても何も変わらない。黙って捨てずに知らせる
  const page = session.document.pages.find((candidate) => candidate.id === item.pageId)!
  if (!instanceProperties(session.document, page, instance).some((state) => state.property.name === property.name)) {
    throw fail(prop.line, `prop="${prop.value}": この元では、プロパティ ${property.name} に結んだノードがありません`)
  }
  return { name: property.name, type: property.type, value: resolved, line: value.line, written: value.value }
}

/** 差し替えのプロパティの値を当てる。当たらなければ（元が自分自身を含むことになる）エラー */
function applySwapProperty(session: Session, scope: Scope, item: PendingInstance, { name, value, line, written }: ResolvedValue): void {
  const pageOf = () => session.document.pages.find((page) => page.id === item.pageId)!
  const before = session.document
  session.applyDocument((doc) => setInstanceProperty(doc, item.pageId, item.instanceId, name, value))
  if (session.document !== before) return
  const instance = pageOf().nodes[item.instanceId]
  const current = isInstance(instance) ? instanceProperties(session.document, pageOf(), instance) : []
  if (current.find((state) => state.property.name === name)?.value !== value) {
    throw scope.fail(line, `value="${written}": 差し替えられません（元が自分自身を含むことになります）`)
  }
}

/** インスタンスかその中身か（place で、入れる先に選べないもの） */
export function insideInstance(page: Page, id: NodeId): boolean {
  return isInstance(page.nodes[id]) || owningInstance(page, id) !== null
}

/**
 * <page> の guides 属性（ページのガイド線）。「x:120 y:-40.5」のように、x:（縦の線）か y:（横の線）と位置を空白で区切って並べる
 */
function parseGuidesAttribute(fail: Fail, attribute: MarkupAttribute): PageGuide[] {
  const tokens = attribute.value.trim() === '' ? [] : attribute.value.trim().split(/\s+/)
  if (tokens.length > KDR_MAX_GUIDES) throw fail(attribute.line, `guides: ガイド線が多すぎます（${KDR_MAX_GUIDES} 本まで）`)
  return tokens.map((token) => {
    const match = /^(x|y):(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.exec(token)
    if (!match || !Number.isFinite(Number(match[2]))) throw fail(attribute.line, `guides="${attribute.value}": 「x:120 y:40」のように、x: か y: と位置を空白で区切って書きます（${token}）`)
    return { axis: match[1].toLowerCase() as 'x' | 'y', position: Number(match[2]) }
  })
}

/** 変数を置いた場所のモードで解決し直し、値の変わったテキストを測り直す */
function resolveMarkupVariables(doc: DesignDocument): DesignDocument {
  const resolved = applyVariables(doc)
  if (resolved === doc) return doc
  return {
    ...resolved,
    pages: resolved.pages.map((page, index) => {
      const prior = doc.pages[index]
      if (prior === page) return page
      const texts = Object.keys(page.nodes).filter((id) => page.nodes[id] !== prior.nodes[id] && page.nodes[id].type === 'text')
      return texts.length > 0 ? fitTextEstimated(page, texts) : page
    }),
  }
}
