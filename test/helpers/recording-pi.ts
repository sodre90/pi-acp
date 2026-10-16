import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { SESSION_VARIABLE } from '../../src/pi-rpc/session-extension.js'

type Launch = { args: string[]; session?: string }

/** A pi that writes down its arguments and session variable, then answers every command. */
function writeRecordingPi(root: string, launchFile: string): string {
  writeFileSync(
    join(root, 'recording-pi.cjs'),
    [
      "const { writeFileSync } = require('node:fs')",
      "const readline = require('node:readline')",
      `writeFileSync(${JSON.stringify(launchFile)}, JSON.stringify({ args: process.argv.slice(2), session: process.env.${SESSION_VARIABLE} }))`,
      "readline.createInterface({ input: process.stdin }).on('line', line => {",
      '  const command = JSON.parse(line)',
      "  process.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data: {} }) + '\\n')",
      '})'
    ].join('\n')
  )
  const launcher = join(root, process.platform === 'win32' ? 'pi.cmd' : 'pi')
  if (process.platform === 'win32') {
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${join(root, 'recording-pi.cjs')}" %*\r\n`)
  } else {
    writeFileSync(launcher, "#!/usr/bin/env node\nrequire('./recording-pi.cjs')\n")
    chmodSync(launcher, 0o755)
  }
  return launcher
}

/** How `PiRpcProcess.spawn` starts pi with these parameters. */
export async function piLaunch(
  params: Omit<Parameters<typeof PiRpcProcess.spawn>[0], 'cwd' | 'piCommand'>
): Promise<Launch> {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-launch-'))
  const launchFile = join(root, 'launch.json')
  try {
    const proc = await PiRpcProcess.spawn({ ...params, cwd: root, piCommand: writeRecordingPi(root, launchFile) })
    proc.dispose()
    return JSON.parse(readFileSync(launchFile, 'utf8')) as Launch
  } finally {
    await new Promise(resolve => setTimeout(resolve, 50))
    rmSync(root, { recursive: true, force: true })
  }
}
