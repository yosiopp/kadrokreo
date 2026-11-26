import type { Asset, AssetId, NodeId } from '../../src/document/types.ts'
import { UsageError } from '../args.ts'
import {
  type MarkupBuild,
  type MarkupElement,
  type MarkupImage,
  MarkupError,
  addMarkupImage,
  applyMarkupOverrides,
  buildMarkupDocument,
  imageSources,
  insideInstance,
  parseMarkup,
  placeMarkupFragment,
  settleMarkup,
} from '../markup.ts'
import { type Command, type Context, checkStep, numberOption, option, positional } from './common.ts'
import { readImageFile } from './create.ts'

// マークアップ（ノードの木を宣言的に書いた XML）からノードを作るコマンド（build・place）。読み方と組み立ては markup.ts

async function readMarkup(ctx: Context, file: string): Promise<MarkupElement> {
  return parseMarkup(new TextDecoder('utf-8', { fatal: false }).decode(await ctx.readFile(file)), file)
}

/** src は、マークアップのファイルのある場所からの相対パス（絶対パスならそのまま） */
function resolveSource(file: string, src: string): string {
  if (/^([\\/]|[A-Za-z]:[\\/])/.test(src)) return src
  return file.replace(/[^\\/]*$/, '') + src
}

/** マークアップが指す画像を読み、assets に足す */
async function loadImages(ctx: Context, root: MarkupElement, file: string, assets: Record<AssetId, Asset>): Promise<Map<string, MarkupImage>> {
  const images = new Map<string, MarkupImage>()
  for (const { src, line } of imageSources(root)) {
    let read
    try {
      read = await readImageFile(ctx.readFile, resolveSource(file, src))
    } catch (error) {
      const message = error instanceof UsageError ? error.message : `画像を読めません（${error instanceof Error ? error.message : String(error)}）`
      throw new MarkupError(`${file}:${line}: src="${src}": ${message}`)
    }
    images.set(src, { assetId: addMarkupImage(assets, src, read.asset), width: read.info.width, height: read.info.height })
  }
  return images
}

/** 置いたあとの仕上げ: インスタンスの上書きを当て、もう一度落ち着かせる */
function finish(ctx: Context, built: MarkupBuild, pageIds: ReadonlySet<string>): void {
  applyMarkupOverrides(ctx.session, built)
  ctx.session.applyDocument((doc) => settleMarkup(doc, pageIds))
}

export const build: Command = {
  name: 'build',
  kind: 'source',
  usage: 'build マークアップ.xml',
  summary:
    'ノードの木を XML で宣言的に書いたマークアップ（<kdr><page><frame>…）から、新しいドキュメントを作る（先頭にだけ置ける）。同じマークアップからは同じ kdr ができる。書き間違いは「ファイル:行」を付けて知らせ、何も書き出さない。書き方は kdr docs の「マークアップ」',
  async run(ctx, step) {
    checkStep(step, { positionals: 1 })
    const file = positional(step, 0, 'マークアップのファイル')
    const root = await readMarkup(ctx, file)
    const assets: Record<AssetId, Asset> = {}
    const images = await loadImages(ctx, root, file, assets)
    const { document, build: built } = buildMarkupDocument(root, file, images, assets)
    const pageIds = new Set(document.pages.map((page) => page.id))
    ctx.session.applyDocument(() => settleMarkup(document, pageIds))
    finish(ctx, built, pageIds)
  },
}

export const place: Command = {
  name: 'place',
  kind: 'edit',
  usage: 'place マークアップ.xml [--parent フレーム] [--index N] [--x N --y N]',
  summary:
    'マークアップで書いた木の一部（最上位が <frame> などノードの要素 1 つ）を、いまのページに足す。--parent でフレームの中へ、--index は兄弟の中での重なり順（0 が最背面）。<instance> の元は、マークアップの中になければ今のドキュメントから探す。置いたものは「@」で指せる',
  async run(ctx, step) {
    checkStep(step, { options: ['parent', 'index', 'x', 'y'], positionals: 1 })
    const { session } = ctx
    const file = positional(step, 0, 'マークアップのファイル')
    const parent = option(step, 'parent')
    const parentId = parent === undefined ? null : session.resolveFrame(parent)
    if (parentId !== null && insideInstance(session.page, parentId)) {
      throw new UsageError('place: インスタンスの中には置けません（元の <component> の側に置く）')
    }
    const index = numberOption(step, 'index')
    const at = { x: numberOption(step, 'x'), y: numberOption(step, 'y') }
    const root = await readMarkup(ctx, file)
    const assets = { ...session.document.assets }
    const images = await loadImages(ctx, root, file, assets)
    const pageId = session.page.id
    const pageIds = new Set([pageId])
    let placed: { id: NodeId; build: MarkupBuild } | null = null
    session.applyDocument((doc) => {
      const result = placeMarkupFragment(root, file, images, { ...doc, assets }, pageId, parentId, index, at)
      placed = result
      return settleMarkup(result.document, pageIds)
    })
    const done = placed as { id: NodeId; build: MarkupBuild } | null
    if (done === null) return
    finish(ctx, done.build, pageIds)
    session.last = [done.id]
  },
}
