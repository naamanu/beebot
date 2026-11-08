# Control Tower demo videos

Two cuts of the same demo, made with [Remotion](https://www.remotion.dev/):

| Composition | Output | Length | For |
|---|---|---|---|
| `GithubTour` | `out/control-tower-tour.mp4` | ~58 s | The repo README (copied to `docs/media/`) |
| `TweetCut` | `out/control-tower-tweet.mp4` | ~37 s | X/Twitter: a hook up front, captions above the app, faster pacing |

Both are 1920×1080 at 30 fps. Captions are burned in, so the video works with the sound off.

## What it shows

The video is an animated recreation of the Control Tower UI, not a screen recording. The scenes are React components styled with the app's own theme and fonts. The content comes from a real recorded run against the simulated store (`data/postmortems/inc-mvmmrvlm.*`): the deploy, the findings (shortened for the screen, numbers kept), the rollback and the postmortem summary. The tower's spoken reply to "Logs, what are you seeing?" is a summary of the Logs findings written for the video. Each app scene shows a "simulated production · recreated from a recorded run · waits shortened" label.

- `src/data.ts`: all on-screen content
- `src/ui.tsx`: recreated UI pieces (top bar, health card, agent cards, approval card, chart)
- `src/scenes.tsx`: one scene per step
- `src/Tour.tsx`: captions, intro/outro, and the per-cut durations

## Rendering

```bash
cd video
npm install
npm run studio          # preview and tweak in the browser
npm run render:github   # → out/control-tower-tour.mp4
npm run render:tweet    # → out/control-tower-tweet.mp4
```

Rendering uses Remotion's bundled Chrome; add `--browser-executable=…` to use a local one. To refresh the README preview GIF:

```bash
ffmpeg -ss 6 -t 34 -i video/out/control-tower-tour.mp4 \
  -vf "setpts=PTS/2.2,fps=12,scale=820:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
  docs/media/control-tower-tour-preview.gif
```
