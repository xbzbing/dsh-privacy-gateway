import { homedir } from 'node:os'
import { join } from 'node:path'

/** What the plugin reads of the running instance to pick where its data goes. */
export interface InstanceFacts {
  /** The DSH profile directory the instance runs from (`ctx.profileContext.dir`, `$DSH_HOME/profiles/<name>`). */
  dir?: string
}

/** The directory the plugin keeps its data in, under an instance's profile. */
const PLUGIN_DIR = 'dsh-privacy-gateway'

/**
 * The plugin's on-disk state root, the first of: `DSH_PRIVACY_GATEWAY_HOME`
 * when it is set, the running instance's own directory
 * (`<profile>/plugin-data/dsh-privacy-gateway`), or `~/.dsh/privacy-gateway`
 * for a run that has no profile. It holds the HMAC key (`redact.key`), the
 * masking records (`masking/`) and the session switches (`sessions.json`).
 *
 * The instance's own directory keeps two instances on one machine from writing
 * each other's key, records and session list (docs/adr/0027). The env is read
 * lazily so a test that sets it after import still gets the redirect.
 */
export function stateDir(instance?: InstanceFacts): string {
  const configured = process.env.DSH_PRIVACY_GATEWAY_HOME?.trim()
  if (configured) return configured
  const dir = instance?.dir?.trim()
  if (dir) return join(dir, 'plugin-data', PLUGIN_DIR)
  return join(homedir(), '.dsh', 'privacy-gateway')
}
