# Demo video

How the [demo video](https://youtu.be/7bE7jsvFZwk) was made. Everything in it is ours: the footage is our own OBS stream and screen recordings, the animations are HTML pages rendered frame by frame, the sound effects are synthesized with ffmpeg, and there is no music. The narration is AI-generated (OpenAI TTS). Every secret and personal detail on screen is fake.

| Path | What it is |
|---|---|
| `script.json` | Narration and captions, scene by scene |
| `stage/` | The fake content we put on stream: an editor with a `.env`, an address, a QR login, a checkout, a seed phrase, an IP and a student portal |
| `anim/` | The animated scenes: the 3D leak, the Twitchy intro, the Gauntlet numbers and the pipeline |
| `build/` | Scripts that drove OBS, rendered the animations and cards, generated the narration and cut the video |

The pipeline, in order:

1. `tsx video/build/obs.mts` drives OBS over obs-websocket (recording, going live, adding the stage page), while `stage-server.mts` and `run-stage.mts` step through the stage scenes.
2. `node video/build/capture.mjs <page.html> <out.mp4>` renders an animation with headless Chrome.
3. `node video/build/render-cards.mjs` renders the captions and title cards; `sh video/build/sfx.sh` synthesizes the sound effects.
4. `tsx video/build/tts.mts cedar` generates the narration (needs `OPENAI_API_KEY`).
5. `node video/build/edit.mjs` cuts the final video with ffmpeg.

The recordings, audio and renders are gitignored, so the edit only runs after you record your own footage.
