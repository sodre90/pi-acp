import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class StoredPiProcess extends FakePiRpcProcess {
  getMessagesCount = 0

  override async getState(): Promise<any> {
    return { sessionId: 'stored', thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }
  }

  async getMessages(): Promise<any> {
    this.getMessagesCount += 1
    return {
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
      ]
    }
  }

  async getCommands(): Promise<any> {
    return { commands: [] }
  }
}

async function openStored(open: (agent: PiAcpAgent) => Promise<unknown>) {
  const conn = new FakeAgentSideConnection()
  const started: StoredPiProcess[] = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    const proc = new StoredPiProcess()
    started.push(proc)
    return proc
  }
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0

  try {
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = {
      get: (sessionId: string) =>
        sessionId === 'stored' ? { sessionId, cwd: '/tmp/project', sessionFile: '/tmp/project/stored.jsonl' } : null,
      upsert() {}
    }
    const response = await open(agent)
    return {
      response,
      proc: started[0],
      isOpen: (agent as any).sessions.maybeGet('stored') !== undefined,
      replayed: conn.updates
        .map(({ update }) => update.sessionUpdate)
        .filter(kind => kind === 'user_message_chunk' || kind === 'agent_message_chunk')
    }
  } finally {
    PiRpcProcess.spawn = originalSpawn
    ;(globalThis as any).setTimeout = realSetTimeout
  }
}

test('PiAcpAgent advertises session/resume', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const { agentCapabilities } = await agent.initialize({ protocolVersion: 1 } as any)
  assert.deepEqual(agentCapabilities?.sessionCapabilities?.resume, {})
})

test('PiAcpAgent resumes a stored session without sending its history again', async () => {
  const resumed = await openStored(agent => agent.resumeSession({ sessionId: 'stored', cwd: '/tmp/project' }))

  assert.equal(resumed.isOpen, true)
  assert.deepEqual(resumed.replayed, [])
  assert.equal(resumed.proc?.getMessagesCount, 0)
  assert.ok((resumed.response as any).configOptions?.some((option: any) => option.id === 'model'))
})

test('PiAcpAgent still sends the history when it loads a stored session', async () => {
  const loaded = await openStored(agent =>
    agent.loadSession({ sessionId: 'stored', cwd: '/tmp/project', mcpServers: [] })
  )

  assert.equal(loaded.isOpen, true)
  assert.deepEqual(loaded.replayed, ['user_message_chunk', 'agent_message_chunk'])
})

test('PiAcpAgent refuses to resume a session it has no record of', async () => {
  await assert.rejects(
    openStored(agent => agent.resumeSession({ sessionId: 'missing', cwd: '/tmp/project' })),
    { code: -32602, data: 'Unknown sessionId: missing' }
  )
})
