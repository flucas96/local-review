import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const tests = (await readdir('test')).filter(name => name.endsWith('.test.ts'));
await build({
  entryPoints: tests.map(name => `test/${name}`),
  alias: { vscode: resolve('test/fakes/vscode.ts') },
  outdir: '.test-dist', bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'warning'
});
const child = spawn(process.execPath, ['--test', ...tests.map(name => `.test-dist/${name.replace(/\.ts$/, '.js')}`)], { stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
