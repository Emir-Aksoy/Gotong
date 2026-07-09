/**
 * Minimal ambient types for `qrcode-terminal` (the package ships none).
 * Only the callback form `wechat-login` uses is declared — capturing the
 * rendered string lets us print to stderr instead of its default stdout.
 */
declare module 'qrcode-terminal' {
  interface QrcodeTerminal {
    generate(text: string, opts: { small?: boolean }, cb: (rendered: string) => void): void
    generate(text: string, opts?: { small?: boolean }): void
  }
  const qrcode: QrcodeTerminal
  export default qrcode
}
