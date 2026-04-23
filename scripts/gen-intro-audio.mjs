#!/usr/bin/env node
/*
 * gen-intro-audio.mjs — one-shot generator for the /intro.html voiceover.
 *
 * Calls the ElevenLabs TTS API for each of the five scene scripts and
 * writes the resulting MP3s to site/assets/audio/. Once those files exist
 * the /intro page picks them up automatically — the page's JS only falls
 * back to the browser's speechSynthesis when none of the MP3s are
 * reachable.
 *
 * Usage (from advocatemcp/):
 *   export ELEVENLABS_API_KEY=sk_live_xxx
 *   node scripts/gen-intro-audio.mjs
 *
 * Optional env overrides:
 *   ELEVENLABS_VOICE_ID   — pick a different voice. Defaults to "Rachel".
 *   ELEVENLABS_MODEL      — defaults to eleven_turbo_v2_5 (balanced).
 *   ELEVENLABS_STABILITY  — 0..1, defaults 0.5.
 *   ELEVENLABS_SIMILARITY — 0..1, defaults 0.75.
 *
 * Cost note: 5 scenes × ~55 words each ≈ 275 characters per scene → ~1400
 * characters total. On Turbo v2.5 that's <$0.05 all-in at standard rates.
 * Re-running overwrites the MP3s, which is fine — idempotent.
 *
 * A few popular voice IDs you can paste into ELEVENLABS_VOICE_ID:
 *   Rachel  — 21m00Tcm4TlvDq8ikWAM  (professional warm female, default)
 *   Adam    — pNInz6obpgDQGcFmaJgB  (narrative male)
 *   Bella   — EXAVITQu4vr4xnSDxMaL  (soft expressive female)
 *   Antoni  — ErXwobaYiN019PkySvjV  (friendly male)
 *   Aria    — 9BWtsMINqrJLrRacOk9x  (clear female, newer)
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = resolve(__dirname, '..', 'site', 'assets', 'audio');

const API_KEY    = process.env.ELEVENLABS_API_KEY;
const VOICE_ID   = process.env.ELEVENLABS_VOICE_ID   || '21m00Tcm4TlvDq8ikWAM';
const MODEL_ID   = process.env.ELEVENLABS_MODEL      || 'eleven_turbo_v2_5';
const STABILITY  = parseFloat(process.env.ELEVENLABS_STABILITY  || '0.5');
const SIMILARITY = parseFloat(process.env.ELEVENLABS_SIMILARITY || '0.75');

if (!API_KEY) {
  console.error('ERROR: set ELEVENLABS_API_KEY in your environment and retry.');
  console.error('       Grab one at https://elevenlabs.io/app/settings/api-keys');
  process.exit(1);
}

/* Same scripts the /intro page reads for its speechSynthesis fallback.
   Keep these in lockstep with the <template id="narration-scripts">
   block in site/intro.html. */
const SCENES = [
  {
    n: 1,
    out: 'intro-scene-1.mp3',
    text:
      'Every day, millions of customers ask AI assistants like ChatGPT and Perplexity for a business like yours. ' +
      '"Best florist near me." "Weekend emergency plumber." ' +
      'The problem? AI is scraping old Yelp reviews, outdated blog posts, and hoping it got the answer right.',
  },
  {
    n: 2,
    out: 'intro-scene-2.mp3',
    text:
      'Advocate intercepts the question before AI guesses. ' +
      'When a crawler visits your site, we hand it clean, accurate information, straight from you — ' +
      'your hours, your services, your prices, a direct link to reach you. ' +
      'No code changes. No developer. Fifteen minutes from start to live.',
  },
  {
    n: 3,
    out: 'intro-scene-3.mp3',
    text:
      'Now when someone asks ChatGPT or Claude for a business like yours, your name comes up. ' +
      'With your real hours. Your actual prices. ' +
      'And a tracked link that sends that customer straight to your booking page. ' +
      'No more hoping the AI got it right.',
  },
  {
    n: 4,
    out: 'intro-scene-4.mp3',
    text:
      'You see every mention, every click-back, broken down by AI tool. ' +
      'A plain-English weekly digest lands in your inbox. ' +
      'Pro adds Competitor Radar — so you know the one query where your neighbor is beating you, ' +
      'and exactly what to change to flip it.',
  },
  {
    n: 5,
    out: 'intro-scene-5.mp3',
    text:
      'Start free for fourteen days. No credit card. Cancel any time. ' +
      'Most businesses are live in under fifteen minutes, seeing their first AI mentions within twenty-four hours. ' +
      'Click Start Free Trial, or run a free audit first to see exactly how AI describes you right now.',
  },
];

async function synthesize(scene) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text: scene.text,
      model_id: MODEL_ID,
      voice_settings: {
        stability:        STABILITY,
        similarity_boost: SIMILARITY,
        style:            0,
        use_speaker_boost: true,
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '(no body)');
    throw new Error(`ElevenLabs ${res.status}: ${errText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`→ output: ${OUT_DIR}`);
  console.log(`→ voice:  ${VOICE_ID}  model: ${MODEL_ID}`);
  console.log(`→ scenes: ${SCENES.length}`);
  console.log('');

  for (const scene of SCENES) {
    process.stdout.write(`  [${scene.n}/${SCENES.length}] ${scene.out} … `);
    try {
      const mp3 = await synthesize(scene);
      const outPath = resolve(OUT_DIR, scene.out);
      await writeFile(outPath, mp3);
      console.log(`${(mp3.length / 1024).toFixed(1)} KB ✓`);
    } catch (err) {
      console.log(`✘`);
      console.error(`      ${err.message}`);
      process.exit(2);
    }
  }

  console.log('');
  console.log('✓ all scenes generated. Deploy site/ to refresh /intro.html.');
}

main();
