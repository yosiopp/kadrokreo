import { useLayoutEffect } from 'react'
import type { Asset, AssetId, EmbeddedFont } from '../document/types.ts'
import { syncEmbeddedFonts } from './fonts.ts'

/** ドキュメントの埋め込んだ書体を、描く前（画面に出る前）に登録する。ドキュメントがなければ登録を全部外す */
export function useEmbeddedFonts(fonts: readonly EmbeddedFont[] | undefined, assets: Record<AssetId, Asset> | undefined): void {
  useLayoutEffect(() => {
    syncEmbeddedFonts(fonts ?? [], assets ?? {})
  }, [fonts, assets])
}
