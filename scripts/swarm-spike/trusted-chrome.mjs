// Resolve the Chrome/Chromium binary used by the swarm spike harnesses.
//
// SECURITY: both harnesses launch Chrome with `--no-sandbox` and a DevTools
// (CDP) port, then drive the browser. Only a trusted, operator-installed
// browser binary may be used, and the harness must never load an untrusted URL.
// `CHROME` therefore has to be an absolute path to an existing executable
// outside world-writable temporary directories.
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CHROME = '/usr/bin/google-chrome';

/**
 * Validate `CHROME` (or the default) and return the path to spawn.
 * Throws with an actionable message for relative paths, missing files,
 * non-executables and binaries inside temp directories.
 */
export function resolveChromeBinary(rawValue = process.env.CHROME) {
  const candidate =
    typeof rawValue === 'string' && rawValue.trim() ? rawValue.trim() : DEFAULT_CHROME;

  if (!path.isAbsolute(candidate)) {
    throw new Error(
      `CHROME must be an absolute path to a trusted Chrome/Chromium binary ` +
        `(got ${JSON.stringify(candidate)}); relative paths are rejected`,
    );
  }

  const resolved = path.resolve(candidate);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`CHROME does not point at a regular file: ${resolved}`);
  }
  try {
    accessSync(resolved, constants.X_OK);
  } catch {
    throw new Error(`CHROME is not executable: ${resolved}`);
  }

  // A binary dropped in a world-writable temp dir is not trusted input.
  const real = realpathSync(resolved);
  const tmp = path.resolve(os.tmpdir());
  if (real === tmp || real.startsWith(tmp + path.sep)) {
    throw new Error(
      `CHROME must not point into a temporary directory (${real}); ` +
        `use a trusted, operator-installed browser binary`,
    );
  }

  return resolved;
}