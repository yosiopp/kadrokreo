import { useEffect, useRef, useState } from 'react'
import type { DesignDocument, ModeId, Variable, VariableCollection, VariableValue } from '../../document/types.ts'
import { isAlias, resolveVariable, variableIndex } from '../../document/variables.ts'
import { TrashIcon } from '../icons.tsx'
import {
  VariableError,
  addCollection,
  addMode,
  addVariable,
  removeCollection,
  removeMode,
  removeVariable,
  renameCollection,
  renameMode,
  renameVariable,
  setVariableValue,
} from '../operations/variables.ts'
import type { EditorStore } from '../store.ts'

type Props = {
  store: EditorStore
  document: DesignDocument
}

/**
 * ドキュメントの変数（何も選んでいないときのプロパティパネル）。コレクションごとに、行が変数・列がモードの表。
 * 色の変数を足し、名前とモードごとの値（色か、別の変数の別名）を変える。塗り・線・影の色の欄から「変数」でつなぐ
 */
export function VariablesSection({ store, document }: Props) {
  const [error, setError] = useState<string | null>(null)

  /** 変数の操作。名前の重なりなどは、節の中に知らせる */
  function run(recipe: (doc: DesignDocument) => DesignDocument) {
    try {
      store.applyDocument(recipe)
      setError(null)
    } catch (caught) {
      if (caught instanceof VariableError) setError(caught.message)
      else throw caught
    }
  }

  /** 重ならない名前（base、base 2、…） */
  function freshName(taken: readonly string[], base: string): string {
    if (!taken.includes(base)) return base
    let n = 2
    while (taken.includes(`${base} ${n}`)) n++
    return `${base} ${n}`
  }

  function addColorVariable(collection: VariableCollection | undefined) {
    run((doc) => {
      let current = doc
      let id = collection?.id
      if (id === undefined) {
        const added = addCollection(current, 'Variables')
        current = added.document
        id = added.id
      }
      const target = current.collections.find((item) => item.id === id)!
      return addVariable(current, id, freshName(target.variables.map((variable) => variable.name), 'color/new'), 'color', '#5b4cf5').document
    })
  }

  return (
    <>
      <h2 className="panel-title">変数</h2>
      {document.collections.length === 0 && (
        <p className="panel-hint">色に名前を付けて変数にすると、塗り・線・影の色からつなげます。変数の値を変えると、つないだ色が全部変わります。</p>
      )}
      {document.collections.map((collection) => (
        <CollectionTable key={collection.id} document={document} collection={collection} run={run} onAddVariable={() => addColorVariable(collection)} freshName={freshName} />
      ))}
      {error && (
        <p className="section-note" role="alert">
          {error}
        </p>
      )}
      <div className="font-actions">
        {document.collections.length === 0 ? (
          <button type="button" onClick={() => addColorVariable(undefined)}>
            色の変数を追加
          </button>
        ) : (
          <button
            type="button"
            onClick={() => run((doc) => addCollection(doc, freshName(doc.collections.map((item) => item.name), 'Collection')).document)}
          >
            コレクションを追加
          </button>
        )}
      </div>
    </>
  )
}

type TableProps = {
  document: DesignDocument
  collection: VariableCollection
  run: (recipe: (doc: DesignDocument) => DesignDocument) => void
  onAddVariable: () => void
  freshName: (taken: readonly string[], base: string) => string
}

function CollectionTable({ document, collection, run, onAddVariable, freshName }: TableProps) {
  return (
    <div className="variable-collection">
      <div className="variable-collection-head">
        <NameInput label="コレクションの名前" value={collection.name} onCommit={(name) => run((doc) => renameCollection(doc, collection.id, name))} />
        <button
          type="button"
          className="icon-button"
          title={`${collection.name} を中の変数ごと消す（つないだ色は今の値のまま残す）`}
          aria-label={`${collection.name} を消す`}
          onClick={() => run((doc) => removeCollection(doc, collection.id))}
        >
          <TrashIcon />
        </button>
      </div>
      <table className="variable-table" aria-label={`${collection.name} の変数`}>
        <thead>
          <tr>
            <th scope="col">名前</th>
            {collection.modes.map((mode) => (
              <th key={mode.id} scope="col">
                <div className="variable-mode">
                  <NameInput label="モードの名前" value={mode.name} onCommit={(name) => run((doc) => renameMode(doc, collection.id, mode.id, name))} />
                  {collection.modes.length > 1 && (
                    <button
                      type="button"
                      className="variable-mode-remove"
                      title={`モード ${mode.name} を消す`}
                      aria-label={`モード ${mode.name} を消す`}
                      onClick={() => run((doc) => removeMode(doc, collection.id, mode.id))}
                    >
                      ×
                    </button>
                  )}
                </div>
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {collection.variables.map((variable) => (
            <tr key={variable.id}>
              <th scope="row">
                <NameInput label="変数の名前" value={variable.name} onCommit={(name) => run((doc) => renameVariable(doc, variable.id, name))} />
              </th>
              {collection.modes.map((mode) => (
                <td key={mode.id}>
                  <ValueCell document={document} collection={collection} variable={variable} mode={mode.id} run={run} />
                </td>
              ))}
              <td>
                <button
                  type="button"
                  className="icon-button"
                  title={`${variable.name} を消す（つないだ色は今の値のまま残す）`}
                  aria-label={`${variable.name} を消す`}
                  onClick={() => run((doc) => removeVariable(doc, variable.id))}
                >
                  <TrashIcon />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="font-actions">
        <button type="button" onClick={onAddVariable}>
          色の変数を追加
        </button>
        <button type="button" onClick={() => run((doc) => addMode(doc, collection.id, freshName(collection.modes.map((mode) => mode.name), 'Mode')).document)}>
          モードを追加
        </button>
      </div>
    </div>
  )
}

/** 名前の欄。Enter かフォーカスを外したときに確定し、Escape で戻す */
function NameInput({ label, value, onCommit }: { label: string; value: string; onCommit: (name: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      className="variable-name"
      aria-label={label}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => setDraft(value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft)
        setDraft(null)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setDraft(value)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

/** 別名ではなく値を持つ（別名の選択で選ぶ値。変数の id には空白が入らないので、ぶつからない） */
const OWN_VALUE = ' '

type CellProps = {
  document: DesignDocument
  collection: VariableCollection
  variable: Variable
  mode: ModeId
  run: (recipe: (doc: DesignDocument) => DesignDocument) => void
}

/** 1 つのモードの値。色の変数は色の欄、ほかの種類は文字の欄。どの種類も、同じ種類の別の変数の別名にできる */
function ValueCell({ document, collection, variable, mode, run }: CellProps) {
  const value = variable.values[mode]
  const index = variableIndex(document.collections)
  // 別名なら、たどった先の値を見せる（同じコレクションならこのモード、ほかのコレクションなら最初のモードで）
  const resolved = resolveVariable(index, variable.id, (other) => (other.id === collection.id ? mode : other.modes[0].id))
  const set = (next: VariableValue) => run((doc) => setVariableValue(doc, variable.id, next, mode))
  const candidates = document.collections.flatMap((other) =>
    other.variables.filter((item) => item.type === variable.type && item.id !== variable.id).map((item) => ({ id: item.id, name: item.name })),
  )
  return (
    <div className="variable-value">
      {variable.type === 'color' ? (
        <ColorInput
          label={`${variable.name} の ${collection.modes.find((item) => item.id === mode)?.name} の色`}
          value={typeof resolved === 'string' ? resolved : '#000000'}
          disabled={isAlias(value)}
          onCommit={set}
        />
      ) : (
        <PlainValue variable={variable} value={isAlias(value) ? String(resolved ?? '') : String(value)} disabled={isAlias(value)} onCommit={set} />
      )}
      {candidates.length > 0 && (
        <select
          aria-label={`${variable.name} の別名`}
          value={isAlias(value) ? value.alias : OWN_VALUE}
          onChange={(event) => {
            const target = event.target.value
            set(target === OWN_VALUE ? (resolved ?? variable.values[collection.modes[0].id]) : { alias: target })
            event.target.blur()
          }}
        >
          <option value={OWN_VALUE}>値</option>
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              → {candidate.name}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

/** 色でない変数の値の欄（数値・文字・真偽） */
function PlainValue({ variable, value, disabled, onCommit }: { variable: Variable; value: string; disabled: boolean; onCommit: (value: VariableValue) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (text: string) => {
    if (variable.type === 'number') {
      const number = Number(text)
      if (text.trim() !== '' && Number.isFinite(number)) onCommit(number)
    } else if (variable.type === 'boolean') onCommit(text === 'true')
    else onCommit(text)
  }
  return (
    <input
      className="variable-name"
      aria-label={`${variable.name} の値`}
      value={draft ?? value}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) commit(draft)
        setDraft(null)
      }}
      onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
    />
  )
}

/** 色の欄。選んでいる最中は欄の中だけで変え、選び終えたとき（素の change イベント）に確定する（選んでいる最中の値を履歴に積まない） */
function ColorInput({ label, value, disabled, onCommit }: { label: string; value: string; disabled: boolean; onCommit: (color: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const latest = useRef({ value, onCommit })
  useEffect(() => {
    latest.current = { value, onCommit }
  })
  useEffect(() => {
    const input = inputRef.current
    const commit = () => {
      if (input && input.value !== latest.current.value) latest.current.onCommit(input.value)
      setDraft(null)
    }
    input?.addEventListener('change', commit)
    return () => input?.removeEventListener('change', commit)
  }, [])
  return (
    <input ref={inputRef} type="color" aria-label={label} value={draft ?? value} disabled={disabled} onChange={(event) => setDraft(event.target.value)} />
  )
}
