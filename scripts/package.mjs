import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const metadata = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
if (typeof metadata.name !== 'string' || !/^[a-z0-9-]+$/.test(metadata.name)
  || typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)) {
  throw new Error('The extension name or version is invalid.');
}
const output = `${metadata.name}-${metadata.version}.vsix`;
const child = spawn(process.execPath, [
  fileURLToPath(new URL('node_modules/@vscode/vsce/vsce', root)),
  'package', '--skip-license', '--no-dependencies', '--out', output,
], { cwd: fileURLToPath(root), stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
