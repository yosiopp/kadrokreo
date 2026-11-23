import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Point } from '../document/geometry.ts'

// キャンバスとレイヤーパネルの右クリックメニュー。中身（どの操作を出すか）は EditorCanvas が決める

export type MenuItem =
  | {
      label: string
      /** 右に薄く出すショートカットの表記 */
      shortcut?: string
      disabled?: boolean
      onSelect?: () => void
      /** 入れ子のメニュー（別のページへ移す、など） */
      submenu?: MenuItem[]
    }
  | 'separator'

type Props = {
  /** 出す位置（ウィンドウの左上を原点とする画面座標）。はみ出す向きには反対側へ出す */
  at: Point
  items: MenuItem[]
  onClose: () => void
}

export function ContextMenu({ at, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(at)

  // 大きさが分かってから、ウィンドウの中に収まる位置へ寄せる
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const { offsetWidth: width, offsetHeight: height } = menu
    const { innerWidth, innerHeight } = window
    setPosition({
      x: at.x + width > innerWidth ? Math.max(0, at.x - width) : at.x,
      y: at.y + height > innerHeight ? Math.max(0, innerHeight - height) : at.y,
    })
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [at])

  // メニューの外を押す・Esc・ウィンドウの大きさが変わる、で閉じる。
  // Esc はキャンバスのショートカット（選択の解除）より先に受けて、そちらへは流さない
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopImmediatePropagation()
      event.preventDefault()
      onClose()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: position.x, top: position.y }}
      // キャンバスのポインタ操作やホイールに流さない
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={onClose}
      onContextMenu={(event) => event.preventDefault()}
    >
      <MenuList items={items} label="キャンバスのメニュー" onClose={onClose} />
    </div>
  )
}

type ListProps = {
  items: MenuItem[]
  label: string
  onClose: () => void
  /** 入れ子のとき、左の矢印で親の項目へ戻る */
  onBack?: () => void
}

function MenuList({ items, label, onClose, onBack }: ListProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  // 上下の矢印で項目を移り、右の矢印で入れ子を開き、左の矢印で閉じる
  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > li > button:not(:disabled)')]
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (current === -1) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      buttons[(current + step + buttons.length) % buttons.length]?.focus()
    } else if (event.key === 'ArrowLeft' && onBack) onBack()
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <ul className="context-menu-list" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, index) => {
        if (item === 'separator') return <li key={`separator-${index}`} className="context-menu-separator" role="separator" />
        const open = openIndex === index && item.submenu !== undefined
        return (
          <li
            key={item.label}
            className="context-menu-entry"
            onPointerEnter={() => setOpenIndex(item.submenu && !item.disabled ? index : null)}
          >
            <button
              type="button"
              role="menuitem"
              className="context-menu-item"
              disabled={item.disabled}
              aria-haspopup={item.submenu ? 'menu' : undefined}
              aria-expanded={item.submenu ? open : undefined}
              onClick={() => {
                if (item.submenu) {
                  setOpenIndex(index)
                  return
                }
                onClose()
                item.onSelect?.()
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' && item.submenu) {
                  setOpenIndex(index)
                  // 開いた入れ子の先頭へ移る（描き終えてから）
                  const entry = event.currentTarget.parentElement!
                  requestAnimationFrame(() =>
                    entry.querySelector<HTMLButtonElement>('.context-menu-list button:not(:disabled)')?.focus(),
                  )
                  event.preventDefault()
                }
              }}
            >
              <span className="context-menu-label">{item.label}</span>
              {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
              {item.submenu && <span className="context-menu-shortcut">›</span>}
            </button>
            {open && (
              <div className="context-menu context-menu-nested">
                <MenuList
                  items={item.submenu!}
                  label={item.label}
                  onClose={onClose}
                  onBack={() => {
                    setOpenIndex(null)
                    document.activeElement?.closest('.context-menu-entry')?.parentElement
                      ?.closest('.context-menu-entry')?.querySelector<HTMLButtonElement>(':scope > button')?.focus()
                  }}
                />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
