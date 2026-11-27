const { chromium } = require('playwright-core')
const path = require('path')

// 読めない自動保存（別の版のもの・壊れたもの）: 黙って消さず、知らせの画面を出して、破棄を選ぶまで残す。
// 残している間は上書きしない。破棄すると新しいドキュメントから始まり、その後は自動保存される。
const { OUT, EDITOR, check, finish, crashed, watchErrors, savedDocument, pointer } = require('./harness.cjs')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  // 破棄の確認に、はい・いいえのどちらで答えるか
  let accept = true
  const dialogs = []
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message())
    return accept ? dialog.accept() : dialog.dismiss()
  })
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const at = pointer(await page.locator('.canvas-view').boundingBox())
  const drawRect = async () => {
    await page.keyboard.press('r')
    await page.mouse.move(...at(200, 200)); await page.mouse.down()
    await page.mouse.move(...at(260, 240), { steps: 4 }); await page.mouse.move(...at(320, 280), { steps: 4 })
    await page.mouse.up()
  }
  const layers = () => page.locator('.layer-row .layer-name').allTextContents()
  /** 保存先の中身: 'current' のレコードと画像の数 */
  const stored = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction(['document', 'assets'])
      const current = tx.objectStore('document').get('current')
      const assets = tx.objectStore('assets').count()
      tx.oncomplete = () => resolve({ current: current.result, assets: assets.result })
      tx.onerror = () => reject(tx.error)
    }
  }))
  /** 保存先を、読めない保存データに書き換える（画像のストアには古い形の画像を 1 枚） */
  const writeSaved = (current) => page.evaluate((current) => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction(['document', 'assets'], 'readwrite')
      tx.objectStore('document').clear()
      tx.objectStore('assets').clear()
      tx.objectStore('document').put(current, 'current')
      tx.objectStore('assets').put({ mime: 'image/png', data: 'iVBORw0KGgo=' }, 'a1')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    }
  }), current)
  const oldDocument = (name) => {
    const image = { id: 'img', name: 'old photo', type: 'image', parentId: null, x: 0, y: 0, width: 10, height: 10, assetId: 'a1' }
    return { name, assets: {}, pages: [{ id: 'p1', name: 'P', nodes: { img: image }, rootIds: ['img'] }] }
  }
  const notice = (kind) => page.locator(`.editor-notice[data-kind="unreadable-${kind}"]`)
  const discardButton = page.locator('button:text-is("破棄して新しく始める")')
  const reopen = async (kind) => {
    await page.reload()
    await notice(kind).waitFor()
  }

  // ── 保存データには印が付く ──
  await drawRect()
  await page.waitForTimeout(800)
  const first = await stored()
  check('自動保存に version と印（revision）が入る', first.current.version === 17 && typeof first.current.revision === 'string' && first.current.revision.length > 0, JSON.stringify({ version: first.current.version, revision: first.current.revision }))

  // ── 前の版の保存データ ──
  await writeSaved({ version: 15, document: oldDocument('前の版') })
  await reopen('older')
  const olderText = await notice('older').innerText()
  check('前の版の保存データがあると、消さずに知らせの画面を出す', olderText.includes('前の版で保存した編集中の内容があります') && olderText.includes('いまの版では読み込めません'), olderText.slice(0, 40))
  check('知らせには、前の版のイメージで開けば kdr に書き出せることと、破棄すれば新しく始められることが書いてある', olderText.includes('保存したときの版のイメージで editor を開いて「kdr に書き出し」') && olderText.includes('破棄して新しいドキュメントから始められます'))
  check('知らせの間は editor の画面を出さない', (await page.locator('.canvas-view, .toolbar, .layers-panel').count()) === 0)
  await page.screenshot({ path: path.join(OUT, '41-unreadable-older.png') })
  await page.waitForTimeout(800)
  let now = await stored()
  check('前の版の保存データは、画像ごと残っている', now.current.version === 15 && now.current.document.name === '前の版' && now.assets === 1, JSON.stringify({ version: now.current.version, assets: now.assets }))
  await reopen('older')
  check('開き直しても、破棄するまで残る', (await stored()).current.document.name === '前の版')

  // 破棄の確認で「いいえ」なら残る
  accept = false
  await discardButton.click()
  await page.waitForTimeout(300)
  now = await stored()
  check('破棄の確認を断ると、知らせも保存データもそのまま', dialogs.length === 1 && dialogs[0].includes('元に戻せません') && (await notice('older').count()) === 1 && now.current.version === 15 && now.assets === 1, dialogs.join())

  // 破棄すると新しく始まる
  accept = true
  await discardButton.click()
  await page.waitForSelector('.canvas-view canvas')
  now = await stored()
  check('破棄すると、保存データが画像ごと消え、空のドキュメントから始まる', (await layers()).length === 0 && now.current === undefined && now.assets === 0, JSON.stringify({ layers: await layers(), assets: now.assets }))
  await drawRect()
  await page.waitForTimeout(800)
  const fresh = await savedDocument(page)
  check('破棄したあとは自動保存される', (await stored()).current.version === 17 && Object.values(fresh.pages[0].nodes).map((node) => node.name).join() === 'Rectangle 1', JSON.stringify(Object.keys(fresh.pages[0].nodes)))
  await page.reload()
  await page.waitForSelector('.layer-row')
  check('開き直すと、破棄したあとに描いたものが戻る', (await layers()).join() === 'Rectangle 1', (await layers()).join())

  // ── 1 つ前の版（読み替えて開ける v16）の保存データ ──
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction(['document'], 'readwrite')
      const store = tx.objectStore('document')
      const request = store.get('current')
      request.onsuccess = () => store.put({ ...request.result, version: 16 }, 'current')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    }
  }))
  await page.reload()
  await page.waitForSelector('.layer-row')
  check('1 つ前の版（v16）の保存データは、知らせを出さずに読み替えて開く', (await layers()).join() === 'Rectangle 1' && (await page.locator('.editor-notice').count()) === 0, (await layers()).join())
  await drawRect()
  await page.waitForTimeout(800)
  check('読み替えて開いたあとは、今の版で自動保存する', (await stored()).current.version === 17)

  // ── 新しい版の保存データ ──
  await writeSaved({ version: 18, revision: 'next', document: oldDocument('新しい版') })
  await reopen('newer')
  const newerText = await notice('newer').innerText()
  await page.waitForTimeout(800)
  now = await stored()
  check('新しい版の保存データも、消さずに知らせる', newerText.includes('新しい版で保存した編集中の内容があります') && now.current.version === 18 && now.current.revision === 'next' && now.assets === 1, newerText.slice(0, 40))
  await discardButton.click()
  await page.waitForSelector('.canvas-view canvas')
  check('新しい版の保存データも、破棄すると新しく始まる', (await layers()).length === 0 && (await stored()).current === undefined)

  // ── 同じ version で、検証に通らない保存データ（画像が古い形の base64） ──
  await writeSaved({ version: 17, document: oldDocument('壊れた形') })
  await reopen('broken')
  const brokenText = await notice('broken').innerText()
  await page.waitForTimeout(800)
  now = await stored()
  check('検証に通らない保存データも、消さず・上書きせずに知らせる', brokenText.includes('読み込めない保存データがあります') && now.current.document.name === '壊れた形' && now.current.revision === undefined && now.assets === 1, brokenText.slice(0, 40))
  await page.screenshot({ path: path.join(OUT, '41-unreadable-broken.png') })
  await discardButton.click()
  await page.waitForSelector('.canvas-view canvas')
  check('検証に通らない保存データも、破棄すると新しく始まる', (await layers()).length === 0 && (await stored()).assets === 0)

  // ── レコードの形ですらないもの ──
  await writeSaved('garbage')
  await reopen('broken')
  await page.waitForTimeout(800)
  check('形の崩れた保存データも、消さずに知らせる', (await stored()).current === 'garbage')
  await discardButton.click()
  await page.waitForSelector('.canvas-view canvas')
  await drawRect()
  await page.waitForTimeout(800)
  check('破棄したあとは、また自動保存される', (await stored()).current.version === 17 && (await layers()).join() === 'Rectangle 1')

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
