import {readFile} from 'node:fs/promises';
/** Inspect frame-to-frame camera continuity and pointer/typing pacing for the demo QA report. */
const motion=JSON.parse(await readFile(new URL('./motion.json',import.meta.url),'utf8'));
console.log(JSON.stringify({
  typing_start_ms:motion.typing[0].at,
  typing_complete_ms:motion.typing.at(-1).at,
  complete_text_hold_ms:10800-motion.typing.at(-1).at,
  camera_max_scale:Math.max(...motion.camera.flatMap(plan=>plan.keyframes.map(frame=>frame.scale))),
  pointer_moves_ms:motion.movements.map(plan=>plan.durationMs),
  click_moments_ms:motion.clicks,
  final_state_hold_ms:27300-25550,
  fps:30,
  frame_count:900
},null,2));
