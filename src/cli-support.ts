import { SessionManager } from '@mariozechner/pi-coding-agent'
import { join } from 'node:path'
import { sessionsDir } from './app-paths.js'

export interface CliFlags {
  mode?: 'text' | 'json' | 'rpc'
  print?: boolean
  continue?: boolean
  noSession?: boolean
  model?: string
  extensions: string[]
  appendSystemPrompt?: string
  tools?: string[]
  messages: string[]
}

export function parseCliArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { extensions: [], messages: [] }
  const args = argv.slice(2)

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--mode' && i + 1 < args.length) {
      const mode = args[++i]
      if (mode === 'text' || mode === 'json' || mode === 'rpc') flags.mode = mode
    } else if (arg === '--print' || arg === '-p') {
      flags.print = true
    } else if (arg === '--continue' || arg === '-c') {
      flags.continue = true
    } else if (arg === '--no-session') {
      flags.noSession = true
    } else if (arg === '--model' && i + 1 < args.length) {
      flags.model = args[++i]
    } else if (arg === '--extension' && i + 1 < args.length) {
      flags.extensions.push(args[++i])
    } else if (arg === '--append-system-prompt' && i + 1 < args.length) {
      flags.appendSystemPrompt = args[++i]
    } else if (arg === '--tools' && i + 1 < args.length) {
      flags.tools = args[++i].split(',')
    } else if (!arg.startsWith('--') && !arg.startsWith('-')) {
      flags.messages.push(arg)
    }
  }

  return flags
}

export function getProjectSessionsDir(cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return join(sessionsDir, safePath)
}

export function createProjectSessionManager(
  cwd: string,
  options?: { continueRecent?: boolean },
) {
  const projectSessionsDir = getProjectSessionsDir(cwd)
  return options?.continueRecent
    ? SessionManager.continueRecent(cwd, projectSessionsDir)
    : SessionManager.create(cwd, projectSessionsDir)
}
