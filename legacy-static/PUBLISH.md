# Publish to GitHub Pages → install on iPhone

This folder is a ready-to-host mini web app:
`index.html` (hub) · `program.html` · `meals.html` · offline support (`sw.js`) ·
icons · `manifest.webmanifest`. Your name/PII is stripped and `noindex` + `robots.txt`
keep it out of search.

> ⚠️ GitHub Pages (free) is **publicly viewable by anyone with the link** — there is no
> free private Pages. This setup makes it unlisted and non-identifying, not access-controlled.
> If you need a real password, use Netlify (paid) instead — just ask and I'll switch it.

---

## A. One-time publish (easiest — web upload, no command line)
1. Go to **github.com → New repository**. Name it something obscure (e.g. `tp-9f3k2`).
   Set **Public** (required for free Pages). Create it.
2. On the new repo page: **Add file → Upload files**. Drag in **all the files in this
   `site/` folder** (including `.nojekyll`; if your file picker hides it, it's fine —
   it only suppresses Jekyll). Commit.
3. **Settings → Pages → Build and deployment → Source: Deploy from a branch →**
   Branch `main`, folder `/ (root)` → **Save**.
4. Wait ~1 minute. Your URL appears at the top of the Pages settings:
   `https://<your-username>.github.io/<repo>/`

## A-alt. Publish via git (this folder is already a git repo)
```
# after creating the empty repo on github.com:
git remote add origin https://github.com/<you>/<repo>.git
git branch -M main
git push -u origin main
```
Then do step 3 above to enable Pages. (Pushing will prompt for GitHub credentials / a
Personal Access Token.)

---

## B. Install on your iPhone (and share with your partner)
1. Open the URL in **Safari** (not Quick Look, not the Files app).
   - Hub: `…github.io/<repo>/`
   - Or go straight to `…/program.html` or `…/meals.html`.
2. Tap **Share → Add to Home Screen → Add**.
3. Launch from the Home Screen icon — it opens **fullscreen, app-like**, and works
   **offline** after the first load.
4. Send your partner the same URL; they repeat step 2.

Tip: Add the **hub** for one icon with links to both, or add `program.html` and
`meals.html` separately for two dedicated icons.

---

## C. When the plan changes (re-publish)
1. I regenerate the updated `program.html` / `meals.html` here.
2. **Bump the cache** so phones pull the new version: in `sw.js`, change
   `const CACHE = 'trainer-2026-06-08'` to a new value (e.g. the new date).
3. Re-upload the changed files (or `git push`). Reopen the app twice to refresh the cache.
