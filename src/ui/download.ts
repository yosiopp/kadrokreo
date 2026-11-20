/** ファイル名に使えない文字を置き換える */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'Untitled'
}

/** ブラウザのダウンロードとして保存させる */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
