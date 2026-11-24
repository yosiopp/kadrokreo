import { cleanFamilyName, fontFamilyValue, readFontFileInfo } from '../../src/document/fontFile.ts'
import { KDR_MAX_ASSET_BYTES } from '../../src/document/kdr.ts'
import { addFont, removeFont } from '../../src/editor/operations/document.ts'
import { createId } from '../../src/editor/nodes.ts'
import { UsageError } from '../args.ts'
import { type Command, checkStep, flag, numberOption, option, positional } from './common.ts'

// kdr に埋め込む書体のコマンド

export const fontAdd: Command = {
  name: 'font-add',
  kind: 'edit',
  usage: 'font-add 書体ファイル [--family 書体名]',
  summary:
    '書体ファイル（TTF / OTF / WOFF / WOFF2）を kdr に埋め込む。書体名・太さ・斜体はファイルから読む。同じ書体名・太さ・斜体の書体があれば差し替える。' +
    'テキストの fontFamily に書体名を書くと、その書体で描かれる（再配布できる書体だけを入れること）',
  async run(ctx, step) {
    checkStep(step, { options: ['family'], positionals: 1 })
    const file = positional(step, 0, '書体ファイル')
    const bytes = await ctx.readFile(file)
    if (bytes.byteLength > KDR_MAX_ASSET_BYTES) {
      throw new UsageError(`${file}: 書体ファイルが大きすぎます（${KDR_MAX_ASSET_BYTES / 1024 / 1024}MB まで）`)
    }
    const info = await readFontFileInfo(bytes)
    if (info === null) throw new UsageError(`${file}: TTF / OTF / WOFF / WOFF2 の書体ファイルとして読めません`)
    const rawFamily = option(step, 'family')
    const given = rawFamily === undefined ? null : cleanFamilyName(rawFamily)
    if (rawFamily !== undefined && given !== rawFamily) throw new UsageError(`font-add: 書体名に使えない文字があります: ${rawFamily}`)
    const family = given ?? info.family ?? cleanFamilyName(file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')) ?? 'Font'
    const face = { family, weight: info.weight, style: info.style }
    ctx.session.applyDocument((doc) => addFont(doc, { mime: info.mime, bytes: new Uint8Array(bytes) }, face, createId))
    ctx.warn(`書体を埋め込みました: ${family}（太さ ${face.weight}${face.style === 'italic' ? '・斜体' : ''}）。テキストで使うには fontFamily=${JSON.stringify(fontFamilyValue(family))}`)
  },
}

export const fontRm: Command = {
  name: 'font-rm',
  kind: 'edit',
  usage: 'font-rm 書体名 [--weight 太さ] [--italic]',
  summary: '埋め込んだ書体を外す。--weight / --italic を付けなければ、その書体名の書体を全部外す',
  flags: ['italic'],
  run({ session }, step) {
    checkStep(step, { options: ['weight', 'italic'], positionals: 1 })
    const family = positional(step, 0, '書体名')
    const weight = numberOption(step, 'weight')
    const italic = flag(step, 'italic')
    const narrowed = weight !== undefined || italic
    const targets = session.document.fonts.filter(
      (font) =>
        font.family === family &&
        (!narrowed || ((weight === undefined || font.weight === weight) && (font.style === 'italic') === italic)),
    )
    if (targets.length === 0) throw new UsageError(`font-rm: 埋め込んだ書体がありません: ${family}`)
    session.applyDocument((doc) => targets.reduce((next, font) => removeFont(next, font), doc))
  },
}
