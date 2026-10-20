# Local Review product demo

A reproducible **30-second, 1920 × 1080, 30 fps, silent H.264 MP4** walkthrough of the Local Review interaction model. This is a **staged VS Code-style interface with simulated Claude responses**, not a recording of an authenticated Claude run. The disclosure remains visible in the video. The staged layout illustrates the supported workflow; native VS Code comment styling may differ.

- Final video: [`../docs/media/local-review-demo.mp4`](../docs/media/local-review-demo.mp4)
- Poster: [`../docs/media/local-review-poster.jpg`](../docs/media/local-review-poster.jpg)
- Visual QA: [`output/playwright/contact-sheet.jpg`](output/playwright/contact-sheet.jpg)
- Encoder metadata: [`output/playwright/metadata.json`](output/playwright/metadata.json)
- Story: [`beat-sheet.md`](beat-sheet.md)

## Story and presentation

The demo follows one comment from line selection through intent, automatic delivery, acknowledgment, work, a reply in the original thread, the updated diff, and human resolution. The active Claude terminal is already connected when the demo begins. Installation and connection are described in the repository README rather than compressed into the workflow.

The scene uses deterministic pointer paths, per-character typing delays, an insertion caret that blinks through pauses, pointer-down ripples, and a single stable camera wrapper with a restrained 3.5% zoom. `human-motion.mjs` comes from the create-product-demo-video skill and `plan-motion.mjs` generates the committed `motion.json` timeline.

## Reproduce

Requirements: Node.js 22+, `@playwright/cli` with Chromium, and a video encoder. On macOS, Xcode command line tools provide the native H.264 encoder used here. This is rendering tooling, not an extension test suite. It does not install the extension, alter VS Code/Claude configuration, or invoke an LLM.

From the repository root:

```sh
node demo/plan-motion.mjs
node demo/serve.mjs
```

In another terminal, from `demo/`, open an isolated browser session. The example assumes `playwright-cli` is on the path (available from the `@playwright/cli` package); the Playwright skill's wrapper is also supported.

```sh
playwright-cli -s=local-review-demo open http://127.0.0.1:4177
playwright-cli -s=local-review-demo resize 1920 1080
playwright-cli -s=local-review-demo run-code --filename=preview.js
playwright-cli -s=local-review-demo goto 'http://127.0.0.1:4177/?start=0'
playwright-cli -s=local-review-demo run-code --filename=render-frames.js
playwright-cli -s=local-review-demo goto 'http://127.0.0.1:4177/?start=225'
playwright-cli -s=local-review-demo run-code --filename=render-frames.js
playwright-cli -s=local-review-demo goto 'http://127.0.0.1:4177/?start=450'
playwright-cli -s=local-review-demo run-code --filename=render-frames.js
playwright-cli -s=local-review-demo goto 'http://127.0.0.1:4177/?start=675'
playwright-cli -s=local-review-demo run-code --filename=render-frames.js
playwright-cli -s=local-review-demo close
```

The four rendering passes capture 900 deterministic PNG frames at 30 fps. Return to the repository root. On macOS:

```sh
xcrun swiftc -parse-as-library demo/encode.swift -o demo/output/encode
./demo/output/encode demo/output/playwright docs/media/local-review-demo.mp4
xcrun swiftc -parse-as-library demo/inspect.swift -o demo/output/inspect
./demo/output/inspect docs/media/local-review-demo.mp4 demo/output/playwright
```

Alternatively, encode with FFmpeg on any supported platform:

```sh
ffmpeg -framerate 30 -i demo/output/playwright/frame-%04d.png \
  -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart \
  -an docs/media/local-review-demo.mp4
```

To regenerate the contact sheet and poster, make the `sharp` Node package available to the renderer and run `node demo/contact-sheet.mjs`. You can set `DEMO_SHARP` to its module path. The contact sheet uses frames extracted from the final encoded video when present and falls back to the deterministic preview frames otherwise. Generated full frame sequences, temporary browser files, and compiled native tools are ignored by Git.

The source is purpose-built for capture. To inspect an individual time in a browser, use `window.setDemoTime(milliseconds)` in the developer console after the page is ready.
