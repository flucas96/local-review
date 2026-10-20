import { mkdir, writeFile } from 'node:fs/promises';

/** Synthesize an original, quiet ambient pad without external samples or recordings. */
const sampleRate=48000;
const duration=45;
const length=sampleRate*duration;
const chords=[
  [130.8128,164.8138,195.9977,246.9417,293.6648],
  [110.0000,164.8138,195.9977,261.6256,329.6276],
  [130.8128,174.6141,220.0000,261.6256,329.6276],
  [146.8324,195.9977,220.0000,261.6256,293.6648]
];
const centers=[3.75,16.25,28.75,41.25];
const stereo=[new Float64Array(length),new Float64Array(length)];
const smooth=p=>{const x=Math.max(0,Math.min(1,p));return x*x*(3-2*x);};
let squareSum=0,peak=0;
for(let sample=0;sample<length;sample++) {
  const time=sample/sampleRate;
  const weights=centers.map(center=>Math.exp(-(((time-center)/9)**4)));
  const weightSum=weights.reduce((sum,value)=>sum+value,0);
  const fade=smooth(time/2.5)*smooth((duration-time)/3.8);
  for(let channel=0;channel<2;channel++) {
    let value=0;
    for(let chord=0;chord<chords.length;chord++) {
      for(let voice=0;voice<chords[chord].length;voice++) {
        const frequency=chords[chord][voice];
        const pan=1+(channel===0?-1:1)*(voice-2)*.09;
        const phase=voice*.71+channel*.095;
        const drift=.0025*Math.sin(2*Math.PI*.045*time+voice);
        const fundamental=Math.sin(2*Math.PI*frequency*time+phase+drift);
        const overtone=.055*Math.sin(2*Math.PI*frequency*2*time+phase);
        const breath=.91+.09*Math.sin(2*Math.PI*.058*time+voice*.35);
        value+=(weights[chord]/weightSum)*(fundamental+overtone)*pan*breath/5;
      }
    }
    const output=value*fade;
    stereo[channel][sample]=output;
    squareSum+=output*output;peak=Math.max(peak,Math.abs(output));
  }
}
const rawRms=Math.sqrt(squareSum/(length*2));
const gain=Math.min(.027/rawRms,.079/peak);
const buffer=Buffer.alloc(44+length*4);
buffer.write('RIFF',0);buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(2,22);buffer.writeUInt32LE(sampleRate,24);buffer.writeUInt32LE(sampleRate*4,28);buffer.writeUInt16LE(4,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(length*4,40);
let finalSquares=0,finalPeak=0,maxDelta=0;
for(let sample=0;sample<length;sample++) {
  for(let channel=0;channel<2;channel++) {
    const value=stereo[channel][sample]*gain;
    finalSquares+=value*value;finalPeak=Math.max(finalPeak,Math.abs(value));
    if(sample>0)maxDelta=Math.max(maxDelta,Math.abs(value-stereo[channel][sample-1]*gain));
    buffer.writeInt16LE(Math.round(value*32767),44+(sample*2+channel)*2);
  }
}
const metrics={title:'Quiet Current',origin:'Original procedural synthesis; no external samples, recordings, or licensed music.',duration_seconds:duration,sample_rate:sampleRate,channels:2,peak_dbfs:20*Math.log10(finalPeak),rms_dbfs:20*Math.log10(Math.sqrt(finalSquares/(length*2))),max_sample_delta:maxDelta,fade_in_seconds:2.5,fade_out_seconds:3.8,clipped_samples:0};
await mkdir(new URL('./output/',import.meta.url),{recursive:true});
await writeFile(new URL('./output/ambient.wav',import.meta.url),buffer);
await writeFile(new URL('./output/playwright/audio-metadata.json',import.meta.url),JSON.stringify(metrics,null,2)+'\n');
console.log(JSON.stringify(metrics,null,2));
