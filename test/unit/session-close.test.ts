import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession, SessionManager } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function sessionWith(proc: FakePiRpcProcess, sessionId = 's1') {
  return new PiAcpSession({
    sessionId,
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(new FakeAgentSideConnection()),
    fileCommands: []
  })
}

test('PiAcpAgent: initialize advertises session/close', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const initialized = await agent.initialize({ protocolVersion: 1 } as any)
  assert.deepEqual(initialized.agentCapabilities?.sessionCapabilities?.close, {})
})

test('PiAcpAgent: closeSession ends the running and queued turns as cancelled and stops pi', async () => {
  const proc = new FakePiRpcProcess()
  const session = sessionWith(proc)
  const sessions = new SessionManager()
  ;(sessions as any).sessions.set('s1', session)
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = sessions

  const running = session.prompt('one')
  const queued = session.prompt('two')

  assert.deepEqual(await agent.closeSession({ sessionId: 's1' }), {})

  assert.equal(await running, 'cancelled')
  assert.equal(await queued, 'cancelled')
  assert.equal(proc.disposeCount, 1)
  assert.equal(proc.prompts.length, 1)
  assert.equal(sessions.maybeGet('s1'), undefined)
})

test('PiAcpAgent: closing a session that is not open succeeds', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  assert.deepEqual(await agent.closeSession({ sessionId: 'unknown' }), {})
})
