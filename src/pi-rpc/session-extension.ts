/**
 * A pi extension that pi-acp loads into the pi it starts for a session whose ACP client sent MCP servers. It registers
 * them with pi's built-in MCP support (pi 0.99 or later).
 *
 * pi loads this file on its own, so it imports nothing at runtime.
 */

export const SESSION_VARIABLE = 'PI_ACP_SESSION'

/** An `mcpServers` entry of pi's mcp.json. */
export type PiMcpServerConfig =
  | { url: string; headers: Record<string, string>; exposure: 'direct' }
  | { command: string; args: string[]; env: Record<string, string>; exposure: 'direct' }

export type SessionOptions = { mcpServers: Record<string, PiMcpServerConfig> }

type PiExtensionApi = {
  registerMcpServer(name: string, config: PiMcpServerConfig): void
}

const SESSION_KEY = Symbol.for('pi-acp.session')

/**
 * Read once per process, as a reload loads the extension again, and taken out of the environment, which the commands
 * pi runs inherit, since server headers and environments can hold credentials.
 */
function sessionOptions(): SessionOptions {
  const store = globalThis as typeof globalThis & { [SESSION_KEY]?: SessionOptions }
  const options = (store[SESSION_KEY] ??= { mcpServers: {}, ...JSON.parse(process.env[SESSION_VARIABLE] ?? '{}') })
  delete process.env[SESSION_VARIABLE]
  return options
}

export default function sessionExtension(pi: PiExtensionApi): void {
  for (const [name, config] of Object.entries(sessionOptions().mcpServers)) {
    try {
      pi.registerMcpServer(name, config)
    } catch (e) {
      console.error(`pi-acp: could not add MCP server ${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
