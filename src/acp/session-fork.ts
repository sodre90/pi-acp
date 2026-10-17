import type { PiForkCommand } from '../pi-rpc/process.js'

/** The parts of a pi session entry (`get_entries`) a fork needs. */
export type PiSessionEntry = {
  type: string
  id: string
  parentId: string | null
  message?: { role?: unknown; timestamp?: unknown }
}

/**
 * The ACP `messageId` of a pi assistant message: its timestamp, which pi sets as the reply starts streaming and keeps
 * in the session entry the message is saved as, so live chunks, replayed history and forks of the session agree on it.
 */
export function piMessageId(message: unknown): string | undefined {
  const timestamp = (message as { timestamp?: unknown } | null | undefined)?.timestamp
  return typeof timestamp === 'number' ? String(timestamp) : undefined
}

/**
 * The fork point a client names in `session/fork`, the way claude-agent-acp reads it: the `messageId` of the last
 * agent message the fork keeps.
 */
export function forkPointOf(meta: unknown): string | undefined {
  const point = (meta as { jetbrains?: { air?: { fork?: { messageId?: unknown } } } } | null | undefined)?.jetbrains
    ?.air?.fork?.messageId
  return typeof point === 'string' && point ? point : undefined
}

/**
 * How to fork a session so that it keeps the assistant message `messageId` and the rest of that message's turn: pi's
 * fork before the first user message after it on the current branch, or a clone when no user message follows.
 * Null when the current branch has no such message.
 */
export function forkCommandAt(
  entries: PiSessionEntry[],
  leafId: string | null,
  messageId: string
): PiForkCommand | null {
  const branch = currentBranch(entries, leafId)
  const isPoint = (entry: PiSessionEntry) => isMessage(entry, 'assistant') && piMessageId(entry.message) === messageId
  const pointIndex = branch.reduce((found, entry, index) => (isPoint(entry) ? index : found), -1)
  if (pointIndex === -1) return null
  const nextUserMessage = branch.slice(pointIndex + 1).find(entry => isMessage(entry, 'user'))
  return nextUserMessage ? { type: 'fork', entryId: nextUserMessage.id } : { type: 'clone' }
}

/** The entries from the session's root to its leaf, in order: pi keeps earlier branches in the same file. */
function currentBranch(entries: PiSessionEntry[], leafId: string | null): PiSessionEntry[] {
  const unvisited = new Map(entries.map(entry => [entry.id, entry]))
  const branch: PiSessionEntry[] = []
  for (let id = leafId; id && unvisited.has(id); ) {
    const entry = unvisited.get(id)!
    unvisited.delete(id)
    branch.unshift(entry)
    id = entry.parentId
  }
  return branch
}

function isMessage(entry: PiSessionEntry, role: string): boolean {
  return entry.type === 'message' && entry.message?.role === role
}
