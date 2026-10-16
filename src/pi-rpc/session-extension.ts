/**
 * A pi extension that pi-acp loads into the pi it starts for a session whose ACP client sent MCP servers or text to
 * add to the system prompt. It registers the servers with pi's built-in MCP support (pi 0.99 or later), and adds the
 * text after the system prompt's own appended part.
 *
 * pi loads this file on its own, so it imports nothing at runtime.
 */

export const SESSION_VARIABLE = 'PI_ACP_SESSION'

/** An `mcpServers` entry of pi's mcp.json. */
export type PiMcpServerConfig =
  | { url: string; headers: Record<string, string>; exposure: 'direct' }
  | { command: string; args: string[]; env: Record<string, string>; exposure: 'direct' }

export type SessionOptions = { mcpServers: Record<string, PiMcpServerConfig>; appendSystemPrompt: string }

type BeforeAgentStartEvent = { systemPromptOptions: { appendSystemPrompt?: string } }

type PiExtensionApi = {
  registerMcpServer(name: string, config: PiMcpServerConfig): void
  on(event: 'before_agent_start', handler: (event: BeforeAgentStartEvent) => void): void
}

const SESSION_KEY = Symbol.for('pi-acp.session')

/**
 * Read once per process, as a reload loads the extension again, and taken out of the environment, which the commands
 * pi runs inherit, since server headers and environments can hold credentials.
 */
function sessionOptions(): SessionOptions {
  const store = globalThis as typeof globalThis & { [SESSION_KEY]?: SessionOptions }
  const options = (store[SESSION_KEY] ??= {
    mcpServers: {},
    appendSystemPrompt: '',
    ...JSON.parse(process.env[SESSION_VARIABLE] ?? '{}')
  })
  delete process.env[SESSION_VARIABLE]
  return options
}

export default function sessionExtension(pi: PiExtensionApi): void {
  const { mcpServers, appendSystemPrompt } = sessionOptions()
  for (const [name, config] of Object.entries(mcpServers)) {
    try {
      pi.registerMcpServer(name, config)
    } catch (e) {
      console.error(`pi-acp: could not add MCP server ${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // Not pi's --append-system-prompt, which would take the place of the APPEND_SYSTEM.md files pi finds.
  if (appendSystemPrompt) {
    pi.on('before_agent_start', ({ systemPromptOptions }) => {
      systemPromptOptions.appendSystemPrompt = [systemPromptOptions.appendSystemPrompt, appendSystemPrompt]
        .filter(Boolean)
        .join('\n\n')
    })
  }
}
