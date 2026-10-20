# Local Review product demo

A reproducible **45-second, 1920 × 1080, 30 fps H.264 MP4 with a quiet original ambient soundtrack**. The video begins with Claude coding, then follows a switch to Review, the controlled composer beside the diff, immediate `/i` mode selection, automatic feedback delivery, an inline reply, human resolution, and a separate PR review preview and publish action.

This is a **staged VS Code-style interface**. Coding, Claude responses, and the PR publish are simulated and labeled throughout. No authenticated Claude session or real GitHub write is recorded. Native VS Code styling may differ.

- Video: [`../docs/media/local-review-demo.mp4`](../docs/media/local-review-demo.mp4)
- Poster: [`../docs/media/local-review-poster.jpg`](../docs/media/local-review-poster.jpg)
- Visual QA: [`output/playwright/contact-sheet.jpg`](output/playwright/contact-sheet.jpg)
- Container and decoded-audio metadata: [`output/playwright/metadata.json`](output/playwright/metadata.json)
- Original synthesis metadata: [`output/playwright/audio-metadata.json`](output/playwright/audio-metadata.json)
- Story: [`beat-sheet.md`](beat-sheet.md)
- Soundtrack provenance: [`audio-source.md`](audio-source.md)

## Presentation

The controlled composer shows Ask, Implement, and Summarize beside the code. Typing `/i` selects Implement immediately; the prefix clears after the following space. `/r` remains a summary action. **Publish to PR** is separate: a readable preview contains the summary and one unresolved question, then an explicit Publish button. The example PR and question are fictional.

Pointer travel uses deterministic curved paths with minimum-jerk timing, visible pointer-down ripples, varied movement duration, per-character typing, and a blinking insertion caret through pauses. The camera moves one stable wrapper with a restrained 2.5% zoom. `human-motion.mjs` is supplied by the create-product-demo-video skill; `plan-motion.mjs` generates the committed `motion.json` timeline.

## Reproduce

Requirements: Node.js 22+, `@playwright/cli` with Chromium, and an encoder. On macOS, Xcode command line tools provide the native H.264/AAC export path used here. The rendering tools do not install the extension, alter VS Code/Claude configuration, invoke an LLM, or publish a review.

From the repository root:

```sh
node demo/plan-motion.mjs
node demo/synthesize-ambient.mjs
node demo/serve.mjs
```

Keep the preview server running. In another terminal, open an isolated browser and render the six sequential frame chunks:

```sh
cd demo
playwright-cli -s=local-review-demo open http://127.0.0.1:4177
playwright-cli -s=local-review-demo resize 1920 1080
node render-video.mjs
playwright-cli -s=local-review-demo run-code --filename=preview.js
playwright-cli -s=local-review-demo close
cd ..
```

`render-video.mjs` runs the CLI from `demo/`, produces 1,350 frames at 30 fps, and stops on failure. Set `DEMO_PLAYWRIGHT_CLI` to the CLI's JavaScript entry point when it is not on the path. The preview captures are optional: the final encoder inspection extracts frames from the actual MP4.

On macOS, encode the video, encode the original soundtrack as AAC, mux it with the H.264 master without re-encoding the video, and inspect the final result:

```sh
xcrun swiftc -parse-as-library demo/encode.swift -o demo/output/encode
./demo/output/encode demo/output/playwright demo/output/local-review-silent.mp4 1350
xcrun swiftc -parse-as-library demo/mix-audio.swift -o demo/output/mix-audio
./demo/output/mix-audio demo/output/local-review-silent.mp4 demo/output/ambient.wav docs/media/local-review-demo.mp4
xcrun swiftc -parse-as-library demo/inspect.swift -o demo/output/inspect
./demo/output/inspect docs/media/local-review-demo.mp4 demo/output/playwright demo/motion.json
node demo/inspect-container.mjs
```

Alternatively, with a complete FFmpeg installation:

```sh
ffmpeg -framerate 30 -i demo/output/playwright/frame-%04d.png \
  -i demo/output/ambient.wav -c:v libx264 -crf 18 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart -shortest \
  docs/media/local-review-demo.mp4
```

Make the `sharp` Node package available and run `node demo/contact-sheet.mjs` to regenerate the contact sheet and poster. Set `DEMO_SHARP` to its module path if needed. Encoded keyframes are preferred over preview captures. Generated full frame sequences, intermediate audio/video, browser files, and compiled native tools are ignored by Git.

Stop the temporary server after rendering. Individual frames can be inspected with `window.setDemoTime(milliseconds)` in the preview's developer console.
