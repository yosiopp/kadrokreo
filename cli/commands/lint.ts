import { findMain, isInstance, isMain, owningInstance } from '../../src/document/component.ts'
import { usedFontFaces } from '../../src/document/fontFace.ts'
import { getAbsoluteBounds, intersects } from '../../src/document/geometry.ts'
import { isMaskNode } from '../../src/document/mask.ts'
import { hasStroke } from '../../src/document/paint.ts'
import { nodeKind } from '../../src/document/path.ts'
import type { DesignDocument, NodeId, Page, Paint, SceneNode } from '../../src/document/types.ts'
import { variantSetOf, variantsIn } from '../../src/document/variants.ts'
import { CONTRAST_AA, CONTRAST_AA_LARGE, formatRatio, textContrast } from '../../src/viewer/contrast.ts'
import { visiblePaints } from '../../src/viewer/summary.ts'
import { type Step, UsageError } from '../args.ts'
import { type Command, checkStep, flag, numberOption, option } from './common.ts'

// kdr の中の直したほうがよい所の検査（kdr lint）。見つけたら終了コード 1（reports）。

export type Finding = {
  check: string
  /** ページとノード。書体のようにドキュメント全体のものは null */
  page: string | null
  id: NodeId | null
  name: string | null
  message: string
}

type Options = { grid?: number; palette?: ReadonlySet<string>; targetSize: number; targetName: RegExp; contrast?: boolean }
type Report = (check: string, message: string, page?: Page, node?: SceneNode) => void

/** 検査の名前と意味（kdr docs・ユーザーズガイドにもこのまま載せる）。needs があれば、そのオプションを指定したときだけ動く */
export const CHECKS: readonly { name: string; description: string; needs?: string }[] = [
  { name: 'default-name', description: '作ったときの名前のままのレイヤー（`Rectangle 1`・`Frame`・`Text 3`・`Star 2` など。マスクの `Mask group`、SVG の `Group`、ブーリアン演算の `合体` なども）' },
  { name: 'empty-text', description: '中身が空（空白だけ）のテキスト' },
  { name: 'hidden', description: '非表示のまま残っているノード（中身は 1 つずつ出さない。コンポーネントの表示のプロパティに結んだものは除く）' },
  { name: 'zero-size', description: '幅か高さが 0 の図形・フレーム・画像（直線・パス・テキストは、幅も高さも 0 のときだけ）' },
  { name: 'out-of-frame', description: '中身を切り抜くフレーム（入れ子ならどれか）の外に出て、見えないノード' },
  {
    name: 'low-contrast',
    description:
      'テキストと背景のコントラスト比が WCAG の AA の基準（4.5:1、大きな文字は 3:1）に届かないもの。求め方は viewer のインスペクトのコントラスト比と同じで、背景が 1 色に決まらない（画像の上など）ものは出さない。背景は置いた場所で変わるので、インスタンスの中のテキストも見る',
  },
  { name: 'missing-main', description: '元のコンポーネントが無くなったインスタンス' },
  { name: 'unused-component', description: 'どこからも使われていないコンポーネントの元（バリアントは、まとまりのどれかが使われていれば使われているとみなす）' },
  { name: 'unused-font', description: 'どのテキストの描画にも使われていない、埋め込んだ書体（書体名・太さごと。描画と同じく、テキストの書体の指定の先頭の名前と太さで選ぶ）' },
  {
    name: 'small-target',
    description: '押す対象（名前が `--target-name` の正規表現に合うフレーム・インスタンス。既定 `button|btn|link|ボタン|リンク`、大文字と小文字は区別しない）で、幅か高さが `--target-size`（既定 44）より小さいもの',
  },
  { name: 'off-grid', needs: 'grid', description: '間隔・余白・角丸が `--grid N` の倍数でないもの（0 と、両端に揃えて意味の無い間隔は除く）' },
  { name: 'off-palette', needs: 'palette', description: '`--palette` の色の一覧に無い塗り・線の色（描かれるものだけ。非表示・不透明度 0・マスクの中やブーリアン演算の材料は除く。影の色も除く）' },
]

const NAMES = new Set(CHECKS.map((check) => check.name))
const DEFAULT_NAME = /^(?:Frame|Rectangle|Ellipse|Line|Path|Polygon|Star|Text|Image|Boolean|Group|Mask group|合体|差し引き|交差|除外)(?: \d+)?$/
const DEFAULT_TARGET = 'button|btn|link|ボタン|リンク'

/** ls と同じ順（手前が上、親の次に子）でページのノードを辿る */
function* walk(page: Page, ids: readonly NodeId[] = page.rootIds): Generator<SceneNode> {
  for (const id of ids.toReversed()) {
    const node = page.nodes[id]
    yield node
    if (node.type === 'frame') yield* walk(page, node.children)
  }
}

function hasHiddenAncestor(page: Page, node: SceneNode): boolean {
  for (let p = node.parentId; p !== null; p = page.nodes[p].parentId) if (!page.nodes[p].visible) return true
  return false
}

/** 中身を切り抜く祖先のフレームのうち、node がその外にあるもの（近いものから） */
function clippingOutside(page: Page, node: SceneNode): SceneNode | null {
  let box: ReturnType<typeof getAbsoluteBounds> | null = null
  for (let p = node.parentId; p !== null; p = page.nodes[p].parentId) {
    const parent = page.nodes[p]
    if (parent.type !== 'frame' || !parent.clipContent || parent.booleanOperation !== null) continue
    box ??= getAbsoluteBounds(page, node.id)
    if (!intersects(box, getAbsoluteBounds(page, parent.id))) return parent
  }
  return null
}

/** 祖先がどれも中身を描くか（非表示・不透明度 0・マスク・ブーリアン演算の材料の中は描かれない。viewer の色の一覧と同じ決まり） */
function drawnAncestors(page: Page, node: SceneNode): boolean {
  for (let p = node.parentId; p !== null; p = page.nodes[p].parentId) {
    const parent = page.nodes[p]
    if (!parent.visible || parent.opacity === 0 || isMaskNode(parent) || (parent.type === 'frame' && parent.booleanOperation !== null)) return false
  }
  return true
}

function nodePaints(node: SceneNode): Paint[] {
  if (node.type === 'image') return []
  const fills = visiblePaints(node.fills)
  return node.type !== 'text' && hasStroke(node) ? [...fills, ...visiblePaints(node.strokes)] : fills
}

function spacingValues(node: SceneNode): [string, number][] {
  const values: [string, number][] = []
  if ('cornerRadius' in node && !(node.type === 'frame' && node.booleanOperation !== null)) {
    const radius = node.cornerRadius
    if (typeof radius === 'number') values.push(['cornerRadius', radius])
    else radius.forEach((value, i) => values.push([`cornerRadius.${i}`, value]))
  }
  if (node.type === 'frame' && node.layout) {
    const { gap, paddingTop, paddingRight, paddingBottom, paddingLeft, wrap, crossGap, justify, alignContent } = node.layout
    // 両端に揃えるときの間隔は並べ直しが決めるので、値に意味が無い
    if (justify !== 'space-between') values.push(['gap', gap])
    values.push(['paddingTop', paddingTop], ['paddingRight', paddingRight], ['paddingBottom', paddingBottom], ['paddingLeft', paddingLeft])
    if (wrap && alignContent !== 'space-between') values.push(['crossGap', crossGap])
  }
  return values
}

/** コンポーネントの表示（boolean）のプロパティに結んだノード。非表示は意図したもの */
function toggledNodes(page: Page): Set<NodeId> {
  const ids = new Set<NodeId>()
  for (const node of Object.values(page.nodes)) {
    if (!isMain(node)) continue
    for (const property of node.component.properties) if (property.type === 'boolean') for (const id of property.targets) ids.add(id)
  }
  return ids
}

function lintNodes(doc: DesignDocument, page: Page, options: Options, report: Report): void {
  const skipUnder = new Set<NodeId>()
  const toggled = toggledNodes(page)
  for (const node of walk(page)) {
    // 背景を合成するので重い。止めているときは求めない
    if (node.type === 'text' && options.contrast !== false) lintContrast(page, node, report)
    // インスタンスの中身は元の写しなので、元の側で出す（同じものをインスタンスの数だけ出さない）
    if (owningInstance(page, node.id) !== null) continue
    const quoted = `${nodeKind(node)} ${JSON.stringify(node.name)}`
    if (DEFAULT_NAME.test(node.name)) report('default-name', `${quoted}: 作ったときの名前のまま`, page, node)
    if (node.type === 'text' && node.text.trim() === '') report('empty-text', `${quoted}: 中身が空のテキスト`, page, node)
    if (!node.visible && !toggled.has(node.id) && !hasHiddenAncestor(page, node)) report('hidden', `${quoted}: 非表示`, page, node)
    const line = node.type === 'path' || node.type === 'text'
    if (line ? node.width === 0 && node.height === 0 : node.width === 0 || node.height === 0) {
      report('zero-size', `${quoted}: 大きさが ${node.width}×${node.height}`, page, node)
    }
    // フレームの外に出たものは、その中身を 1 つずつ出さない
    if (node.parentId !== null && skipUnder.has(node.parentId)) skipUnder.add(node.id)
    else {
      const clip = clippingOutside(page, node)
      if (clip) {
        skipUnder.add(node.id)
        report('out-of-frame', `${quoted}: ${JSON.stringify(clip.name)}（${clip.id}）の外にあって見えない`, page, node)
      }
    }
    if (isInstance(node) && findMain(doc, node.component.id) === null) report('missing-main', `${quoted}: 元のコンポーネントが無い`, page, node)
    if (node.type === 'frame' && options.targetName.test(node.name) && (node.width < options.targetSize || node.height < options.targetSize)) {
      report('small-target', `${quoted}: 押す対象が ${node.width}×${node.height}（${options.targetSize}×${options.targetSize} より小さい）`, page, node)
    }
    if (options.grid !== undefined) {
      const off = spacingValues(node).filter(([, value]) => value !== 0 && Math.abs(value / options.grid! - Math.round(value / options.grid!)) > 1e-6)
      if (off.length > 0) report('off-grid', `${quoted}: ${off.map(([key, value]) => `${key}=${value}`).join(' ')} が ${options.grid} の倍数でない`, page, node)
    }
    if (options.palette !== undefined && node.visible && node.opacity > 0 && !isMaskNode(node) && drawnAncestors(page, node)) {
      const colors = new Set<string>()
      for (const paint of nodePaints(node)) {
        if (paint.type === 'solid') colors.add(paint.color.toLowerCase())
        else for (const stop of paint.stops) if (stop.opacity > 0) colors.add(stop.color.toLowerCase())
      }
      const off = [...colors].filter((color) => !options.palette!.has(color))
      if (off.length > 0) report('off-palette', `${quoted}: 一覧に無い色 ${off.join(' ')}`, page, node)
    }
  }
}

/** コントラスト不足。比は丸めずに基準と比べる（contrastLevels と同じ） */
function lintContrast(page: Page, node: SceneNode, report: Report): void {
  const result = textContrast(page, node.id)
  if (result === null || result.kind !== 'measured' || result.aa) return
  const { text, background, ratio } = result.lowest
  const threshold = result.large ? CONTRAST_AA_LARGE : CONTRAST_AA
  const white = result.overWhite ? '、透けた所は白の地として' : ''
  report(
    'low-contrast',
    `${nodeKind(node)} ${JSON.stringify(node.name)}: コントラスト比 ${formatRatio(ratio)}（AA の基準 ${threshold}:1 に届かない。文字 ${text}・背景 ${background}${white}）`,
    page,
    node,
  )
}

/** どこからも使われていない元。インスタンスのほか、入れ子の差し替えの上書きと、差し替えのプロパティの候補からの参照も使われているとみなす */
function lintComponents(doc: DesignDocument, report: Report): void {
  const used = new Set<string>()
  for (const page of doc.pages) {
    for (const node of Object.values(page.nodes)) {
      if (isMain(node)) for (const property of node.component.properties) for (const id of property.preferred) used.add(id)
      if (!isInstance(node)) continue
      used.add(node.component.id)
      for (const override of Object.values(node.component.overrides)) if (override.componentId !== undefined) used.add(override.componentId)
    }
  }
  for (const page of doc.pages) {
    for (const node of Object.values(page.nodes)) {
      if (!isMain(node) || owningInstance(page, node.id) !== null) continue
      if (used.has(node.component.id)) continue
      const set = variantSetOf(page, node.id)
      if (set && variantsIn(page, set.id).some((variant) => used.has(variant.component.id))) continue
      report('unused-component', `${nodeKind(node)} ${JSON.stringify(node.name)}: どこからも使われていないコンポーネント`, page, node)
    }
  }
}

/** 描画と同じ選び方（usedFontFaces）で使われる書体。インスタンスの写しには上書きの結果が入っているので、上書きも含まれる */
function lintFonts(doc: DesignDocument, report: Report): void {
  const texts = doc.pages.flatMap((page) => Object.values(page.nodes).filter((node) => node.type === 'text'))
  const used = new Set(usedFontFaces(doc.fonts, doc.assets, texts))
  for (const font of doc.fonts) {
    if (used.has(font)) continue
    const face = `${JSON.stringify(font.family)} ${font.weight}${font.style === 'italic' ? ' italic' : ''}`
    report('unused-font', `${face}: どのテキストでも使われていない書体`, undefined, undefined)
  }
}

/** 検査する。enabled は動かす検査の名前 */
export function lintDocument(doc: DesignDocument, enabled: ReadonlySet<string>, options: Options): Finding[] {
  const findings: Finding[] = []
  const report: Report = (check, message, page, node) => {
    if (!enabled.has(check)) return
    findings.push({ check, page: page?.id ?? null, id: node?.id ?? null, name: node?.name ?? null, message })
  }
  lintFonts(doc, report)
  for (const page of doc.pages) lintNodes(doc, page, { ...options, contrast: enabled.has('low-contrast') }, report)
  lintComponents(doc, report)
  // ページの順（ドキュメント全体のものが先）。ページの中では、ノードを辿った順の後にコンポーネントの検査
  const order = new Map(doc.pages.map((page, i) => [page.id, i]))
  return findings.map((finding, i) => ({ finding, i })).sort((a, b) => (order.get(a.finding.page ?? '') ?? -1) - (order.get(b.finding.page ?? '') ?? -1) || a.i - b.i).map(({ finding }) => finding)
}

function checkNames(step: Step, key: string): string[] | undefined {
  const raw = option(step, key)
  if (raw === undefined) return undefined
  const names = raw.split(',').map((name) => name.trim()).filter(Boolean)
  if (names.length === 0) throw new UsageError(`--${key} に検査の名前を指定してください`)
  for (const name of names) if (!NAMES.has(name)) throw new UsageError(`--${key}: 不明な検査です: ${name}（${[...NAMES].join(' / ')}）`)
  return names
}

async function paletteOption(step: Step, readFile: (path: string) => Promise<Uint8Array>): Promise<Set<string> | undefined> {
  const raw = option(step, 'palette')
  if (raw === undefined) return undefined
  // # で始まれば色の並び、そうでなければ色を書いたファイル（JSON・CSS など、#rrggbb を拾う）
  const text = raw.trim().startsWith('#') ? raw : new TextDecoder().decode(await readFile(raw))
  const colors = new Set((text.match(/#[0-9a-fA-F]{6}(?![0-9a-fA-F])/g) ?? []).map((color) => color.toLowerCase()))
  if (colors.size === 0) throw new UsageError(`--palette に #rrggbb の色がありません: ${raw}`)
  return colors
}

export const lint: Command = {
  name: 'lint',
  kind: 'query',
  reports: true,
  usage: 'lint [--only 検査,…] [--skip 検査,…] [--grid N] [--palette 色,…|ファイル] [--target-size N] [--target-name 正規表現] [--json]',
  summary:
    'ドキュメント全体（全ページ）の直したほうがよい所を検査し、1 行に id・検査の名前・説明を出す。見つかれば終了コード 1（CI で止められる）、無ければ何も出さず 0。検査の一覧は kdr docs',
  flags: ['json'],
  async run({ session, print, report, readFile }, step) {
    checkStep(step, { options: ['only', 'skip', 'grid', 'palette', 'target-size', 'target-name', 'json'], positionals: 0 })
    const only = checkNames(step, 'only')
    const skip = new Set(checkNames(step, 'skip') ?? [])
    const grid = numberOption(step, 'grid')
    if (grid !== undefined && grid <= 0) throw new UsageError('--grid は正の数です')
    const targetSize = numberOption(step, 'target-size') ?? 44
    if (targetSize <= 0) throw new UsageError('--target-size は正の数です')
    const pattern = option(step, 'target-name') ?? DEFAULT_TARGET
    let targetName: RegExp
    try {
      targetName = new RegExp(pattern, 'i')
    } catch {
      throw new UsageError(`--target-name の正規表現が正しくありません: ${pattern}`)
    }
    const palette = await paletteOption(step, readFile)
    const given: Record<string, boolean> = { grid: grid !== undefined, palette: palette !== undefined }
    for (const name of only ?? []) {
      const needs = CHECKS.find((check) => check.name === name)?.needs
      if (needs && !given[needs]) throw new UsageError(`${name} は --${needs} を指定したときだけ動きます`)
    }
    const enabled = new Set(
      CHECKS.filter((check) => (only ? only.includes(check.name) : check.needs === undefined || given[check.needs]) && !skip.has(check.name)).map((check) => check.name),
    )
    const findings = lintDocument(session.document, enabled, { grid, palette, targetSize, targetName })
    if (findings.length > 0) report()
    if (flag(step, 'json')) {
      print(JSON.stringify(findings, null, 2))
      return
    }
    const lines: string[] = []
    let current: string | null = null
    for (const finding of findings) {
      if (finding.page !== null && finding.page !== current) {
        current = finding.page
        lines.push(`# ${session.document.pages.find((page) => page.id === current)?.name}  ${current}`)
      }
      lines.push(`${finding.id ?? '-'}\t${finding.check}\t${finding.message}`)
    }
    if (lines.length > 0) print(lines.join('\n'))
  },
}
