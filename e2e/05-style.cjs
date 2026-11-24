const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const { lineDirection } = require('./kdr.cjs')

const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, savedDocument, pointer, fieldFinder, rowFinder } = require('./harness.cjs')
require('fs').mkdirSync(OUT, { recursive: true })

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const box = await page.locator('.canvas-view').boundingBox()
  const at = pointer(box)
  const drag = async (from, to) => {
    await page.mouse.move(...at(...from)); await page.mouse.down()
    await page.mouse.move(...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), { steps: 4 })
    await page.mouse.move(...at(...to), { steps: 4 })
    await page.mouse.up()
  }
  const row = rowFinder(page)
  const field = fieldFinder(page)
  const num = async (label) => Number(await field(label).inputValue())
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }
  const saved = async () => {
    const doc = await savedDocument(page)
    return { ...doc, nodes: Object.assign({}, ...doc.pages.map((page) => page.nodes)) }
  }
  const byName = async (name) => { await page.waitForTimeout(700); return Object.values((await saved()).nodes).find((n) => n.name === name) }
  // 描画は requestAnimationFrame でまとめられるので、2 フレーム待ってから読む
  const pixel = (x, y) => page.evaluate(async ([x, y]) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    return [...canvas.getContext('2d').getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data]
  }, [x, y])

  // ── 直線 ──
  await page.keyboard.press('l')
  await page.keyboard.down('Shift')
  await drag([100, 80], [300, 86])
  await page.keyboard.up('Shift')
  check('Shift で水平な直線を引ける', (await num('W')) === 200 && (await num('H')) === 0, `${await num('W')}x${await num('H')}`)
  check('直線の項目は線だけ', (await page.locator('.section-title:text-is("線")').count()) === 1 && (await page.locator('.section-title:text-is("塗り")').count()) === 0)
  await set('太さ', 4)
  // 右端をつかんで下へ
  await drag([300, 80], [300, 180])
  let line = await byName('Line 1')
  check('端をつかんで向きを変えられる', line.width === 200 && line.height === 100 && lineDirection(line) === 'down' && line.strokeWidth === 4, JSON.stringify(line))
  // 左端を右端より右下へ → 向きが入れ替わっても形が保たれる
  await drag([100, 80], [400, 80])
  line = await byName('Line 1')
  check('反対側へ引くと向きが反転する', line.x === 300 && line.width === 100 && line.height === 100 && lineDirection(line) === 'up', JSON.stringify(line))
  // 線の上をクリックすると選べ、線から離れた枠内では選べない
  await page.mouse.click(...at(700, 500))
  await page.mouse.click(...at(350, 130))
  check('線の上をクリックして選択', (await page.locator('.layer-row[data-selected="true"]').count()) === 1)
  await page.mouse.click(...at(700, 500))
  await page.mouse.click(...at(310, 90))
  check('線から離れた場所では選択されない', (await page.locator('.layer-row[data-selected="true"]').count()) === 0)

  // ── 影と角丸 ──
  await page.keyboard.press('f'); await drag([80, 240], [380, 480])
  await set('半径', 24)
  await page.locator('label:has-text("影を付ける") input').check()
  await set('ぼかし', 30)
  await set('濃さ', 40)
  const frame = await byName('Frame 1')
  check('フレームに角丸と影', frame.cornerRadius === 24 && frame.effects.length === 1 && frame.effects[0].blur === 30 && frame.effects[0].opacity === 0.4, JSON.stringify(frame.effects))
  await page.mouse.click(...at(700, 500))
  const corner = await pixel(82, 242)
  check('角丸の外はフレームの色で塗られない', corner[3] < 128, corner.join())
  const below = await pixel(230, 492)
  check('影が描かれる', below[3] > 10 && below[3] < 128, below.join())
  // 影を重ねる
  await page.mouse.click(...at(230, 300))
  await page.locator('button:text-is("影を足す")').click()
  await page.locator('.field:has(.field-label:text-is("縦")) input').nth(1).fill('40')
  await page.locator('.field:has(.field-label:text-is("縦")) input').nth(1).press('Enter')
  const layered = await byName('Frame 1')
  check('影を 2 つ重ねられる', layered.effects.length === 2 && layered.effects[1].y === 40 && layered.effects[0].blur === 30, JSON.stringify(layered.effects))
  await page.mouse.click(...at(700, 500))
  const far = await pixel(230, 515)
  check('2 つ目の影も描かれる', far[3] > 10, far.join())
  await page.mouse.click(...at(230, 300))
  await page.locator('[aria-label="影 2を外す"]').click()
  check('重ねた影を外せる', (await byName('Frame 1')).effects.length === 1)
  await page.mouse.click(...at(700, 500))

  // ── 半透明のフレーム ──
  await page.keyboard.press('r'); await drag([120, 280], [220, 380])
  await page.keyboard.press('r'); await drag([180, 320], [300, 440])
  for (const name of ['Rectangle 1', 'Rectangle 2']) {
    await row(name).click()
    await page.locator('.color-field input[type=color]').first().fill('#000000')
  }
  await row('Frame 1').click()
  await page.locator('[aria-label="塗りを外す"]').click()
  await page.locator('label:has-text("影を付ける") input').uncheck()
  await set('%', 50)
  await page.mouse.click(...at(700, 500))
  await page.waitForTimeout(200)
  const single = await pixel(140, 300)
  const overlap = await pixel(200, 350)
  check('半透明フレームの中の重なりは透けない', Math.abs(single[3] - overlap[3]) <= 2 && single[3] > 110 && single[3] < 145, `${single.join()} / ${overlap.join()}`)
  await page.screenshot({ path: path.join(OUT, '14-style.png') })

  // ── 文字スタイル ──
  await page.keyboard.press('t')
  await drag([460, 240], [700, 280])
  await page.keyboard.type('見出しのテキスト\nTwo lines of centered text')
  await page.keyboard.press('Escape')
  const plain = await byName('Text 1')
  await page.locator('[aria-label="太字"]').click()
  await page.locator('[aria-label="中央寄せ"]').click()
  await set('行の高さ', 2)
  const styled = await byName('Text 1')
  check('太字・中央寄せ・行の高さ', styled.fontWeight === 700 && styled.textAlign === 'center' && styled.lineHeight === 2 && styled.height > plain.height * 1.5, `${plain.height} -> ${styled.height}`)
  await page.locator('.field:has(.field-label:text-is("太さ")) select').selectOption('300')
  check('文字の太さを 100〜900 から選べる', (await byName('Text 1')).fontWeight === 300)
  await page.locator('.field:has(.field-label:text-is("太さ")) select').selectOption('700')
  await field('行の高さ').focus()
  await page.keyboard.press('ArrowDown')
  check('行の高さは 0.1 刻みで変えられる', (await field('行の高さ').inputValue()) === '1.9', await field('行の高さ').inputValue())
  await page.mouse.click(...at(700, 500))
  await page.screenshot({ path: path.join(OUT, '15-text-style.png') })
  // 中央寄せのテキストを編集しても位置がずれない
  await page.mouse.dblclick(...at(580, 260))
  await page.waitForSelector('.text-editor')
  await page.screenshot({ path: path.join(OUT, '16-text-style-editing.png') })
  await page.keyboard.press('Escape')

  // ── 書き出しと viewer ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'style.kdr')
  await download.saveAs(kdrPath)
  const json = await require('./kdr.cjs').parseKdrBytes(fs.readFileSync(kdrPath))
  check('kdr は version 16', json.version === 16)

  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(400)
  await viewer.screenshot({ path: path.join(OUT, '17-viewer-style.png') })

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
