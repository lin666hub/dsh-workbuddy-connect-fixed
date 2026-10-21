import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { WorkBuddyCredentialStore } from '../src/auth.ts'

const cleanup: string[] = []
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

async function target(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wb-atomic-'))
  cleanup.push(root)
  return join(root, 'credential.json')
}

describe('credential writer coordination', () => {
  it('does not replace stored credentials while another process owns the writer lock', async () => {
    const path = await target()
    const desktopPath = `${path}.desktop`
    await writeFile(desktopPath, JSON.stringify({
      auth: { accessToken: 'expired', refreshToken: 'refresh', expiresAt: 1 },
      account: { uid: 'test-account' },
    }))
    await writeFile(`${path}.lock`, `${process.pid}\n`)
    await utimes(`${path}.lock`, new Date(0), new Date(0))
    const store = new WorkBuddyCredentialStore({
      desktopPath,
      ownPath: path,
      refresh: async () => ({ accessToken: 'replacement', expiresInSec: 3600 }),
    })
    await expect(store.resolve()).rejects.toThrow(/timed out/)
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(`${path}.lock`, 'utf8')).toBe(`${process.pid}\n`)
  })

  it('refuses to write when another live writer holds the lock', async () => {
    const path = await target()
    await writeFile(path, 'original')
    await writeFile(`${path}.lock`, `${process.pid}\n`)
    const attempt = withFileLock(path, () => writeFileAtomic(path, 'replacement', { mode: 0o600 }), {
      waitMs: 20,
    })
    await expect(attempt).rejects.toThrow(/timed out/)
    expect(await readFile(path, 'utf8')).toBe('original')
    expect(await readFile(`${path}.lock`, 'utf8')).toBe(`${process.pid}\n`)
  })

  it('does not reclaim an aged lock whose owner is still alive', async () => {
    const path = await target()
    await writeFile(path, 'original')
    await writeFile(`${path}.lock`, `${process.pid}\n`)
    await utimes(`${path}.lock`, new Date(0), new Date(0))
    await expect(withFileLock(path, () => writeFileAtomic(path, 'replacement', { mode: 0o600 }), {
      waitMs: 20,
    })).rejects.toThrow(/timed out/)
    expect(await readFile(path, 'utf8')).toBe('original')
    expect(await readFile(`${path}.lock`, 'utf8')).toBe(`${process.pid}\n`)
  })

  it('retries Windows transient rename failures without losing the complete replacement', async () => {
    const path = await target()
    // Isolate the platform and built-in fs mocks in a subprocess. This exercises
    // the real helper while leaving other tests and the host filesystem intact.
    const script = `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const originalRename = fs.rename;
      const originalWriteFile = fs.writeFile;
      const failures = ['EACCES', 'EBUSY', 'EPERM'];
      let attempts = 0;
      let exclusive = false;
      fs.rename = async (...args) => {
        const code = failures[attempts++];
        if (code) throw Object.assign(new Error(code), { code });
        return originalRename(...args);
      };
      fs.writeFile = async (...args) => {
        exclusive = args[2]?.flag === 'wx';
        return originalWriteFile(...args);
      };
      syncBuiltinESMExports();
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const { writeFileAtomic } = await import('@deepseek-ai/dsh-atomic-write');
      await writeFileAtomic(process.argv[1], 'complete replacement', { mode: 0o600 });
      console.log(JSON.stringify({ attempts, exclusive, content: await fs.readFile(process.argv[1], 'utf8') }));
    `
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, path])
    expect(JSON.parse(stdout)).toEqual({ attempts: 4, exclusive: true, content: 'complete replacement' })
  })
})
