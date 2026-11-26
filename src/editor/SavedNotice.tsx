import type { ReactNode } from 'react'
import { Logo } from '../ui/Logo.tsx'
import type { UnreadableReason } from './persistence.ts'

// editor を出せないときに、代わりに出す知らせの画面。
// 読めない自動保存が残っているとき（UnreadableNotice）と、別のタブが編集中のとき（ElsewhereNotice）。

function Notice({ kind, title, children }: { kind: string; title: string; children: ReactNode }) {
  return (
    <div className="app" data-mode="editor">
      <header className="app-header">
        <Logo className="app-logo" />
        <span className="app-mode">editor</span>
      </header>
      <main className="editor-notice" data-kind={kind}>
        <div className="editor-notice-card" role="alert">
          <h1>{title}</h1>
          {children}
        </div>
      </main>
    </div>
  )
}

const UNREADABLE: Record<UnreadableReason, { title: string; what: string; how: string }> = {
  older: {
    title: '前の版で保存した編集中の内容があります',
    what: 'このブラウザに、前の版の kadrokreo が自動保存した編集中の内容が残っています。いまの版では読み込めません。',
    how: '内容を残すには、このタブを閉じ、保存したときの版のイメージで editor を開いて「kdr に書き出し」でファイルに保存してください。',
  },
  newer: {
    title: '新しい版で保存した編集中の内容があります',
    what: 'このブラウザに、新しい版の kadrokreo が自動保存した編集中の内容が残っています。この版では読み込めません。',
    how: '内容を残すには、このタブを閉じ、保存したときの版のイメージで editor を開いて「kdr に書き出し」でファイルに保存してください。',
  },
  broken: {
    title: '読み込めない保存データがあります',
    what: 'このブラウザに自動保存された編集中の内容が、壊れているか、この版では読み込めない形になっています。',
    how: '別の版の kadrokreo で保存した内容なら、このタブを閉じ、その版のイメージで editor を開くと読み込めることがあります。',
  },
}

type UnreadableProps = {
  reason: UnreadableReason
  /** 破棄に失敗したときの文言 */
  error: string | null
  onDiscard: () => void
}

/** 読めない自動保存（別の版のもの・壊れたもの）が残っているときの知らせ。破棄を選ぶまで残す */
export function UnreadableNotice({ reason, error, onDiscard }: UnreadableProps) {
  const text = UNREADABLE[reason]
  return (
    <Notice kind={`unreadable-${reason}`} title={text.title}>
      <p>{text.what}</p>
      <p>{text.how}</p>
      <p>要らなければ、破棄して新しいドキュメントから始められます。破棄するまで、残っている内容は消えず、上書きもされません。</p>
      {error !== null && <p className="editor-notice-error">{error}</p>}
      <div className="editor-notice-actions">
        <button type="button" onClick={onDiscard}>
          破棄して新しく始める
        </button>
      </div>
    </Notice>
  )
}

type ElsewhereProps = {
  /** 引き継いでいる途中 */
  taking: boolean
  onTakeOver: () => void
}

/** 別のタブが編集中のときの知らせ。編集できるタブは 1 つだけ */
export function ElsewhereNotice({ taking, onTakeOver }: ElsewhereProps) {
  return (
    <Notice kind="elsewhere" title="別のタブで編集中です">
      <p>
        editor を別のタブ（またはウィンドウ）でも開いています。編集中の内容はブラウザの 1 か所に自動保存するので、上書きし合わないよう、編集できるタブを
        1 つにしています。
      </p>
      <p>「このタブで編集を続ける」を押すと、別のタブの内容を保存してから、このタブで開きます。別のタブでは編集できなくなります。</p>
      <p>別のタブを閉じたあとは、このタブに切り替えると、そのまま続きを編集できます。</p>
      <div className="editor-notice-actions">
        <button type="button" className="primary" disabled={taking} onClick={onTakeOver}>
          {taking ? '引き継いでいます…' : 'このタブで編集を続ける'}
        </button>
      </div>
    </Notice>
  )
}
