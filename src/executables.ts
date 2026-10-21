import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

const nodeRuntimeTimeoutMs = 5_000;

/** Keep process diagnostics readable without exposing process output or unbounded paths. */
function boundedDiagnostic(value: string, maximum: number): string {
  const readable = value.replace(/[\u0000-\u001f\u007f]/gu, ' ');
  return readable.length > maximum ? `${readable.slice(0, maximum)}…` : readable;
}

/** Preserve the process failure while reporting only its selected executable and status. */
function nodeRuntimeFailure(executable: string, error: ExecFileException): Error {
  const timeout = error.killed === true && error.signal === 'SIGTERM' && (error.code === null || error.code === undefined);
  const code = typeof error.code === 'number' ? `Exit-Code ${error.code}`
    : typeof error.code === 'string' ? boundedDiagnostic(error.code, 64) : undefined;
  const signal = error.signal === null || error.signal === undefined ? undefined
    : `Signal ${boundedDiagnostic(error.signal, 32)}`;
  const reason = timeout ? `Zeitlimit: ${nodeRuntimeTimeoutMs / 1_000} s`
    : [code, signal].filter(detail => detail !== undefined).join(', ') || 'unbekannter Prozessfehler';
  const summary = timeout ? 'Node.js hat nicht rechtzeitig geantwortet' : 'Node.js konnte nicht gestartet werden';
  return new Error(`${summary} (${reason}). Ausführbare Datei: „${boundedDiagnostic(executable, 512)}“.`, { cause: error });
}

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
    execFile(executable, ['--version'], { encoding: 'utf8', timeout: nodeRuntimeTimeoutMs }, (error, stdout) => {
      if (error !== null) reject(error);
      else resolveVersion(stdout.trim());
    });
  }).catch((error: unknown) => {
    if (error instanceof Error) throw nodeRuntimeFailure(executable, error);
    throw error;
  });
  const major = /^v(\d+)\./u.exec(version)?.[1];
  if (major === undefined || Number(major) < 22) {
    throw new Error(`Local Review benötigt Node.js 22 oder neuer; gefunden wurde ${version || 'keine gültige Version'}.`);
  }
}
