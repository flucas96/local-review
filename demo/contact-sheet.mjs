import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const sharp = require(process.env.DEMO_SHARP ?? 'sharp');
const moments = [0,1800,3200,3800,4800,5160,7000,9401,10800,12100,14200,15000,16200,17800,20000,21800,24200,25550,27300,28000,29500];
const width=640,height=360,label=36,columns=3,rows=Math.ceil(moments.length/columns);
const layers=[];
/** Prefer frames decoded from the delivery MP4, falling back to preview captures. */
const framePath = async time => {
  const encoded=join('demo/output/playwright',`encoded-${time}.png`);
  try { await access(encoded); return encoded; }
  catch { return join('demo/output/playwright',`key-${time}.png`); }
};
for(const [index,time] of moments.entries()) {
 const left=(index%columns)*width,top=Math.floor(index/columns)*(height+label);
 layers.push({input:await sharp(await framePath(time)).resize(width,height).toBuffer(),left,top});
 layers.push({input:Buffer.from(`<svg width="${width}" height="${label}"><rect width="100%" height="100%" fill="#111925"/><text x="16" y="24" font-size="18" font-family="sans-serif" fill="#bdd2e3">${(time/1000).toFixed(2)} seconds</text></svg>`),left,top:top+height});
}
await sharp({create:{width:columns*width,height:rows*(height+label),channels:3,background:'#111925'}}).composite(layers).jpeg({quality:88}).toFile('demo/output/playwright/contact-sheet.jpg');
await sharp(await framePath(21800)).jpeg({quality:94}).toFile('docs/media/local-review-poster.jpg');
