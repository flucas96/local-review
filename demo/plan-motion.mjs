import { writeFile } from 'node:fs/promises';
import { planPointerMotion, planTyping, planCameraMotion } from './human-motion.mjs';

/** Build a repeatable walkthrough from Claude coding to a review and PR handoff. */
const text = '/i Use exponential backoff instead of a fixed delay.';
let elapsed = 11900;
const typing = planTyping(text, {seed: 712, pace: 1.15}).map(({character, delayMs}) => {
  elapsed += delayMs;
  return {at: elapsed, character};
});
const codingText = 'for attempt in range(3):\n    try: return client.get(url)\n    except RetryableError:\n        time.sleep(1)';
let codeElapsed = 1700;
const coding = planTyping(codingText, {seed: 924, pace: 2.15}).map(({character,delayMs}) => {
  codeElapsed += delayMs;
  return {at: codeElapsed,character};
});
const targets = [
  {at:6500,start:{x:1130,y:680},end:{x:1525,y:238},targetWidth:125,targetHeight:44,seed:40},
  {at:8500,start:{x:1525,y:238},end:{x:421,y:418},targetWidth:26,targetHeight:30,seed:41},
  {at:10250,start:{x:421,y:418},end:{x:1511,y:553},targetWidth:400,targetHeight:125,seed:42},
  {at:16600,start:{x:1511,y:553},end:{x:1745,y:729},targetWidth:135,targetHeight:44,seed:43},
  {at:26700,start:{x:1745,y:729},end:{x:1196,y:741},targetWidth:150,targetHeight:42,seed:44},
  {at:28700,start:{x:1196,y:741},end:{x:1655,y:840},targetWidth:390,targetHeight:42,seed:45},
  {at:34400,start:{x:1655,y:840},end:{x:1316,y:795},targetWidth:180,targetHeight:46,seed:46}
];
const movements=targets.map(({at,...options})=>({at,...planPointerMotion(options)}));
const base={x:0,y:0,scale:1};
const focus={x:-30,y:-11,scale:1.025};
const camera=[
  {at:10600,...planCameraMotion({from:base,to:focus,durationMs:1000})},
  {at:18300,...planCameraMotion({from:focus,to:base,durationMs:1100})}
];
const clicks=[7900,10000,11650,17900,28100,30200,35900];
const moments=[0,1700,4000,6200,6500,7900,8500,10000,10600,11600,11650,12050,12350,14500,16400,17900,18300,19400,20000,21500,23800,26000,28100,28500,30200,31000,34400,35900,36500,39500,41800,43000,44500];
await writeFile(new URL('./motion.json',import.meta.url),JSON.stringify({duration:45000,text,typing,coding,codingText,movements,camera,clicks,moments},null,2)+'\n');
