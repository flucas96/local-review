# Original soundtrack: Quiet Current

The demo soundtrack is an original procedural composition created for this project. It uses no external music, samples, loops, voices, field recordings, or third-party sound libraries.

The reproducible source is [`synthesize-ambient.mjs`](synthesize-ambient.mjs). It combines five-note sine-based chord voicings in C major/A minor, a small amount of second harmonic, slow amplitude motion, and gentle stereo variation. A 2.5-second entrance and 3.8-second exit avoid abrupt starts and endings. The target is a soft background bed, with a ceiling of −22 dBFS peak rather than a prominent music track.

The generated PCM master is 48 kHz stereo. `mix-audio.swift` encodes it to AAC and adds it to the H.264 master. No audio is downloaded. The generated composition is provided with the repository under its license; no separate music credit or third-party license is needed.

The source level report is tracked in [`output/playwright/audio-metadata.json`](output/playwright/audio-metadata.json). The final AAC stream is decoded and measured again in [`output/playwright/metadata.json`](output/playwright/metadata.json).
