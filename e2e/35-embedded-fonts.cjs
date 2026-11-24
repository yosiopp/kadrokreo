const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const { parseKdrBytes } = require('./kdr.cjs')
const { testFontBytes } = require('../src/document/testFont.ts')

// kdr に埋め込んだ書体: editor で書体ファイルを取り込んでテキストに使い、自動保存・kdr の書き出し・viewer・PNG でも同じ書体で描かれる。
// テスト用の書体は、どの字も送り幅 0.6em・高さ 0.7em の黒い四角（src/document/testFont.ts）。OS の書体の字より、枠の中の黒い画素がずっと多い
const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, savedDocument } = require('./harness.cjs')

const fontPath = path.join(OUT, 'kdr-test.ttf')
fs.writeFileSync(fontPath, testFontBytes({ family: 'Kdr Test' }))
const notFontPath = path.join(OUT, 'not-a-font.ttf')
fs.writeFileSync(notFontPath, 'not a font')

/** キャンバス全体の黒に近い画素の数（CSS ピクセルに直したもの）。キャンバスに描いてある黒いものはテキストだけ */
function inkOnCanvas(page) {
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let dark = 0
    for (let i = 0; i < data.length; i += 4) if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80 && data[i + 3] > 200) dark++
    return dark / ratio / ratio
  })
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const canvasBox = await page.locator('.canvas-view canvas').boundingBox()
  const saved = async () => { await page.waitForTimeout(700); return savedDocument(page) }
  const textNode = async () => Object.values((await saved()).pages[0].nodes).find((node) => node.type === 'text')
  // テキストの枠の面積に対する、キャンバスの黒い画素の割合（拡大率は 100% のまま。開き直すと中身が画面の中央に来る）
  const textInk = async () => {
    const node = await textNode()
    return (await inkOnCanvas(page)) / (node.width * node.height)
  }

  // ── テキストを作り、書体ファイルを取り込んで使う ──
  await page.keyboard.press('t')
  await page.mouse.click(canvasBox.x + 200, canvasBox.y + 200)
  await page.keyboard.type('ABCD')
  await page.keyboard.press('Escape')
  const size = page.locator('.field:has(.field-label:text-is("サイズ")) input').first()
  await size.fill('40')
  await size.press('Enter')
  const before = await textInk()
  await page.locator('.properties-panel input[type=file][accept*=".ttf"]').setInputFiles(fontPath)
  await page.waitForTimeout(300)
  let doc = await saved()
  let text = Object.values(doc.pages[0].nodes).find((node) => node.type === 'text')
  check('書体ファイルを取り込むと、書体名・太さ・斜体をファイルから読んで kdr に入る',
    doc.fonts.length === 1 && doc.fonts[0].family === 'Kdr Test' && doc.fonts[0].weight === 400 && doc.fonts[0].style === 'normal', JSON.stringify(doc.fonts))
  check('選んでいたテキストの書体がその書体になる', text.fontFamily === 'Kdr Test', text.fontFamily)
  // 4 字 × 0.6em × 40px
  check('テキストの幅は埋め込んだ書体で測る', Math.abs(text.width - 96) < 1, String(text.width))
  const embedded = await textInk()
  check('埋め込んだ書体で描かれる（字の四角で黒い画素が多い）', embedded > 0.4 && embedded > before * 1.5, `${before.toFixed(2)} → ${embedded.toFixed(2)}`)
  const options = await page.locator('.field:has(.field-label:text-is("書体")) select optgroup[label="kdr に埋め込んだ書体"] option').allTextContents()
  check('書体の一覧に埋め込んだ書体が出る', options.join() === 'Kdr Test', options.join())
  await page.screenshot({ path: path.join(OUT, '35-embedded-font.png') })

  // ── 書体でないファイルは取り込まない ──
  await page.locator('.properties-panel input[type=file][accept*=".ttf"]').setInputFiles(notFontPath)
  await page.waitForTimeout(300)
  check('書体でないファイルは理由を出して取り込まない', (await page.locator('.app-message').textContent())?.includes('書体ファイルとして読めません') && (await saved()).fonts.length === 1,
    await page.locator('.app-message').textContent())

  // ── 自動保存から開き直しても同じ書体 ──
  await page.reload()
  await page.waitForSelector('.canvas-view canvas')
  await page.waitForTimeout(500)
  const reloaded = await textInk()
  await page.screenshot({ path: path.join(OUT, '35-embedded-font-reloaded.png') })
  check('開き直しても埋め込んだ書体で描かれる（自動保存に書体が残る）', reloaded > 0.4 && (await saved()).fonts.length === 1, reloaded.toFixed(2))

  // ── kdr に書き出す ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'embedded-font.kdr')
  await download.saveAs(kdrPath)
  const kdr = await parseKdrBytes(fs.readFileSync(kdrPath))
  const fontId = kdr.raw.document.fonts?.[0]?.assetId
  check('kdr に書体のファイル（assets/<sha256>.ttf）と書体の並びが入る',
    kdr.names.includes(fontId) && kdr.document.assets[fontId].mime === 'font/ttf' && JSON.stringify(kdr.raw.document.fonts) === JSON.stringify([{ assetId: fontId, family: 'Kdr Test' }]) &&
      Buffer.from(kdr.document.assets[fontId].bytes).equals(fs.readFileSync(fontPath)),
    JSON.stringify({ names: kdr.names, fonts: kdr.raw.document.fonts }))

  // ── 書体を外すと OS の書体に戻り、元に戻すと戻る ──
  await page.keyboard.press('Escape')
  await page.mouse.click(canvasBox.x + 900, canvasBox.y + 600)
  const fontRows = page.locator('.font-list .font-row')
  check('何も選んでいないときのパネルに、埋め込んだ書体の一覧が出る', (await fontRows.count()) === 1 && (await fontRows.first().textContent()).includes('Kdr Test'))
  await page.locator('[aria-label="Kdr Test（400 Regular）を外す"]').click()
  const removed = await textInk()
  check('書体を外すと、そのテキストは OS の書体で描かれる', (await saved()).fonts.length === 0 && removed < 0.35, removed.toFixed(2))
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  const restored = await textInk()
  check('元に戻すと書体も戻る', (await saved()).fonts.length === 1 && restored > 0.4, restored.toFixed(2))

  // ── viewer: 開いて描き、PNG に書き出す ──
  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(500)
  const [pngDownload] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("ページを PNG に")').click()])
  const pngPath = path.join(OUT, 'embedded-font.png')
  await pngDownload.saveAs(pngPath)
  const png = await viewer.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' }))
    const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    let dark = 0
    for (let i = 0; i < data.length; i += 4) if (data[i] < 80 && data[i + 3] > 200) dark++
    return { width: bitmap.width, height: bitmap.height, ink: dark / (data.length / 4) }
  }, fs.readFileSync(pngPath).toString('base64'))
  check('viewer の PNG の書き出しも埋め込んだ書体で描く', png.width === 96 && png.ink > 0.4, JSON.stringify(png))
  await viewer.screenshot({ path: path.join(OUT, '35-embedded-font-viewer.png') })

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
