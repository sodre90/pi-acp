import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getQuietStartup } from '../../src/acp/pi-settings.js'

function quietStartupWith(env: string | undefined, settings: object) {
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-acp-quiet-agent-'))
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-quiet-project-'))
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings))
  const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, quiet: process.env.PI_ACP_QUIET_STARTUP }
  process.env.PI_CODING_AGENT_DIR = agentDir
  if (env === undefined) delete process.env.PI_ACP_QUIET_STARTUP
  else process.env.PI_ACP_QUIET_STARTUP = env

  try {
    return getQuietStartup(cwd)
  } finally {
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous.agentDir
    if (previous.quiet === undefined) delete process.env.PI_ACP_QUIET_STARTUP
    else process.env.PI_ACP_QUIET_STARTUP = previous.quiet
    rmSync(agentDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

test('PI_ACP_QUIET_STARTUP=true quiets the startup info whatever pi settings say', () => {
  assert.equal(quietStartupWith('true', {}), true)
  assert.equal(quietStartupWith('true', { quietStartup: false }), true)
})

test('without PI_ACP_QUIET_STARTUP=true, the quietStartup pi setting decides', () => {
  assert.equal(quietStartupWith(undefined, {}), false)
  assert.equal(quietStartupWith('false', { quietStartup: true }), true)
  assert.equal(quietStartupWith('1', { quietStartup: false }), false)
})
