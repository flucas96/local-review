import {readFile} from 'node:fs/promises';
/** Report presentation timing for the demo's motion and editorial QA. */
const motion=JSON.parse(await readFile(new URL('./motion.json',import.meta.url),'utf8'));
console.log(JSON.stringify({
  coding_complete_ms:motion.coding.at(-1).at,
  typing_start_ms:motion.typing[0].at,
  typing_complete_ms:motion.typing.at(-1).at,
  complete_feedback_hold_ms:16600-motion.typing.at(-1).at,
  camera_max_scale:Math.max(...motion.camera.flatMap(plan=>plan.keyframes.map(frame=>frame.scale))),
  pointer_moves_ms:motion.movements.map(plan=>plan.durationMs),
  click_moments_ms:motion.clicks,
  duration_ms:motion.duration,
  fps:30,
  frame_count:motion.duration/1000*30
},null,2));
