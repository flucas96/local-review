import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/** Locate the requested executable without depending on a terminal's later shell startup. */
export async function resolveExecutable(configured: string, workspaceRoot: string): Promise<string> {
  const executable = configured.trim();
  if (!executable || executable.includes('\0')) throw new Error('Der Programmpfad ist leer oder ungültig.');
  const explicit = isAbsolute(executable) || executable.includes('/') || executable.includes('\\');
  const directories = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const fallbacks = executable === 'claude'
    ? [join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
    : executable === 'node' ? ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'] : [];
  const candidates = explicit ? [resolve(workspaceRoot, executable)]
    : [...directories.map(directory => join(directory, executable)), ...fallbacks];
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // A later standard installation path can still provide the executable.
    }
  }
  throw new Error(`${executable} wurde nicht gefunden. Prüfe den Programmpfad in den Local-Review-Einstellungen.`);
}

/** Explain a missing or outdated Node runtime before opening a broken Claude session. */
export async function requireNodeRuntime(executable: string): Promise<void> {
  const version = await new Promise<string>((resolveVersion, reject) => {
    execFile(executable, ['--version'], { encoding: 'utf8', timeout: 5_000 }, (error, stdout) => {
      if (error !== null) reject(new Error('Node.js konnte nicht gestartet werden. Prüfe den Node-Pfad in den Einstellungen.'));
      else resolveVersion(stdout.trim());
    });
  });
  const major = /^v(\d+)\./u.exec(version)?.[1];
  if (major === undefined || Number(major) < 22) {
    throw new Error(`Local Review benötigt Node.js 22 oder neuer; gefunden wurde ${version || 'keine gültige Version'}.`);
  }
}
