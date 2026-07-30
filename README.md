# Immersive 3D AR Cricket

Webcam-AR cricket batting game. MediaPipe pose tracking watches your swing through the webcam and drives a 3D avatar (React Three Fiber) facing famous scripted deliveries.

## Requirements

- Node.js 20+
- A webcam — the game is unplayable without camera access
- HTTPS (or `localhost`): `getUserMedia` only works in secure contexts

## Develop

```bash
npm install
npm run dev        # http://localhost:3000
```

## AI commentary (optional)

The app runs fully keyless: with no API key it falls back to scripted local commentary and the `@google/genai` SDK is never even loaded (lazy import).

To enable AI commentary/coaching, set `GEMINI_API_KEY` in `.env.local`:

```bash
echo 'GEMINI_API_KEY=your_key_here' > .env.local
```

Note: the key is inlined into the bundle at **build time** via Vite `define`, so changing it requires a rebuild/redeploy. Do not commit `.env.local`.

## Verify

```bash
npm run typecheck
npm run build
npm run preview    # serves dist/ locally
```

There are also headless sanity harnesses for the tracking/smoothing/bat math — see the `verify:*` scripts in `package.json` (`npm run` lists them).

## Deploy (Vercel)

Zero config needed — Vercel auto-detects the Vite preset (`Build Command: vite build`, `Output Directory: dist`, `Install Command: npm ci`). The app is a single-page static site with no client-side routing, so no rewrite rules are required.

1. Import this repo in Vercel (New Project → Import Git Repository).
2. Framework Preset: **Vite** (auto-detected — leave defaults).
3. (Optional) Add Environment Variable `GEMINI_API_KEY` if you want AI commentary; it is baked in at build time, so redeploy after changing it.
4. Deploy.

After deploy: open the URL, allow camera permission when prompted. If permission was previously denied, use the in-game retry button after re-enabling it in the browser's site settings.
