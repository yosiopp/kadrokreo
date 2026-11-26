// editor を複数のタブ（ウィンドウ）で開いたとき、編集する（自動保存する）タブを 1 つにするための知らせ合い。
// 自動保存の保存先は 1 つなので、2 つのタブがそれぞれ編集すると、後から保存したほうがもう片方の作業を消してしまう。
// あとから開いたタブは編集せず、別のタブが編集中であることを知らせる。利用者が「このタブで編集を続ける」を選ぶと、
// 編集中のタブに保存を済ませて手放してもらい、こちらが保存先から読み直して続ける。
//
// BroadcastChannel で知らせ合う（navigator.locks は安全なコンテキストでしか使えず、http の LAN アドレスで開くと無い）。
// 知らせは届かないことがある（相手のタブがブラウザに止められている、返事が待ち時間に間に合わない）。
// 上書きしないことの保証は保存の側（persistence.ts の印）が持ち、ここは開いた時点で早めに知らせるためのもの。

/** 編集中のタブからの返事を待つ時間（ms）。返事が無ければ、自分が編集するタブになる */
export const CHECK_WAIT = 200
/** 編集中のタブが保存を済ませて手放すのを待つ時間（ms）。返事が無ければ、相手はもう居ないものとして引き継ぐ */
export const RELEASE_WAIT = 2000

/** 知らせ合いに使うチャンネルの名前 */
const CHANNEL_NAME = 'kadrokreo-editor'

/**
 * タブの立場。
 * checking: 開いた直後で、ほかに編集中のタブが無いかを確かめている。owner: 編集する（自動保存する）タブ。
 * elsewhere: 別のタブが編集中。taking: 別のタブから編集を引き継いでいる途中
 */
export type TabState = 'checking' | 'owner' | 'elsewhere' | 'taking'

/** BroadcastChannel のうち、使う部分 */
export type TabChannel = {
  postMessage(message: unknown): void
  onmessage: ((event: { data: unknown }) => void) | null
  close(): void
}

type TabMessage =
  /** 開いた（または確かめ直す）タブから。since は確かめ始めた時刻 */
  | { type: 'hello'; from: string; since: number }
  /** 編集中のタブ（owning が true）か、先に確かめ始めたタブ（false）から hello への返事 */
  | { type: 'present'; from: string; since: number; owning: boolean }
  /** 編集を引き継ぎたいタブから、編集中のタブへ */
  | { type: 'takeover'; from: string }
  /** 編集中だったタブから、保存を済ませて手放したことを引き継ぐタブ to へ */
  | { type: 'released'; from: string; to: string }

export type EditorTabOptions = {
  /** 知らせ合いのチャンネル。使えない環境では null（ほかのタブを確かめられないので、編集するタブとして始める） */
  channel: TabChannel | null
  /**
   * 編集中のタブが、別のタブに編集を渡すときに呼ぶ。編集中の内容を保存しきれたら true を返す。
   * false なら、このタブは保存していない内容を持ったまま知らせ合いから外れる（内容を残すのは呼び出し側）
   */
  release: () => Promise<boolean>
  /** 立場が変わったときに呼ぶ */
  onChange: (state: TabState) => void
  /** タブを区別する id（テスト用。省けば乱数） */
  id?: string
  /** 今の時刻（テスト用） */
  now?: () => number
}

export type EditorTab = {
  /** 確かめ始める。CHECK_WAIT のあいだに編集中のタブから返事が無ければ owner になる */
  start(): void
  state(): TabState
  /** 別のタブが編集中のとき、まだ居るかを確かめ直す（居なくなっていれば owner になる）。タブを表に出したときに呼ぶ */
  recheck(): void
  /** 別のタブが編集中のとき、編集を引き継ぐ。相手が保存を済ませて手放す（か、返事が無いまま RELEASE_WAIT 経つ）と owner になる */
  takeOver(): void
  /** 知らせ合いをやめる（返事もしなくなる） */
  close(): void
}

/** 外から見える立場に、確かめ直している途中・手放している途中・やめた後を足したもの */
type Phase = TabState | 'rechecking' | 'releasing' | 'closed'

/** この環境の知らせ合いのチャンネル。BroadcastChannel が無ければ null */
export function openTabChannel(): TabChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  const broadcast = new BroadcastChannel(CHANNEL_NAME)
  const channel: TabChannel = {
    postMessage: (message) => broadcast.postMessage(message),
    onmessage: null,
    close: () => broadcast.close(),
  }
  broadcast.onmessage = (event) => channel.onmessage?.(event)
  return channel
}

function parseMessage(data: unknown): TabMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const message = data as Record<string, unknown>
  if (typeof message.from !== 'string') return null
  switch (message.type) {
    case 'hello':
      return typeof message.since === 'number' ? (message as TabMessage) : null
    case 'present':
      return typeof message.since === 'number' && typeof message.owning === 'boolean' ? (message as TabMessage) : null
    case 'takeover':
      return message as TabMessage
    case 'released':
      return typeof message.to === 'string' ? (message as TabMessage) : null
    default:
      return null
  }
}

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function createEditorTab(options: EditorTabOptions): EditorTab {
  const { channel, release, onChange } = options
  const id = options.id ?? randomId()
  const now = options.now ?? Date.now
  let phase: Phase = 'checking'
  /** 確かめ始めた（引き継ぎ始めた）時刻。同時に開いたタブのうち、早いほうが編集するタブになる */
  let since = now()
  let timer: ReturnType<typeof setTimeout> | undefined

  const visible = (value: Phase): TabState | null => {
    if (value === 'closed') return null
    if (value === 'rechecking') return 'elsewhere'
    return value === 'releasing' ? 'owner' : value
  }

  function enter(next: Phase) {
    clearTimeout(timer)
    timer = undefined
    const before = visible(phase)
    phase = next
    const after = visible(next)
    if (after !== null && after !== before) onChange(after)
  }

  function post(message: TabMessage) {
    if (phase !== 'closed') channel?.postMessage(message)
  }

  /** 相手のほうが先に確かめ始めたか（同じ時刻なら id の小さいほう） */
  const earlier = (other: { from: string; since: number }) => other.since < since || (other.since === since && other.from < id)

  /** 編集中のタブが居るかを確かめる。返事が無ければ owner になる */
  function check(next: 'checking' | 'rechecking') {
    since = now()
    enter(next)
    post({ type: 'hello', from: id, since })
    timer = setTimeout(() => enter('owner'), CHECK_WAIT)
  }

  /** 編集を手放す。to は引き継ぐタブ（居なければ null） */
  function giveUp(to: string | null) {
    enter('releasing')
    const done = (flushed: boolean) => {
      // 待っている間にやめていたら（保存先をほかのタブが書いていた、など）何もしない
      if (phase !== 'releasing') return
      if (to !== null) post({ type: 'released', from: id, to })
      if (flushed) enter('elsewhere')
      else close()
    }
    release().then(done, () => done(false))
  }

  function receive(data: unknown) {
    const message = parseMessage(data)
    if (message === null || message.from === id || phase === 'closed') return
    const checking = phase === 'checking' || phase === 'rechecking'
    switch (message.type) {
      case 'hello':
        // 確かめている途中どうしなら、先に始めたほうが残る。引き継いでいる途中のタブも、じきに編集するタブになるので返事をする
        if (checking && earlier(message)) enter('elsewhere')
        else if (phase !== 'elsewhere') post({ type: 'present', from: id, since, owning: phase === 'owner' || phase === 'releasing' })
        break
      case 'present':
        if (checking) enter('elsewhere')
        // 返事が待ち時間に間に合わず、編集するタブが 2 つになっていた。あとから編集するタブになったほうが手放す
        else if (phase === 'owner' && message.owning && earlier(message)) giveUp(null)
        break
      case 'takeover':
        if (phase === 'owner') giveUp(message.from)
        else if (checking) enter('elsewhere')
        // 2 つのタブが同時に引き継ごうとしたら、id の小さいほうに譲る
        else if (phase === 'taking' && message.from < id) enter('elsewhere')
        break
      case 'released':
        if (phase === 'taking' && message.to === id) enter('owner')
        break
    }
  }

  function close() {
    if (phase === 'closed') return
    enter('closed')
    if (channel) {
      channel.onmessage = null
      channel.close()
    }
  }

  return {
    start() {
      if (phase !== 'checking') return
      if (channel === null) return enter('owner')
      channel.onmessage = (event) => receive(event.data)
      check('checking')
    },
    state: () => visible(phase) ?? 'elsewhere',
    recheck() {
      if (phase === 'elsewhere') check('rechecking')
    },
    takeOver() {
      if (phase !== 'elsewhere' && phase !== 'rechecking') return
      since = now()
      enter('taking')
      post({ type: 'takeover', from: id })
      timer = setTimeout(() => enter('owner'), RELEASE_WAIT)
    },
    close,
  }
}
