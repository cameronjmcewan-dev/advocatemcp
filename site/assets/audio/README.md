# /intro.html voiceover

The 2-minute walkthrough at [/intro.html](../../intro.html) is driven by
five ~24s audio clips. The page picks them up automatically when they
live here as:

```
intro-scene-1.mp3
intro-scene-2.mp3
intro-scene-3.mp3
intro-scene-4.mp3
intro-scene-5.mp3
```

When no MP3s are present, the page falls back to the browser's built-in
`speechSynthesis` API reading the same scripts — readable but clearly
robotic. The MP3s are what make it feel produced.

## Generate (ElevenLabs, recommended)

From the repo root:

```bash
export ELEVENLABS_API_KEY=sk_live_...        # https://elevenlabs.io/app/settings/api-keys
node scripts/gen-intro-audio.mjs
```

The script calls `POST /v1/text-to-speech/:voice_id` for each scene and
writes the MP3s here. Cost ≈ $0.05 total on `eleven_turbo_v2_5` at
normal pricing.

### Voice + model overrides

Defaults target a warm, professional female read suited to an
SMB-pitch. Override with env vars:

```bash
ELEVENLABS_VOICE_ID=pNInz6obpgDQGcFmaJgB \  # Adam — narrative male
ELEVENLABS_MODEL=eleven_multilingual_v2 \   # higher quality, 2–3× cost
ELEVENLABS_STABILITY=0.55 \                 # 0–1, higher = less variation
ELEVENLABS_SIMILARITY=0.75 \                # 0–1, higher = clone-ier
node scripts/gen-intro-audio.mjs
```

Popular voice IDs (all English):

| Voice | ID | Vibe |
|---|---|---|
| Rachel | `21m00Tcm4TlvDq8ikWAM` | professional warm female (default) |
| Adam | `pNInz6obpgDQGcFmaJgB` | narrative male |
| Bella | `EXAVITQu4vr4xnSDxMaL` | soft expressive female |
| Antoni | `ErXwobaYiN019PkySvjV` | friendly male |
| Aria | `9BWtsMINqrJLrRacOk9x` | clear female |

## Scripts (verbatim)

Also kept in sync inside [/intro.html](../../intro.html) under the
`<template id="narration-scripts">` block, and in the SCENES array of
[scripts/gen-intro-audio.mjs](../../../scripts/gen-intro-audio.mjs). If
you tweak copy in one place, update all three.

### Scene 1 — The problem

> Every day, millions of customers ask AI assistants like ChatGPT and
> Perplexity for a business like yours. "Best florist near me."
> "Weekend emergency plumber." The problem? AI is scraping old Yelp
> reviews, outdated blog posts, and hoping it got the answer right.

### Scene 2 — How it works

> Advocate intercepts the question before AI guesses. When a crawler
> visits your site, we hand it clean, accurate information, straight
> from you — your hours, your services, your prices, a direct link to
> reach you. No code changes. No developer. Fifteen minutes from start
> to live.

### Scene 3 — The result

> Now when someone asks ChatGPT or Claude for a business like yours,
> your name comes up. With your real hours. Your actual prices. And a
> tracked link that sends that customer straight to your booking page.
> No more hoping the AI got it right.

### Scene 4 — The dashboard

> You see every mention, every click-back, broken down by AI tool. A
> plain-English weekly digest lands in your inbox. Pro adds Competitor
> Radar — so you know the one query where your neighbor is beating
> you, and exactly what to change to flip it.

### Scene 5 — Get started

> Start free for fourteen days. No credit card. Cancel any time. Most
> businesses are live in under fifteen minutes, seeing their first AI
> mentions within twenty-four hours. Click Start Free Trial, or run a
> free audit first to see exactly how AI describes you right now.

## Replacing with a real recorded voice

Same filenames, same place, MP3 mono 44.1 kHz. The page doesn't care
who generated the bytes — drop in a professional read and it swaps
seamlessly.
