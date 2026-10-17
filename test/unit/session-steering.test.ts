import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' }

function makeSession(proc: FakePiRpcProcess) {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(new FakeAgentSideConnection()),
    fileCommands: []
  })
}

function agentWith(session: PiAcpSession) {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = { maybeGet: (id: string) => (id === 's1' ? session : undefined), get: () => session }
  return agent
}

const steering = (prompt: unknown[], idleBehavior?: string) => ({
  sessionId: 's1',
  prompt,
  ...(idleBehavior && { _meta: { steering: { idleBehavior } } })
})

test('initialize advertises the steering extension', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const response = await agent.initialize({ protocolVersion: 1 } as any)
  assert.deepEqual(response._meta, { steering: { supported: true } })
})

test('a steered message joins the running turn through pi steer, with its images', async () => {
  const proc = new FakePiRpcProcess()
  const session = makeSession(proc)
  const turn = session.prompt('Write the tests')

  const result = await agentWith(session).extMethod(
    '_session/steering',
    steering([{ type: 'text', text: 'Use node:test' }, image], 'promptRequired')
  )

  assert.deepEqual(result, { outcome: 'injected' })
  assert.deepEqual(proc.steers, [
    { message: 'Use node:test', images: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] }
  ])
  assert.equal(proc.prompts.length, 1)
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
})

test('with no turn running, a client that asks for it gets promptRequired and nothing is sent to pi', async () => {
  const proc = new FakePiRpcProcess()
  const result = await agentWith(makeSession(proc)).extMethod(
    '_session/steering',
    steering([{ type: 'text', text: 'Too late' }], 'promptRequired')
  )

  assert.deepEqual(result, { outcome: 'promptRequired', reason: 'noRunningTurn' })
  assert.deepEqual(proc.steers, [])
  assert.deepEqual(proc.prompts, [])
})

test('with no turn running and no idleBehavior, the steered message starts a turn of its own', async () => {
  const proc = new FakePiRpcProcess()
  const result = await agentWith(makeSession(proc)).extMethod(
    '_session/steering',
    steering([{ type: 'text', text: 'Start over' }])
  )

  assert.deepEqual(result, { outcome: 'startedNewTurn' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(proc.steers, [])
  assert.deepEqual(
    proc.prompts.map(({ message }) => message),
    ['Start over']
  )
})

test('a turn pi has settled takes no steered message while its last updates go out', async () => {
  const proc = new FakePiRpcProcess()
  let releaseStats: () => void = () => {}
  proc.getSessionStats = () => new Promise(resolve => (releaseStats = () => resolve({})))
  const session = makeSession(proc)
  const turn = session.prompt('Write the tests')
  proc.emit({ type: 'agent_settled' })

  assert.equal(await session.steer('Too late'), false)
  assert.deepEqual(proc.steers, [])
  releaseStats()
  assert.equal(await turn, 'end_turn')
})

test('steering requests without a prompt or with an unknown idleBehavior are invalid, and other extension methods unknown', async () => {
  const agent = agentWith(makeSession(new FakePiRpcProcess()))
  await assert.rejects(agent.extMethod('_session/steering', steering([])), { code: -32602 })
  await assert.rejects(agent.extMethod('_session/steering', steering([{ type: 'text', text: 'x' }], 'startNewTurn')), {
    code: -32602
  })
  await assert.rejects(agent.extMethod('_session/unknown', {}), { code: -32601 })
})
