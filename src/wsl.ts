import { release } from 'node:os'

/**
 * Whether this Linux process is running inside Windows Subsystem for Linux.
 *
 * Shared by the desktop-auth candidate probe (`auth.ts`) and the at-rest key
 * helper spawn (`desktop-credential-protection.ts`), so both agree on what
 * "WSL" means. Covers WSL1 and WSL2: WSL2 sets `WSL_DISTRO_NAME` /
 * `WSL_INTEROP`, and every WSL kernel release string carries "microsoft"
 * (e.g. `6.18.33.2-microsoft-standard-WSL2`), which also catches a WSL2
 * session whose env vars were stripped.
 */
export function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env['WSL_DISTRO_NAME'] !== undefined || process.env['WSL_INTEROP'] !== undefined) return true
  return release().toLowerCase().includes('microsoft')
}
