import { join } from 'node:path'
import { exportTargets, pngBaseName, pngFileName } from '../../src/canvas/exportPng.ts'
import { kdrFile } from '../../src/document/kdr.ts'
import { exportSvg, svgFileName } from '../../src/document/svgExport.ts'
import { pruneAssets } from '../../src/editor/operations/document.ts'
import { CODE_FORMAT_LABELS, type CodeFormat, componentName } from '../../src/viewer/codeFormat.ts'
import { type ColorFormat } from '../../src/viewer/colors.ts'
import { type Unit } from '../../src/viewer/inspect.ts'
import { safeFileName } from '../../src/ui/download.ts'
import { nodeCode, nodeMarkup, slug, standaloneHtml } from '../../src/viewer/markup.ts'
import { type Step, UsageError } from '../args.ts'
import { canvasTextMetrics, encodePng } from '../png.ts'
import { estimateTextLines } from '../textMeasure.ts'
import { type Command, checkStep, colorOption, flag, numberOption, option, positional } from './common.ts'

// 書き出すコマンド（CSS・HTML・kdr の JSON を標準出力に出す）

export const css: Command = {
  name: 'css',
  kind: 'query',
  usage: 'css ノード [--format html|react|css-modules|tailwind|vue] [--unit px|rem] [--rem-base 16] [--color hex|rgb|hsl]',
  summary: 'viewer のインスペクトと同じ CSS を出す。--format react なら style の値、tailwind ならクラス',
  run({ session, print }, step) {
    checkStep(step, { options: ['format', 'unit', 'rem-base', 'color'], positionals: 1 })
    const id = session.resolveOne(positional(step, 0, 'ノード'))
    print(nodeCode(session.page, id, codeStyle(step), session.document.assets).code)
  },
}

export const html: Command = {
  name: 'html',
  kind: 'query',
  usage: 'html ノード [--standalone] [--format html|react|css-modules|tailwind|vue] [--unit px|rem] [--rem-base 16] [--color hex|rgb|hsl]',
  summary:
    'ノードと中身の HTML と CSS を出す。--format で React（JSX）・Tailwind・Vue（.vue）にもできる。--standalone ならブラウザで開ける 1 つの HTML（画像は埋め込み）',
  flags: ['standalone'],
  run({ session, print }, step) {
    checkStep(step, { options: ['standalone', 'format', 'unit', 'rem-base', 'color'], positionals: 1 })
    const id = session.resolveOne(positional(step, 0, 'ノード'))
    const standalone = flag(step, 'standalone')
    const style = codeStyle(step)
    const format = style.format ?? 'html'
    if (standalone && format !== 'html') throw new UsageError('html: --standalone は --format html のときだけ使えます')
    const markup = nodeMarkup(session.page, id, {
      style,
      assets: session.document.assets,
      images: standalone ? 'embed' : 'file',
    })
    if (standalone) print(standaloneHtml(session.page.nodes[id].name, markup).trimEnd())
    else if (format === 'html') print(`<style>\n${markup.css}\n</style>\n${markup.html}`)
    // JSX や .vue はそのまま。CSS Modules など CSS が別のファイルになる形式は、ファイル名の見出しを付けて後ろに続ける
    else print(markup.css === '' ? markup.html : `${markup.html}\n\n/* ${cssFileName(session.page.nodes[id].name)} */\n${markup.css}`)
  },
}

export const json: Command = {
  name: 'json',
  kind: 'query',
  usage: 'json [--pretty]',
  summary: 'kdr の document.json の中身（画像を除いたドキュメントの JSON）を出す',
  flags: ['pretty'],
  run({ session, print }, step) {
    checkStep(step, { options: ['pretty'], positionals: 0 })
    const value = kdrFile(pruneAssets(session.document))
    print(JSON.stringify(value, null, flag(step, 'pretty') ? 2 : undefined))
  },
}

export const png: Command = {
  name: 'png',
  kind: 'export',
  usage: 'png [ノード…] [--scale 2] [--to ファイル.png | - ] [--each] [--background #rrggbb]',
  summary:
    'viewer の PNG 書き出しと同じ絵の PNG を書き出す。ノードなしならページ全体、ノード（フレームなど、いくつでも）ならそれらを囲む範囲。' +
    '--scale は倍率（既定 1。viewer は 1 / 2 / 3）。--to を省くと viewer と同じ名前で今のフォルダへ（- は標準出力）。' +
    '--each はノードごとに別のファイルにする（--to はフォルダ）。--background は範囲全体に背景の色を敷く（既定は透明）。@napi-rs/canvas が要る',
  flags: ['each'],
  async run(ctx, step) {
    checkStep(step, { options: ['scale', 'to', 'each', 'background'] })
    const { session } = ctx
    const page = session.page
    const scale = numberOption(step, 'scale') ?? 1
    if (!(scale > 0)) throw new UsageError('png: --scale は正の数です')
    const to = option(step, 'to')
    const each = flag(step, 'each')
    const background = backgroundOption('png', option(step, 'background')) ?? null
    const whole = step.positionals.length === 0
    // viewer と同じく、祖先と一緒に選んだものは除き、描く順（奥から手前）に並べる
    const { targets } = exportTargets(session.document, page, whole ? null : session.resolveAll(step.positionals))
    if (targets.length === 0) throw new UsageError('png: 書き出すものがありません（ページが空です）')
    if (each && whole) throw new UsageError('png: --each にはノードを指定してください')
    if (each && to === '-') throw new UsageError('png: --each のときは --to に標準出力（-）を使えません')

    const groups = each ? targets.map((id) => [id]) : [targets]
    for (const group of groups) {
      const bytes = await encodePng(page, session.document.assets, group, scale, background, session.document.fonts)
      const name = pngFileName(safeFileName(pngBaseName(session.document, page, group, whole)), scale)
      if (to === '-') {
        ctx.stdout(bytes)
        continue
      }
      const path = to === undefined ? name : each ? join(to, name) : to
      await ctx.writeFile(path, bytes)
      ctx.warn(`PNG を書き出しました: ${path}`)
    }
  },
}

export const svgOut: Command = {
  name: 'svg-out',
  kind: 'export',
  usage: 'svg-out [ノード…] [--to ファイル.svg | - ] [--each] [--no-ids] [--no-fonts] [--background #rrggbb]',
  summary:
    'viewer の SVG 書き出しと同じ SVG ファイルを書き出す（取り込みの svg とは逆向き）。ノードなしならページ全体、ノードならそれらを囲む範囲。' +
    '--to を省くと viewer と同じ名前で今のフォルダへ（- は標準出力）。--each はノードごとに別のファイルにする（--to はフォルダ）。' +
    '--no-ids はレイヤー名から作る id を付けない、--background は範囲全体に背景の色を敷く。' +
    'テキストが kdr に埋め込んだ書体（font-add）を使っていれば、その書体のファイルを @font-face で SVG に入れる（--no-fonts で入れない）。' +
    'テキストの折り返しは見積もった字幅で、基線は PNG と同じ Canvas で測った書体の高さで決める（測れなければ見積もる）',
  flags: ['each', 'no-ids', 'no-fonts'],
  async run(ctx, step) {
    checkStep(step, { options: ['to', 'each', 'no-ids', 'no-fonts', 'background'] })
    const { session } = ctx
    const page = session.page
    const to = option(step, 'to')
    const each = flag(step, 'each')
    const background = backgroundOption('svg-out', option(step, 'background'))
    const whole = step.positionals.length === 0
    const { targets } = exportTargets(session.document, page, whole ? null : session.resolveAll(step.positionals))
    if (targets.length === 0) throw new UsageError('svg-out: 書き出すものがありません（ページが空です）')
    if (each && whole) throw new UsageError('svg-out: --each にはノードを指定してください')
    if (each && to === '-') throw new UsageError('svg-out: --each のときは --to に標準出力（-）を使えません')

    const groups = each ? targets.map((id) => [id]) : [targets]
    // 基線はフォントの実際の高さで置く（svg の取り込みと同じ測り方。@napi-rs/canvas が無ければ見積もる）
    const textMetrics = await canvasTextMetrics()
    for (const group of groups) {
      const svg = exportSvg(page, group, {
        assets: session.document.assets,
        textLines: estimateTextLines,
        ...(textMetrics ? { textMetrics } : {}),
        ids: !flag(step, 'no-ids'),
        ...(flag(step, 'no-fonts') ? {} : { fonts: session.document.fonts }),
        ...(background === undefined ? {} : { background }),
      })
      const bytes = new TextEncoder().encode(svg)
      if (to === '-') {
        ctx.stdout(bytes)
        continue
      }
      const name = svgFileName(safeFileName(pngBaseName(session.document, page, group, whole)))
      const path = to === undefined ? name : each ? join(to, name) : to
      await ctx.writeFile(path, bytes)
      ctx.warn(`SVG を書き出しました: ${path}`)
    }
  },
}

/** png / svg-out の --background。#rrggbb か #rgb を小文字の #rrggbb にする */
function backgroundOption(command: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const text = raw.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(text)) return text
  if (/^#[0-9a-f]{3}$/.test(text)) return `#${[...text.slice(1)].map((c) => c + c).join('')}`
  throw new UsageError(`${command}: --background は #rrggbb か #rgb です: ${raw}`)
}

/** markup.ts が JSX の先頭で import する CSS のファイル名に合わせる */
function cssFileName(name: string): string {
  return `${componentName(slug(name))}.module.css`
}

function codeStyle(step: Step): { unit?: Unit; remBase?: number; color?: ColorFormat; format?: CodeFormat } {
  const format = option(step, 'format')
  if (format !== undefined && !Object.hasOwn(CODE_FORMAT_LABELS, format)) {
    throw new UsageError(`--format は ${Object.keys(CODE_FORMAT_LABELS).join(' / ')} です: ${format}`)
  }
  const unit = option(step, 'unit')
  const color = colorOption(step)
  if (unit !== undefined && unit !== 'px' && unit !== 'rem') throw new UsageError(`--unit は px か rem です: ${unit}`)
  const remBase = numberOption(step, 'rem-base')
  if (remBase !== undefined && remBase <= 0) throw new UsageError('--rem-base は正の数です')
  return {
    ...(format === undefined ? {} : { format: format as CodeFormat }),
    ...(unit === undefined ? {} : { unit }),
    ...(color === undefined ? {} : { color }),
    ...(remBase === undefined ? {} : { remBase }),
  }
}
