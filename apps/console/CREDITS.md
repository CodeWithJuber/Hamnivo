# Credits for assets bundled in Studio

## Notification sounds

The five alert sounds (Chime, Pop, Bell, Drop, Ping) are **not audio files**. Studio makes them in
the browser from a few sine waves that fade away: `renderSound` in
`src/lib/alert-sounds.ts` turns a sound's recipe (pitches, overtones, how fast each fades) into
samples, and the Web Audio API plays them. Nothing was recorded, sampled or downloaded.

- **Made by:** Hamnivo contributors, for this project (self-generated).
- **Source:** `src/lib/alert-sounds.ts` (the recipes are the `RECIPES` table).
- **Licence:** the same as the rest of Hamnivo (MIT).
- **Third-party audio:** none.

If a recorded sound is added later, list it here with its author, where it came from and its
licence (CC0, or a licence that allows redistribution), and keep the file next to this one.
