# insta.harrysanders.com

The searchable link-in-bio page for Harry Sanders' Instagram. Served at
`insta.harrysanders.com` via Cloudflare Pages (project: `harry-insta`)
with native GitHub integration — push to `main` and it deploys in ~5s.

## What lives here

- `index.html` — the page. Static content (avatar, bio, 100K mission
  numbers, cards) is inline. Edit to change copy, layout, cards.
- `style.css` — all styles. Scoped to this page, no framework.
- `avatar.jpg` — profile photo.
- `data.json` — the dynamic bits (keyword → guide URL map + the 3
  most recent YouTube thumbnails). **Never hand-edited.** Written by
  the GitHub Action on a daily cron.
- `scripts/fetch-data.mjs` — the script the Action runs. Reads Supabase
  `microsites` + YouTube Data API, writes `data.json`.
- `.github/workflows/refresh-data.yml` — cron config (daily, plus a
  manual "Run workflow" button in the Actions tab).

## How to edit

### Static content (HTML/CSS, cards, bio, mission numbers)
Edit `index.html` or `style.css` directly on github.com or in any editor.
Push to `main`. Cloudflare Pages deploys in ~5s.

### Search keyword map
Managed in [format-finder](https://github.com/StudioHawk/format-finder)
at `/skills`. Adding keywords to a microsite there will make them
searchable on insta **after the next data refresh**. Daily cron runs
at 07:00 Melbourne. For instant refresh, trigger the Action manually
(see below).

### YouTube thumbnails
Fetched automatically from StudioHawk's channel on each data refresh.
Nothing to configure here.

## Forcing a data refresh

1. Go to the **Actions** tab on this repo.
2. Click **Refresh data** workflow.
3. Click **Run workflow** → **Run workflow**.
4. ~30s later, `data.json` is committed and Cloudflare Pages deploys.

## Secrets (set once, never in the repo)

GitHub → Settings → Secrets and variables → Actions:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `YOUTUBE_API_KEY`
- `STUDIOHAWK_YT_CHANNEL_ID`

## Rolling back

The Cloudflare Pages project is connected to this repo. If a deploy
breaks the live site:

1. CF dashboard → Pages → `harry-insta` → Deployments.
2. Find the last known-good deployment.
3. Click the three-dot menu → **Rollback to this deployment**.

Or disconnect the GitHub integration entirely (Settings → Builds &
deployments → Disconnect) to revert to the previous wrangler-deployed
build.
