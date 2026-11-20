/** テキストをクリップボードへ入れる。入れられたら true */
export async function copyText(text: string): Promise<boolean> {
  // Clipboard API は https か localhost でしか使えない。http で配信しているときは、昔ながらの方法で入れる
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 許可されなかったときも、下の方法を試す
    }
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}
