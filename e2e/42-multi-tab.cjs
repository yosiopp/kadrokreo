const { chromium } = require('playwright-core')
const path = require('path')

// editor を複数のタブで開いたとき: 編集できるのは 1 つのタブだけ。あとから開いたタブには知らせの画面を出し、自動保存を読みも書きもしない。
// 「このタブで編集を続ける」で、編集中のタブの内容を保存してから引き継ぐ。編集中のタブを閉じたあとは、残ったタブを表に出すと続きを編集できる。
// 知らせ合い（BroadcastChannel）が届かなかったときも、保存の印で上書きを止めて知らせる。
const { OUT, EDITOR, check, finish, crashed, watchErrors, savedDocument, pointer } = require('./harness.cjs')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  const errors = []
  const open = async (name, { wait = '.canvas-view canvas', init } = {}) => {
    const page = await context.newPage()
    watchErrors(page, errors, `${name}: `)
    if (init) await page.addInitScript(init)
    await page.goto(EDITOR)
    await page.waitForSelector(wait)
    return page
  }
  const elsewhere = '.editor-notice[data-kind="elsewhere"]'
  const layers = (page) => page.locator('.layer-row .layer-name').allTextContents()
  /** 四角を 1 つ描く（n 個目。重ならない位置に） */
  const drawRect = async (page, n) => {
    const at = pointer(await page.locator('.canvas-view').boundingBox())
    const x = 40 + n * 70
    await page.keyboard.press('r')
    await page.mouse.move(...at(x, 200)); await page.mouse.down()
    await page.mouse.move(...at(x + 25, 230), { steps: 4 }); await page.mouse.move(...at(x + 50, 260), { steps: 4 })
    await page.mouse.up()
  }
  const savedNames = async (page) => Object.values((await savedDocument(page)).pages[0].nodes).map((node) => node.name).sort().join()
  const revision = (page) => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const request = open.result.transaction('document').objectStore('document').get('current')
      request.onsuccess = () => resolve(request.result?.revision)
      request.onerror = () => reject(request.error)
    }
  }))
  /** タブを表に出したことにする（ヘッドレスではタブの切り替えで focus が来ない） */
  const focus = (page) => page.evaluate(() => window.dispatchEvent(new Event('focus')))

  // ── 2 つ目のタブ ──
  const a = await open('a')
  await drawRect(a, 0)
  await a.waitForTimeout(800)
  const b = await open('b', { wait: elsewhere })
  const text = await b.locator(elsewhere).innerText()
  check('2 つ目のタブには、別のタブで編集中であることを知らせる', text.includes('別のタブで編集中です') && text.includes('編集できるタブを'), text.slice(0, 30))
  check('2 つ目のタブには editor の画面を出さない', (await b.locator('.canvas-view, .toolbar, .layers-panel').count()) === 0)
  await b.screenshot({ path: path.join(OUT, '42-elsewhere.png') })
  const before = await revision(a)
  await b.waitForTimeout(800)
  check('2 つ目のタブは保存先を書かない', (await revision(a)) === before)
  await drawRect(a, 1)
  await a.waitForTimeout(800)
  check('1 つ目のタブは、そのまま編集と自動保存を続けられる', (await savedNames(a)) === 'Rectangle 1,Rectangle 2' && (await a.locator('.autosave-stopped').count()) === 0, await savedNames(a))
  await focus(b)
  await b.waitForTimeout(500)
  check('1 つ目のタブが開いている間は、2 つ目を表に出しても知らせのまま', (await b.locator(elsewhere).count()) === 1)

  // ── 引き継ぐ ──
  // 1 つ目で描いた直後（自動保存の前）に引き継いでも、描いたものが引き継がれる
  await drawRect(a, 2)
  await b.locator('button:text-is("このタブで編集を続ける")').click()
  await b.waitForSelector('.canvas-view canvas')
  check('引き継ぐと、別のタブの保存前の変更も含めて開く', (await layers(b)).slice().sort().join() === 'Rectangle 1,Rectangle 2,Rectangle 3', (await layers(b)).join())
  await a.waitForSelector(elsewhere)
  check('引き継がれたタブは、知らせの画面になる', (await a.locator('.canvas-view').count()) === 0)
  await drawRect(b, 3)
  await b.waitForTimeout(800)
  check('引き継いだタブで編集と自動保存ができる', (await savedNames(b)) === 'Rectangle 1,Rectangle 2,Rectangle 3,Rectangle 4', await savedNames(b))
  await a.locator('button:text-is("このタブで編集を続ける")').click()
  await a.waitForSelector('.canvas-view canvas')
  check('元のタブへ引き継ぎ返すと、最新の内容で開く', (await layers(a)).length === 4, (await layers(a)).join())
  await b.waitForSelector(elsewhere)

  // ── 編集中のタブを閉じたあと ──
  await drawRect(a, 4)
  await a.waitForTimeout(800)
  await a.close()
  await focus(b)
  await b.waitForSelector('.canvas-view canvas')
  check('編集中のタブを閉じたあと、残ったタブを表に出すと、続きを編集できる', (await layers(b)).length === 5, (await layers(b)).join())
  await drawRect(b, 5)
  await b.waitForTimeout(800)
  check('残ったタブで自動保存される', (await savedDocument(b)).pages[0].rootIds.length === 6)

  // ── 知らせ合いが届かないとき（保存の印で止める） ──
  // BroadcastChannel の無いタブは、ほかのタブに気づかずに編集するタブとして開く
  const c = await open('c', { init: () => { delete window.BroadcastChannel } })
  check('知らせ合いができないタブは、editor として開く', (await layers(c)).length === 6)
  await drawRect(c, 6)
  await c.waitForTimeout(800)
  const written = await revision(c)
  check('先に保存したタブの内容が保存される', (await savedDocument(c)).pages[0].rootIds.length === 7)
  // もう片方が、知らないうちに書かれた保存先へ書こうとする
  await b.locator('.layer-row').first().click()
  await b.keyboard.press('Backspace')
  await b.waitForSelector('.autosave-stopped')
  const stopped = await b.locator('.autosave-stopped').innerText()
  check('あとから保存しようとしたタブは、上書きせずに自動保存を止めて知らせる', stopped.includes('このタブの自動保存を止めました') && stopped.includes('kdr に書き出し'), stopped.slice(0, 40))
  await b.screenshot({ path: path.join(OUT, '42-autosave-stopped.png') })
  await drawRect(b, 7)
  await b.waitForTimeout(800)
  check('止めたあとは、編集しても保存先を書かない（先に保存したタブの内容が残る）', (await revision(b)) === written && (await savedDocument(b)).pages[0].rootIds.length === 7)
  check('止めたタブの内容は画面に残っている', (await layers(b)).length === 6, (await layers(b)).join())
  const [download] = await Promise.all([b.waitForEvent('download'), b.locator('button:text-is("kdr に書き出し")').click()])
  check('止めたタブの内容は kdr に書き出せる', download.suggestedFilename().endsWith('.kdr'), download.suggestedFilename())
  await drawRect(c, 8)
  await c.waitForTimeout(800)
  check('先に保存したタブは、そのまま自動保存を続けられる', (await savedDocument(c)).pages[0].rootIds.length === 8 && (await c.locator('.autosave-stopped').count()) === 0)
  await c.close()
  await b.reload()
  await b.waitForSelector('.canvas-view canvas')
  check('止めたタブを読み込み直すと、保存されている内容が開く', (await layers(b)).length === 8 && (await b.locator('.autosave-stopped').count()) === 0, String((await layers(b)).length))

  // ── 安全でないコンテキスト（http の LAN アドレスで開いたとき）に無い API に頼らない ──
  // navigator.locks と crypto.randomUUID を消し、isSecureContext を false にした別のコンテキストで、同じように働くこと
  const lan = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await lan.addInitScript(() => {
    Object.defineProperty(window, 'isSecureContext', { value: false })
    delete Navigator.prototype.locks
    delete Crypto.prototype.randomUUID
  })
  const openLan = async (name, wait) => {
    const page = await lan.newPage()
    watchErrors(page, errors, `${name}: `)
    await page.goto(EDITOR)
    await page.waitForSelector(wait)
    return page
  }
  const d = await openLan('d', '.canvas-view canvas')
  const insecure = await d.evaluate(() => !window.isSecureContext && navigator.locks === undefined && crypto.randomUUID === undefined)
  await drawRect(d, 0)
  await d.waitForTimeout(800)
  check('安全でないコンテキストでも、自動保存に印が付く', insecure && typeof (await revision(d)) === 'string', String(insecure))
  const e = await openLan('e', elsewhere)
  check('安全でないコンテキストでも、2 つ目のタブに知らせる', (await e.locator('.canvas-view').count()) === 0)
  await e.locator('button:text-is("このタブで編集を続ける")').click()
  await e.waitForSelector('.canvas-view canvas')
  await d.waitForSelector(elsewhere)
  check('安全でないコンテキストでも、引き継げる', (await layers(e)).join() === 'Rectangle 1', (await layers(e)).join())

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
