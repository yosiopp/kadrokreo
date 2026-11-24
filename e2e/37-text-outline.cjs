// テキストのアウトライン化（⇧⌘O）と、テキストを入れたブーリアン演算。字の形は kdr に埋め込んだ書体のファイルから読む。
// テスト用の書体は、どの字も黒い四角（src/document/testFont.ts）。四角の形のパス・穴になれば、画素の数で確かめられる
const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const { testFontBytes } = require('../src/document/testFont.ts')

const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, savedDocument, pointer } = require('./harness.cjs')

const fontPath = path.join(OUT, 'kdr-outline-test.ttf')
fs.writeFileSync(fontPath, testFontBytes({ family: 'Kdr Test' }))

/** キャンバスの黒に近い画素と、青（#3366cc）に近い画素の数（CSS ピクセル） */
async function countPixels(page) {
  // 選択の枠やハンドルが写らないよう、選択を外してから数える
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let dark = 0
    let blue = 0
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
      if (a < 200) continue
      if (r < 80 && g < 80 && b < 80) dark++
      else if (Math.abs(r - 0x33) < 30 && Math.abs(g - 0x66) < 30 && Math.abs(b - 0xcc) < 30) blue++
    }
    return { dark: dark / ratio / ratio, blue: blue / ratio / ratio }
  })
}

const near = (a, b, tolerance) => Math.abs(a - b) <= Math.max(b * tolerance, 4)

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const box = await page.locator('.canvas-view').boundingBox()
  const saved = async () => { await page.waitForTimeout(600); return (await savedDocument(page)).pages[0] }
  const origin = { x: Math.round(box.width / 2 - 150), y: Math.round(box.height / 2 - 75) }
  const at = pointer(box, origin)

  // 300×150 の青い板（画面の真ん中に置かれる）と、その上のテキスト（埋め込んだ書体）
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150"><rect id="plate" width="300" height="150" fill="#3366cc"/></svg>')
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(600)
  await page.keyboard.press('Escape')
  await page.keyboard.press('t')
  await page.mouse.click(...at(40, 50))
  await page.keyboard.type('ABCD')
  await page.keyboard.press('Escape')
  const size = page.locator('.field:has(.field-label:text-is("サイズ")) input').first()
  await size.fill('40')
  await size.press('Enter')
  await page.locator('.properties-panel input[type=file][accept*=".ttf"]').setInputFiles(fontPath)
  await page.waitForTimeout(400)
  const textId = Object.values((await saved()).nodes).find((node) => node.type === 'text')?.id
  const asText = await countPixels(page)
  check('埋め込んだ書体のテキストが板の上に描かれる', asText.dark > 4 * 24 * 28 * 0.8 && asText.blue > 0, JSON.stringify(asText))

  // ── アウトライン化（⇧⌘O）: 同じ id の、文字の形のパスになる ──
  await page.mouse.click(...at(60, 70))
  await page.keyboard.press('Shift+Meta+KeyO')
  let nodes = (await saved()).nodes
  const outlined = await countPixels(page)
  check('⇧⌘O でテキストが同じ id の文字の形のパスになる', nodes[textId]?.type === 'path' && nodes[textId].fillRule === 'nonzero' && nodes[textId].contours.length === 3,
    JSON.stringify(nodes[textId] && { type: nodes[textId].type, contours: nodes[textId].contours.length }))
  check('見た目は変わらない（黒い画素の数がほぼ同じ）', near(outlined.dark, asText.dark, 0.05) && near(outlined.blue, asText.blue, 0.05), `${JSON.stringify(asText)} → ${JSON.stringify(outlined)}`)
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, '37-text-outline.png') })
  await page.keyboard.press('Meta+z')
  nodes = (await saved()).nodes
  check('Undo でテキストに戻る', nodes[textId]?.type === 'text')

  // ── 元を残すブーリアン演算（⌥⇧S）: 板からテキストを引くと、文字の形の穴があく ──
  await page.keyboard.press('Escape')
  await page.mouse.click(...at(10, 10))
  await page.keyboard.down('Shift')
  await page.mouse.click(...at(60, 70))
  await page.keyboard.up('Shift')
  await page.keyboard.press('Alt+Shift+KeyS')
  nodes = (await saved()).nodes
  const group = Object.values(nodes).find((node) => node.type === 'frame' && node.booleanOperation === 'subtract')
  const holes = await countPixels(page)
  check('テキストが子としてブーリアン演算のノードに入る', group?.children.includes(textId) && group.children.length === 2, JSON.stringify(group?.children))
  check('文字の形で板に穴があく（文字は描かず、青い画素の数は重ねたときと同じ）', holes.dark < asText.dark * 0.05 && near(holes.blue, asText.blue, 0.05),
    `${JSON.stringify(asText)} → ${JSON.stringify(holes)}`)
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, '37-text-boolean.png') })

  // ── viewer でも同じ形に描く（書体のファイルから字の形を読む） ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'text-boolean.kdr')
  await download.saveAs(kdrPath)
  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(500)
  const inViewer = await countPixels(viewer)
  const zoom = await viewer.evaluate(() => {
    const text = [...document.querySelectorAll('button, span')].map((e) => e.textContent).find((t) => /^\d+%$/.test(t?.trim() ?? ''))
    return text ? parseInt(text) / 100 : 1
  })
  const scaled = asText.blue * zoom * zoom
  check('viewer でもテキストの形の穴があく', inViewer.dark < 20 && near(inViewer.blue, scaled, 0.08), `${JSON.stringify(inViewer)} 期待する青 ${scaled.toFixed(0)}（${zoom * 100}%）`)
  await viewer.screenshot({ path: path.join(OUT, '37-text-boolean-viewer.png') })

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
