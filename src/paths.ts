import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The plugin's on-disk state root: `~/.dsh/privacy-gateway` unless
 * `DSH_PRIVACY_GATEWAY_HOME` redirects it. Holds the HMAC key (`redact.key`)
 * and the masking records (`masking/`). The env is read lazily so a test that
 * sets it after import still gets the redirect.
 */
export function stateDir(): string {
  const configured = process.env.DSH_PRIVACY_GATEWAY_HOME?.trim()
  if (configured) return configured
  return join(homedir(), '.dsh', 'privacy-gateway')
}
