import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class SessionPiProcess extends FakePiRpcProcess {
  constructor(private readonly sessionId: string) {
    super()
  }

  override async getState(): Promise<any> {
    return { sessionId: this.sessionId, thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }
  }

  async getCommands(): Promise<any> {
    return { commands: [] }
  }
}

test('PiAcpAgent: starting or loading a session leaves the other open sessions and their pi processes running', async () => {
  const started: SessionPiProcess[] = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: { sessionPath?: string }) => {
    const proc = new SessionPiProcess(params.sessionPath ? 'stored' : `new-${started.length + 1}`)
    started.push(proc)
    return proc
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

    const first = await agent.newSession({ cwd: '/tmp/project', mcpServers: [] })
    const second = await agent.newSession({ cwd: '/tmp/project', mcpServers: [] })
    await agent.loadSession({ sessionId: 'stored', cwd: '/tmp/project', mcpServers: [] })

    const sessions = (agent as any).sessions
    assert.deepEqual(
      [first.sessionId, second.sessionId, 'stored'].map(id => sessions.maybeGet(id)?.sessionId),
      ['new-1', 'new-2', 'stored']
    )
    assert.deepEqual(
      started.map(proc => proc.disposeCount),
      [0, 0, 0]
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})
