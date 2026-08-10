# Running the app locally

Firebase app (Hosting + Cloud Functions + Firestore + Auth + Storage). Local dev uses the
Firebase Emulator Suite; the web app auto-connects to the emulators when served from
localhost (see `public/js/firebase-init.js`).

## Prerequisites
- **Node.js 22** (see `functions/package.json` engines)
- **Java 17+** — required by the Firestore/Auth emulators
- **Firebase CLI** — `npm i -g firebase-tools`

## One-time setup
```bash
cd functions
npm install --legacy-peer-deps   # peer-dep conflict: @firebase/rules-unit-testing wants firebase@10
npm run build                    # tsc
```

### Local secrets (per machine — gitignored, NOT in the repo)
The Claude functions read `ANTHROPIC_API_KEY`. Create `functions/.secret.local`:
```
ANTHROPIC_API_KEY=sk-ant-...your key...
```
- Both `.secret.local` and `.env` are gitignored. `generateProgram` / `generateMealPlan` /
  `parseBodyScan` declare `secrets: ["ANTHROPIC_API_KEY"]`, and Firebase loads `.secret.local`
  **after** `.env`, so if both exist they must match — a stale value in `.secret.local`
  silently overrides `.env` (symptom: `401 authentication_error: invalid x-api-key` even with
  a valid key in `.env`).
- The key is validated lazily (only when a generation runs), so a missing key won't crash
  startup — it errors on the first generate call.

## Run the emulators
```bash
FUNCTIONS_DISCOVERY_TIMEOUT=60 firebase emulators:start --project hj-training-program-hj2t3of5
```
- `FUNCTIONS_DISCOVERY_TIMEOUT=60` avoids a cold-start discovery timeout — functions load in
  ~1s but the default 10s window can flake (esp. on Windows). Symptom: *"Cannot determine
  backend specification"* and 0 functions loaded.
- Not being logged in is fine — the emulators run offline with a fake project number.

| Service | URL |
|---|---|
| App (Hosting) | http://127.0.0.1:5000 |
| Emulator UI | http://127.0.0.1:4000 |
| Auth / Firestore / Functions / Storage | 9099 / 8080 / 5001 / 9199 |

## Gotchas
- **Rebuild + restart** the emulators after any `functions/*.ts` change (`npm run build`, then
  restart). Frontend files under `public/` are static — a browser refresh suffices (the
  service worker is network-first).
- **Emulator data is in-memory** and resets on restart. Add
  `--import=./.emulator-data --export-on-exit` if you want it to persist between runs.
- **Storage bucket**: the Admin SDK bucket is set explicitly to
  `hj-training-program-hj2t3of5.firebasestorage.app` in `functions/src/index.ts` — the default
  `{projectId}.appspot.com` bucket doesn't exist for this project, and without the override
  every Storage read (Hevy CSV, body-scan PDF) 404s.
- **Generation latency/cost**: `generateProgram` takes ~2–4 min; server + client timeouts are
  set to 300s. Anthropic bills per call even if the function times out.
- Inspect Firestore emulator data via the UI, or REST with header `Authorization: Bearer owner`.

## The plan
- `hevy-progression-adherence.md` — implementation spec (progression + adherence from Hevy).
- `hevy-progression-adherence.html` — the spec plus the weekly workflow screen walkthrough
  (open in a browser).
