import { writeFile } from 'node:fs/promises';
import { planPointerMotion, planTyping, planCameraMotion } from './human-motion.mjs';

/** Build a repeatable, human-paced timeline for the staged product walkthrough. */
const text = 'Use exponential backoff instead of a fixed delay.';
let elapsed = 5600;
const typing = planTyping(text, {seed: 712, pace: 1.15}).map(({character, delayMs}) => {
  elapsed += delayMs;
  return {at: elapsed, character};
});
const movements = [
  {at: 1800, start:{x:1440,y:780},end:{x:477,y:423}, targetWidth:26,targetHeight:28,seed:41},
  {at: 3900, start:{x:477,y:423},end:{x:862,y:555}, targetWidth:550,targetHeight:70,seed:42},
  {at: 10800, start:{x:862,y:555},end:{x:692,y:627}, targetWidth:150,targetHeight:42,seed:43},
  {at: 12800, start:{x:692,y:627},end:{x:1678,y:627}, targetWidth:118,targetHeight:42,seed:44},
  {at: 24200, start:{x:1678,y:627},end:{x:1659,y:755}, targetWidth:146,targetHeight:42,seed:45}
].map(({at,...options}) => ({at,...planPointerMotion(options)}));
const base = {x:0,y:0,scale:1};
const focus = {x:-33,y:-18,scale:1.035};
const camera = [
  {at:3800,...planCameraMotion({from:base,to:focus,durationMs:1000})},
  {at:14900,...planCameraMotion({from:focus,to:base,durationMs:1100})}
];
const clicks = [3200, 5160, 12100, 14200, 25500];
await writeFile(new URL('./motion.json',import.meta.url),JSON.stringify({text,typing,movements,camera,clicks},null,2)+'\n');
