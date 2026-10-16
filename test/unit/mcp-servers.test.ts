import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import type { McpServer } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import sessionExtension, { SESSION_VARIABLE, type PiMcpServerConfig } from '../../src/pi-rpc/session-extension.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import { piLaunch } from '../helpers/recording-pi.js'

const httpServer: McpServer = {
  type: 'http',
  name: 'docs',
  url: 'http://127.0.0.1:4000/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer secret' }]
}
const stdioServer: McpServer = {
  name: 'files',
  command: '/usr/local/bin/files-mcp',
  args: ['--root', '/tmp'],
  env: [{ name: 'FILES_TOKEN', value: 'secret' }]
}
const sseServer: McpServer = { type: 'sse', name: 'events', url: 'http://127.0.0.1:4001/sse', headers: [] }

const piConfigs: Record<string, PiMcpServerConfig> = {
  docs: { url: 'http://127.0.0.1:4000/mcp', headers: { Authorization: 'Bearer secret' }, exposure: 'direct' },
  files: {
    command: '/usr/local/bin/files-mcp',
    args: ['--root', '/tmp'],
    env: { FILES_TOKEN: 'secret' },
    exposure: 'direct'
  }
}

test("PiRpcProcess starts pi with the session extension, which gets the stdio and HTTP servers in pi's own shape", async () => {
  const { args, session } = await piLaunch({ mcpServers: [httpServer, stdioServer, sseServer] })

  const extension = args[args.indexOf('--extension') + 1]
  assert.ok(extension && existsSync(extension), `expected an existing extension file, got ${extension}`)
  assert.match(extension, /session-extension\.(js|ts)$/)
  assert.deepEqual(JSON.parse(session ?? '{}'), { mcpServers: piConfigs, appendSystemPrompt: '' })
})

test('PiRpcProcess starts pi as before when the session has no servers pi can use', async () => {
  for (const mcpServers of [[], [sseServer]]) {
    const { args, session } = await piLaunch({ mcpServers })
    assert.deepEqual(args, ['--mode', 'rpc', '--no-themes'])
    assert.equal(session, undefined)
  }
})

function registrations(register: (name: string) => void = () => {}) {
  const registered: Array<{ name: string; config: PiMcpServerConfig }> = []
  sessionExtension({
    registerMcpServer(name, config) {
      register(name)
      registered.push({ name, config })
    },
    on() {}
  })
  return registered
}

test('session extension registers the servers, keeps them across a reload, and leaves them out of the environment', () => {
  delete (globalThis as any)[Symbol.for('pi-acp.session')]
  process.env[SESSION_VARIABLE] = JSON.stringify({ mcpServers: piConfigs })

  const expected = Object.entries(piConfigs).map(([name, config]) => ({ name, config }))
  assert.deepEqual(registrations(), expected)
  assert.equal(process.env[SESSION_VARIABLE], undefined)
  assert.deepEqual(registrations(), expected)
})

test('session extension still registers the other servers when pi refuses one', () => {
  delete (globalThis as any)[Symbol.for('pi-acp.session')]
  process.env[SESSION_VARIABLE] = JSON.stringify({ mcpServers: piConfigs })
  const originalError = console.error
  const errors: unknown[] = []
  console.error = (...args: unknown[]) => errors.push(args.join(' '))

  try {
    const registered = registrations(name => {
      if (name === 'docs') throw new Error('invalid server name')
    })
    assert.deepEqual(
      registered.map(({ name }) => name),
      ['files']
    )
    assert.deepEqual(errors, ['pi-acp: could not add MCP server docs: invalid server name'])
  } finally {
    console.error = originalError
  }
})

class SessionPiProcess extends FakePiRpcProcess {
  override async getState(): Promise<any> {
    return { sessionId: 'started', thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }
  }

  async getCommands(): Promise<any> {
    return { commands: [] }
  }
}

test("PiAcpAgent advertises HTTP MCP servers and hands the client's servers to the pi of a new or loaded session", async () => {
  const spawned: Array<{ sessionPath?: string; mcpServers?: McpServer[] }> = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: { sessionPath?: string; mcpServers?: McpServer[] }) => {
    spawned.push(params)
    return new SessionPiProcess()
  }
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0

  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    ;(agent as any).store = {
      get: (sessionId: string) =>
        sessionId === 'stored' ? { sessionId, cwd: '/tmp/project', sessionFile: '/tmp/project/stored.jsonl' } : null,
      upsert() {}
    }

    const { agentCapabilities } = await agent.initialize({ protocolVersion: 1 } as any)
    assert.deepEqual(agentCapabilities?.mcpCapabilities, { http: true, sse: false })

    await agent.newSession({ cwd: '/tmp/project', mcpServers: [httpServer] })
    await agent.loadSession({ sessionId: 'stored', cwd: '/tmp/project', mcpServers: [stdioServer] })
    assert.deepEqual(
      spawned.map(({ sessionPath, mcpServers }) => ({ sessionPath, mcpServers })),
      [
        { sessionPath: undefined, mcpServers: [httpServer] },
        { sessionPath: '/tmp/project/stored.jsonl', mcpServers: [stdioServer] }
      ]
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})
