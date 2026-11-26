import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHECK_WAIT, RELEASE_WAIT, type EditorTab, type TabChannel, type TabState, createEditorTab } from './tabs.ts'

/** BroadcastChannel の代わり。送ったものは、deliver を呼んだときに、ほかの開いているチャンネルへ届く */
function createHub() {
  const channels = new Set<TabChannel>()
  const queue: { from: TabChannel; message: unknown }[] = []
  return {
    open(): TabChannel {
      const channel: TabChannel = {
        postMessage: (message) => queue.push({ from: channel, message }),
        onmessage: null,
        close: () => channels.delete(channel),
      }
      channels.add(channel)
      return channel
    },
    /** たまっている知らせを届ける（届けた先がさらに送ったものも） */
    deliver() {
      while (queue.length > 0) {
        const { from, message } = queue.shift()!
        for (const channel of [...channels]) if (channel !== from) channel.onmessage?.({ data: message })
      }
    },
  }
}

type Opened = { tab: EditorTab; states: TabState[]; released: number; finishRelease: (flushed: boolean) => void }

describe('編集するタブを 1 つにする知らせ合い', () => {
  let hub: ReturnType<typeof createHub>
  let clock = 0

  beforeEach(() => {
    vi.useFakeTimers()
    hub = createHub()
    clock = 1000
  })
  afterEach(() => vi.useRealTimers())

  /** タブを開く。release は finishRelease を呼ぶまで終わらない（autoRelease なら、すぐ保存しきれたことにする） */
  function open(id: string, { autoRelease = true, channel = true } = {}): Opened {
    const opened: Opened = { tab: null as unknown as EditorTab, states: [], released: 0, finishRelease: () => {} }
    opened.tab = createEditorTab({
      channel: channel ? hub.open() : null,
      id,
      now: () => clock,
      onChange: (state) => opened.states.push(state),
      release: () => {
        opened.released++
        return autoRelease ? Promise.resolve(true) : new Promise((resolve) => (opened.finishRelease = resolve))
      },
    })
    opened.tab.start()
    return opened
  }

  /** 知らせを届け、ms だけ時間を進め、また届ける */
  async function advance(ms = 0) {
    hub.deliver()
    await vi.advanceTimersByTimeAsync(ms)
    hub.deliver()
    await vi.advanceTimersByTimeAsync(0)
    hub.deliver()
  }

  /** 1 つ目のタブ（編集中）を開いておく */
  async function openOwner(id = 'a', options?: { autoRelease?: boolean }) {
    const owner = open(id, options)
    await advance(CHECK_WAIT)
    expect(owner.tab.state()).toBe('owner')
    clock += 5000
    return owner
  }

  it('ほかにタブが無ければ、返事を待ってから編集するタブになる', async () => {
    const a = open('a')
    expect(a.tab.state()).toBe('checking')
    await advance(CHECK_WAIT - 1)
    expect(a.tab.state()).toBe('checking')
    await advance(1)
    expect(a.states).toEqual(['owner'])
  })

  it('知らせ合いのチャンネルが使えない環境では、すぐ編集するタブになる', () => {
    const a = open('a', { channel: false })
    expect(a.states).toEqual(['owner'])
  })

  it('あとから開いたタブは、編集するタブにならない', async () => {
    const a = await openOwner()
    const b = open('b')
    await advance(CHECK_WAIT)
    expect(b.states).toEqual(['elsewhere'])
    expect(a.tab.state()).toBe('owner')
    expect(a.released).toBe(0)
    // 3 つ目も同じ
    const c = open('c')
    await advance(CHECK_WAIT)
    expect(c.states).toEqual(['elsewhere'])
  })

  it('同時に開いたタブは、先に確かめ始めたほうだけが編集するタブになる', async () => {
    const a = open('a')
    clock += 1
    const b = open('b')
    await advance(CHECK_WAIT)
    expect(a.states).toEqual(['owner'])
    expect(b.states).toEqual(['elsewhere'])
  })

  it('同じ時刻に開いたタブは、id の小さいほうだけが編集するタブになる', async () => {
    const b = open('b')
    const a = open('a')
    await advance(CHECK_WAIT)
    expect(a.states).toEqual(['owner'])
    expect(b.states).toEqual(['elsewhere'])
  })

  it('相手の最初の知らせを受け取れなかった（チャンネルを開く前に送られた）タブも、返事を受けて譲る', async () => {
    const a = open('a')
    hub.deliver() // a の hello は誰にも届かない
    clock += 1
    const b = open('b')
    await advance(CHECK_WAIT)
    expect(a.states).toEqual(['owner'])
    expect(b.states).toEqual(['elsewhere'])
  })

  it('引き継ぐと、編集中のタブが保存を済ませてから、こちらが編集するタブになる', async () => {
    const a = await openOwner('a', { autoRelease: false })
    const b = open('b')
    await advance(CHECK_WAIT)
    b.tab.takeOver()
    await advance()
    expect(b.states).toEqual(['elsewhere', 'taking'])
    expect(a.released).toBe(1)
    // 保存が終わるまでは、どちらも変わらない
    expect(a.tab.state()).toBe('owner')
    expect(b.tab.state()).toBe('taking')
    a.finishRelease(true)
    await advance()
    expect(a.states).toEqual(['owner', 'elsewhere'])
    expect(b.states).toEqual(['elsewhere', 'taking', 'owner'])
    // 立場が入れ替わっている: 元のタブが引き継ぎ返せる
    a.tab.takeOver()
    await advance()
    expect(b.released).toBe(1)
    expect(a.tab.state()).toBe('owner')
    expect(b.tab.state()).toBe('elsewhere')
  })

  it('引き継ぎに返事が無ければ（相手が居なくなっていれば）、待ってから編集するタブになる', async () => {
    const a = await openOwner()
    const b = open('b')
    await advance(CHECK_WAIT)
    a.tab.close()
    b.tab.takeOver()
    await advance(RELEASE_WAIT - 1)
    expect(b.tab.state()).toBe('taking')
    await advance(1)
    expect(b.tab.state()).toBe('owner')
  })

  it('保存しきれなかったタブは、手放したうえで知らせ合いから外れる', async () => {
    const a = await openOwner('a', { autoRelease: false })
    const b = open('b')
    await advance(CHECK_WAIT)
    b.tab.takeOver()
    await advance()
    a.finishRelease(false)
    await advance()
    expect(b.tab.state()).toBe('owner')
    // a は画面を保ったまま（立場の知らせは来ない）、もう返事をしない
    expect(a.states).toEqual(['owner'])
    b.tab.close()
    const c = open('c')
    await advance(CHECK_WAIT)
    expect(c.states).toEqual(['owner'])
  })

  it('確かめ直すと、編集中のタブが居なくなっていれば編集するタブになり、居れば変わらない', async () => {
    const a = await openOwner()
    const b = open('b')
    await advance(CHECK_WAIT)
    b.tab.recheck()
    await advance(CHECK_WAIT)
    expect(b.states).toEqual(['elsewhere'])
    a.tab.close()
    b.tab.recheck()
    await advance(CHECK_WAIT)
    expect(b.states).toEqual(['elsewhere', 'owner'])
  })

  it('残ったタブがいくつあっても、確かめ直して編集するタブになるのは 1 つだけ', async () => {
    const a = await openOwner()
    const b = open('b')
    const c = open('c')
    await advance(CHECK_WAIT)
    a.tab.close()
    c.tab.recheck()
    clock += 1
    b.tab.recheck()
    await advance(CHECK_WAIT)
    expect(c.tab.state()).toBe('owner')
    expect(b.tab.state()).toBe('elsewhere')
  })

  it('返事が待ち時間に間に合わず編集するタブが 2 つになったら、あとからなったほうが保存を済ませて手放す', async () => {
    const a = await openOwner()
    const b = open('b')
    // a の返事が届く前に、b の待ち時間が切れる
    await vi.advanceTimersByTimeAsync(CHECK_WAIT)
    expect(b.tab.state()).toBe('owner')
    await advance()
    expect(b.released).toBe(1)
    expect(b.states).toEqual(['owner', 'elsewhere'])
    expect(a.tab.state()).toBe('owner')
    expect(a.released).toBe(0)
  })

  it('引き継ぎの途中で開いたタブは、編集するタブにならない', async () => {
    const a = await openOwner('a', { autoRelease: false })
    const b = open('b')
    await advance(CHECK_WAIT)
    b.tab.takeOver()
    await advance()
    const c = open('c')
    await advance(CHECK_WAIT)
    expect(c.states).toEqual(['elsewhere'])
    a.finishRelease(true)
    await advance()
    expect(b.tab.state()).toBe('owner')
  })

  it('2 つのタブが同時に引き継ごうとしても、編集するタブになるのは 1 つだけ', async () => {
    await openOwner()
    const b = open('b')
    const c = open('c')
    await advance(CHECK_WAIT)
    c.tab.takeOver()
    b.tab.takeOver()
    await advance(RELEASE_WAIT)
    expect([b.tab.state(), c.tab.state()].sort()).toEqual(['elsewhere', 'owner'])
  })

  it('形の違う知らせは無視する', async () => {
    const a = await openOwner()
    const other = hub.open()
    for (const message of [null, 'takeover', { type: 'takeover' }, { type: 'present', from: 'x' }, { type: 'released', from: 'x' }, { type: 'bye', from: 'x' }]) {
      other.postMessage(message)
    }
    await advance()
    expect(a.states).toEqual(['owner'])
    expect(a.released).toBe(0)
  })
})
