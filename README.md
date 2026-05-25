# insta.harrysanders.com

The searchable link-in-bio page for Harry Sanders' Instagram. Served at
`insta.harrysanders.com` via Cloudflare Pages (project: `harry-insta`)
with native GitHub integration — push to `main` and it deploys in ~5s.

## Two completely separate data paths

This is deliberate — keep them separate.

| Data | Source | Cadence |
|---|---|---|
| Search keywords | **format-finder** `/api/public/insta-keywords` (live fetch on each page load) | real-time, ~60s CDN cache |
| YouTube thumbnails | `data.json` in this repo, refreshed by `refresh-youtube.yml` | daily cron at 07:00 Melbourne |

If FF is unreachable, search degrades to "Nothing found" — the page still loads and YouTube still works. If `data.json` is stale, you get older YouTube videos but search is unaffected.

## What lives here

- `index.html` — the page. Static content (avatar, bio, mission numbers, cards) is inline. Edit to change copy or layout.
- `style.css` — all styles. Scoped to this page, no framework.
- `avatar.jpg` — profile photo.
- `data.json` — **YouTube videos only** (3 most recent). **Never hand-edited.** Written by the cron.
- `scripts/refresh-youtube.mjs` — the script the Action runs. Fetches the YouTube Data API and writes `data.json`. No Supabase dependency.
- `.github/workflows/refresh-youtube.yml` — cron config (daily, plus a manual "Run workflow" button in the Actions tab).

## How to edit

### Static content (HTML/CSS, cards, bio, mission numbers)
Edit `index.html` or `style.css` directly on github.com or in any editor.
Push to `main`. Cloudflare Pages deploys in ~5s.

### Search keyword map
**Managed in [format-finder](https://github.com/StudioHawk/format-finder).** Two paths get a keyword into insta search:

1. The Trigger Words page at `/skills` — add or re-link a comment trigger to a skill.
2. The skill detail page's `keywords[]` field — every keyword listed on a deployed skill becomes searchable.

Either path is reflected on insta within ~60s (the CDN cache window). Nothing to deploy here.

### YouTube thumbnails
Refreshed daily by the cron. If you ever need fresh thumbnails immediately:

1. Go to the **Actions** tab → **Refresh YouTube data and deploy**.
2. Click **Run workflow** → **Run workflow**.
3. ~30s later, `data.json` is committed and Cloudflare Pages deploys.

## Secrets

GitHub → Settings → Secrets and variables → Actions:

- `YOUTUBE_API_KEY`
- `STUDIOHAWK_YT_CHANNEL_ID`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The old `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` secrets are no longer used by this repo — safe to leave in place or remove from GH settings; they're inert.

## Rolling back

The Cloudflare Pages project is connected to this repo. If a deploy
breaks the live site:

1. CF dashboard → Pages → `harry-insta` → Deployments.
2. Find the last known-good deployment.
3. Click the three-dot menu → **Rollback to this deployment**.
