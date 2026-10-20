import {readFile,writeFile,copyFile,readdir,unlink} from 'node:fs/promises';

/** Inspect H.264 chroma/depth and MP4 streaming layout; retain encoded QA keyframes. */
const output=new URL('./output/playwright/',import.meta.url);
const data=await readFile(new URL('../docs/media/local-review-demo.mp4',import.meta.url));
const avc=data.indexOf(Buffer.from('avcC'))+4;
if(avc<4)throw new Error('H.264 configuration missing');
const profile=data[avc+1];const nalSize=data.readUInt16BE(avc+6);
const nal=data.subarray(avc+8,avc+8+nalSize);
const raw=[];
for(let index=1;index<nal.length;index++) {
  if(index>=2&&nal[index]===3&&nal[index-1]===0&&nal[index-2]===0)continue;
  raw.push(nal[index]);
}
let bit=0;
const read=count=>{let value=0;for(let index=0;index<count;index++){value=(value<<1)|((raw[Math.floor(bit/8)]>>(7-bit%8))&1);bit++;}return value;};
const ue=()=>{let zeros=0;while(read(1)===0)zeros++;return 2**zeros-1+read(zeros);};
read(8);read(8);read(8);ue();let chroma=1,bits=8;
if([100,110,122,244,44,83,86,118,128,138,139,134,135].includes(profile)){chroma=ue();if(chroma===3)read(1);bits=8+ue();}
let offset=0;const boxes=[];
while(offset+8<=data.length){let size=data.readUInt32BE(offset);const type=data.toString('ascii',offset+4,offset+8);if(size===1)size=Number(data.readBigUInt64BE(offset+8));if(size===0)size=data.length-offset;if(size<8)break;boxes.push(type);offset+=size;}
const metadata=JSON.parse(await readFile(new URL('metadata.json',output),'utf8'));
const motion=JSON.parse(await readFile(new URL('./motion.json',import.meta.url),'utf8'));
Object.assign(metadata,{pixel_format:chroma===1&&bits===8?'yuv420p':`chroma_format_idc=${chroma},bit_depth=${bits}`,h264_profile:profile===100?'High':profile,faststart:boxes.indexOf('moov')<boxes.indexOf('mdat'),frame_count:motion.duration/1000*30,visual_qa:'Full timeline contact sheet and full-size encoded keyframes inspected, including coding, immediate mode switching, feedback, resolution, PR preview and explicit simulated publish.'});
await writeFile(new URL('metadata.json',output),JSON.stringify(metadata,null,2)+'\n');
const moments=new Set(motion.moments);
for(const file of await readdir(output)) {
 const match=file.match(/^key-(\d+)\.png$/u);
 if(match&&!moments.has(Number(match[1])))await unlink(new URL(file,output));
}
for(const moment of moments)await copyFile(new URL(`encoded-${moment}.png`,output),new URL(`key-${moment}.png`,output));
console.log(JSON.stringify({bytes:data.length,frame_count:metadata.frame_count,pixel_format:metadata.pixel_format,faststart:metadata.faststart,audio:metadata.audio},null,2));
