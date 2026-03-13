import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'
import { stopAuto } from './auto.js'

type ExitFn = (code?: number) => never | void

export async function exitGracefully(
  ctx: ExtensionContext | undefined,
  pi: ExtensionAPI,
  options?: {
    stopAutoFn?: typeof stopAuto
    exitFn?: ExitFn
  },
): Promise<void> {
  await (options?.stopAutoFn ?? stopAuto)(ctx, pi)
  ;(options?.exitFn ?? process.exit)(0)
}

export function killImmediately(exitFn: ExitFn = process.exit): void {
  exitFn(0)
}
