import { Suspense, lazy, useEffect } from 'react'

// MODE はビルド時に定数へ置き換わるので、viewer ビルドには editor のコードが含まれない
const ModeApp = lazy(() =>
  import.meta.env.MODE === 'editor'
    ? import('./editor/EditorApp.tsx')
    : import('./viewer/ViewerApp.tsx'),
)

export default function App() {
  // マウスで押したボタンにフォーカスを残さない。残ると Space や Enter がそのボタンに吸われ、
  // キャンバスのショートカットとして効かなくなる（キーボードで操作した場合は detail が 0）
  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.detail === 0 || !(event.target instanceof Element)) return
      const button = event.target.closest('button')
      if (button && button === document.activeElement) button.blur()
    }
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
  }, [])

  return (
    <Suspense>
      <ModeApp />
    </Suspense>
  )
}
