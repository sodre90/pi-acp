import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { forkCommandAt, forkPointOf, type PiSessionEntry } from '../../src/acp/session-fork.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const message = (id: string, parentId: string | null, role: string, timestamp: number): PiSessionEntry => ({
  type: 'message',
  id,
  parentId,
  message: { role, timestamp }
})

// An earlier branch (b2, b3) left in the file after the user went back to a1 and asked again.
const entries: PiSessionEntry[] = [
  { type: 'model_change', id: 'm0', parentId: null },
  message('u1', 'm0', 'user', 100),
  message('a1', 'u1', 'assistant', 101),
  message('b2', 'a1', 'user', 200),
  message('b3', 'b2', 'assistant', 201),
  { type: 'thinking_level_change', id: 't2', parentId: 'a1' },
  message('u2', 't2', 'user', 300),
  message('a2', 'u2', 'assistant', 301),
  message('r2', 'a2', 'toolResult', 302),
  message('a3', 'r2', 'assistant', 303)
]

test('a fork at an agent message keeps the rest of its turn: it goes before the next user message on the branch', () => {
  assert.deepEqual(forkCommandAt(entries, 'a3', '101'), { type: 'fork', entryId: 'u2' })
})

test('a fork at the last agent message copies the whole session', () => {
  assert.deepEqual(forkCommandAt(entries, 'a3', '303'), { type: 'clone' })
  assert.deepEqual(forkCommandAt(entries, 'a3', '301'), { type: 'clone' })
})

test('a fork point only on an earlier branch, or nowhere, is not found', () => {
  assert.equal(forkCommandAt(entries, 'a3', '201'), null)
  assert.equal(forkCommandAt(entries, 'a3', '999'), null)
})

test('the fork point is read where claude-agent-acp reads it', () => {
  assert.equal(forkPointOf({ jetbrains: { air: { fork: { version: 1, messageId: '101' } } } }), '101')
  assert.equal(forkPointOf({ jetbrains: { air: { fork: { version: 1 } } } }), undefined)
  assert.equal(forkPointOf(undefined), undefined)
})

test('initialize advertises session/fork', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const response = await agent.initialize({ protocolVersion: 1 } as any)
  assert.deepEqual(response.agentCapabilities?.sessionCapabilities?.fork, {})
})

function fakeForkingPi() {
  const pi = {
    forks: [] as unknown[],
    disposed: false,
    async getEntries() {
      return { entries, leafId: 'a3' }
    },
    async fork(command: unknown) {
      pi.forks.push(command)
    },
    async getState() {
      return { sessionId: 'forked', sessionFile: '/tmp/project/forked.jsonl' }
    },
    dispose() {
      pi.disposed = true
    }
  }
  return pi
}

async function withSpawnedPi<T>(pi: object, run: (spawns: any[]) => Promise<T>): Promise<T> {
  const spawns: any[] = []
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawns.push(params)
    return pi
  }
  try {
    return await run(spawns)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
}

function agentWithStoredSession() {
  const upserts: unknown[] = []
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).store = {
    get: (sessionId: string) =>
      sessionId === 'source' ? { sessionId, cwd: '/tmp/project', sessionFile: '/tmp/project/source.jsonl' } : null,
    upsert: (entry: unknown) => upserts.push(entry)
  }
  return { agent, upserts }
}

const forkRequest = (messageId?: string) => ({
  sessionId: 'source',
  cwd: '/tmp/project',
  ...(messageId && { _meta: { jetbrains: { air: { fork: { version: 1, messageId } } } } })
})

test('session/fork makes the new session with a pi of its own, records it, and lets that pi go', async () => {
  const pi = fakeForkingPi()
  const { agent, upserts } = agentWithStoredSession()

  await withSpawnedPi(pi, async spawns => {
    const response = await agent.unstable_forkSession(forkRequest('101') as any)

    assert.deepEqual(response, { sessionId: 'forked' })
    assert.equal(spawns[0].sessionPath, '/tmp/project/source.jsonl')
  })
  assert.deepEqual(pi.forks, [{ type: 'fork', entryId: 'u2' }])
  assert.deepEqual(upserts, [{ sessionId: 'forked', cwd: '/tmp/project', sessionFile: '/tmp/project/forked.jsonl' }])
  assert.equal(pi.disposed, true)
})

test('session/fork without a point copies the whole session', async () => {
  const pi = fakeForkingPi()
  await withSpawnedPi(pi, () => agentWithStoredSession().agent.unstable_forkSession(forkRequest() as any))
  assert.deepEqual(pi.forks, [{ type: 'clone' }])
})

test('session/fork at a message the session lacks is refused, and records nothing', async () => {
  const pi = fakeForkingPi()
  const { agent, upserts } = agentWithStoredSession()
  await withSpawnedPi(pi, () =>
    assert.rejects(agent.unstable_forkSession(forkRequest('999') as any), (error: any) =>
      /no agent message 999/.test(String(error.data))
    )
  )
  assert.deepEqual(pi.forks, [])
  assert.deepEqual(upserts, [])
  assert.equal(pi.disposed, true)
})

test('an agent message streams and replays with the same messageId', async () => {
  const reply = { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], timestamp: 1_700_000_000_123 }

  const liveConn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  new PiAcpSession({
    sessionId: 's1',
    cwd: '/tmp/project',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(liveConn),
    fileCommands: []
  })
  proc.emit({ type: 'message_start', message: reply })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } })
  await new Promise(resolve => setImmediate(resolve))

  const replayConn = new FakeAgentSideConnection()
  const replaying = {
    onEvent: () => () => {},
    getMessages: async () => ({ messages: [reply] }),
    getAvailableThinkingLevels: async () => ['medium'],
    getAvailableModels: async () => ({ models: [] }),
    getCommands: async () => ({ commands: [] }),
    getState: async () => ({ thinkingLevel: 'medium' })
  }
  await withSpawnedPi(replaying, async () => {
    const agent = new PiAcpAgent(asAgentConn(replayConn))
    ;(agent as any).store = {
      get: (sessionId: string) => ({ sessionId, cwd: '/tmp/project', sessionFile: '/tmp/project/s1.jsonl' }),
      upsert() {}
    }
    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)
  })

  const agentMessageIds = (conn: FakeAgentSideConnection) =>
    conn.updates.flatMap(({ update }) => (update.sessionUpdate === 'agent_message_chunk' ? [update.messageId] : []))
  assert.deepEqual(agentMessageIds(liveConn), ['1700000000123'])
  assert.deepEqual(agentMessageIds(replayConn), ['1700000000123'])
})
