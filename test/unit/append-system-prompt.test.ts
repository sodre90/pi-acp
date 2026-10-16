import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import sessionExtension, { SESSION_VARIABLE } from '../../src/pi-rpc/session-extension.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'
import { piLaunch } from '../helpers/recording-pi.js'

const CLIENT_INSTRUCTIONS = 'Render diagrams on the canvas.'

test('PiRpcProcess starts pi with the session extension when the client adds to the system prompt', async () => {
  const { args, session } = await piLaunch({ appendSystemPrompt: CLIENT_INSTRUCTIONS })

  assert.ok(args.includes('--extension'))
  assert.deepEqual(JSON.parse(session ?? '{}'), { mcpServers: {}, appendSystemPrompt: CLIENT_INSTRUCTIONS })
})

type StartHandler = (event: { systemPromptOptions: { appendSystemPrompt?: string } }) => void

function startHandlers(appendSystemPrompt: string): StartHandler[] {
  delete (globalThis as any)[Symbol.for('pi-acp.session')]
  process.env[SESSION_VARIABLE] = JSON.stringify({ mcpServers: {}, appendSystemPrompt })
  const handlers: StartHandler[] = []
  sessionExtension({
    registerMcpServer() {},
    on(_event, handler) {
      handlers.push(handler)
    }
  })
  return handlers
}

function appendedOnRun(handler: StartHandler, appendSystemPrompt: string) {
  const event = { systemPromptOptions: { appendSystemPrompt } }
  handler(event)
  return event.systemPromptOptions.appendSystemPrompt
}

test("session extension adds the client's text after what APPEND_SYSTEM.md appends, once on every run", () => {
  const [handler] = startHandlers(CLIENT_INSTRUCTIONS)
  assert.ok(handler)

  assert.equal(appendedOnRun(handler, 'From APPEND_SYSTEM.md'), `From APPEND_SYSTEM.md\n\n${CLIENT_INSTRUCTIONS}`)
  assert.equal(appendedOnRun(handler, 'From APPEND_SYSTEM.md'), `From APPEND_SYSTEM.md\n\n${CLIENT_INSTRUCTIONS}`)
  assert.equal(appendedOnRun(handler, ''), CLIENT_INSTRUCTIONS)
})

test('session extension leaves the system prompt alone when the client adds nothing', () => {
  assert.deepEqual(startHandlers(''), [])
})

class SessionPiProcess extends FakePiRpcProcess {
  override async getState(): Promise<any> {
    return { sessionId: 'started', thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }
  }

  async getCommands(): Promise<any> {
    return { commands: [] }
  }
}

test('PiAcpAgent hands _meta.systemPrompt.append to the pi of a new or loaded session, and nothing else from _meta', async () => {
  const spawned: Array<{ appendSystemPrompt?: string }> = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: { appendSystemPrompt?: string }) => {
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

    await agent.newSession({
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { systemPrompt: { append: CLIENT_INSTRUCTIONS } }
    })
    await agent.loadSession({
      sessionId: 'stored',
      cwd: '/tmp/project',
      mcpServers: [],
      _meta: { systemPrompt: { append: CLIENT_INSTRUCTIONS } }
    })
    await agent.newSession({ cwd: '/tmp/project', mcpServers: [], _meta: { systemPrompt: 'Replace the whole prompt' } })
    await agent.newSession({ cwd: '/tmp/project', mcpServers: [] })

    assert.deepEqual(
      spawned.map(({ appendSystemPrompt }) => appendSystemPrompt),
      [CLIENT_INSTRUCTIONS, CLIENT_INSTRUCTIONS, '', '']
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})
