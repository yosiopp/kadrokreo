import { kdrFile } from '../../src/document/kdr.ts'
import { pruneAssets } from '../../src/editor/operations/document.ts'
import { type ColorFormat } from '../../src/viewer/colors.ts'
import { type Unit, nodeCss } from '../../src/viewer/inspect.ts'
import { nodeMarkup, standaloneHtml } from '../../src/viewer/markup.ts'
import { type Step, UsageError } from '../args.ts'
import { type Command, checkStep, flag, numberOption, option, positional } from './common.ts'

// 書き出すコマンド（CSS・HTML・kdr の JSON を標準出力に出す）

export const css: Command = {
  name: 'css',
  kind: 'query',
  usage: 'css ノード [--unit px|rem] [--rem-base 16] [--color hex|rgb|hsl]',
  summary: 'viewer のインスペクトと同じ CSS を出す',
  run({ session, print }, step) {
    checkStep(step, { options: ['unit', 'rem-base', 'color'], positionals: 1 })
    const id = session.resolveOne(positional(step, 0, 'ノード'))
    print(nodeCss(session.page, id, codeStyle(step)))
  },
}

export const html: Command = {
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
