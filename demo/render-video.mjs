import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd=fileURLToPath(new URL('.',import.meta.url));
const cli=process.env.DEMO_PLAYWRIGHT_CLI;
/** Render sequential frame chunks with the Playwright CLI's isolated demo session. */
const run = arguments_ => new Promise((resolve,reject)=>{
  const executable=cli?process.execPath:'playwright-cli';
  const commandArguments=cli?[cli,...arguments_]:arguments_;
  const child=spawn(executable,commandArguments,{cwd,stdio:'inherit'});
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`Playwright CLI exited ${code}`)));
});
await run(['-s=local-review-demo','reload']);
for(const start of [0,225,450,675,900,1125]) {
  console.log(`Rendering frames ${start}–${Math.min(start+224,1349)} / 1349`);
  await run(['-s=local-review-demo','goto',`http://127.0.0.1:4177/?start=${start}`]);
  await run(['-s=local-review-demo','run-code','--filename=render-frames.js']);
}
console.log('Rendered all 1350 frames at 30fps.');
