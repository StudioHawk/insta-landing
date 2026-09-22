# insta.harrysanders.com

The searchable link-in-bio page for Harry Sanders' Instagram. A viewer hears
"comment BACKLINKS" in a video, opens the bio link, types the word, and gets
the guide. Served at `insta.harrysanders.com` from Cloudflare Pages (project
`harry-insta`, direct upload via Wrangler from the GitHub Action).

## How it works

Everything the page needs is in this repo. There is no runtime dependency on
any other app: `index.html` loads `data.json` and that is it.

`data.json` is built by `scripts/refresh-data.mjs`, which the Action runs on
every push, daily at 07:00 Melbourne, and on the manual "Run workflow" button.
It pulls three things, each isolated so one failure never blanks the others
(the previous value is kept and the log says so):

| Field | Source | Notes |
|---|---|---|
| `entries` | Trigger Word Google Sheet (ID in the `TRIGGER_SHEET_ID` secret; never commit it, the sheet also holds DM copy and CTRs). Tabs: "Bio link only" then Sheet1, Sheet1 wins a clash | A row is published only with both a **Page label** and a **Page link**. Bracketed notes in the words column are stripped. Fewer than 150 words keeps the previous list. Owned-domain URLs are followed through redirects so the page links to the final address. |
| `popular` | Supabase `insta_keyword_searches`, last 90 days | Top 8 matched words, shown as tappable chips under the search box. Topped up with evergreen words when thin. |
| `youtubeVideos` | YouTube Data API | Latest 3 uploads, with the thumbnail sizes YouTube confirms exist. |

## Search behaviour

Exact match first, then forgiving variants, in order: spacing and punctuation
ignored ("back links" = "backlinks"), singular/plural, a unique prefix
("ecom" opens the ecommerce guide), and finally a one- or two-letter typo.
Anything ambiguous shows "Did you mean" chips. A genuine miss shows a link to
the full guide library on hawkacademy.co.

Analytics go to Supabase `insta_keyword_searches` (anon insert only):

- a hit is logged as the matched keyword, once per page load
- a miss is logged as `miss:<what they typed>` once typing pauses for 1.2s

Query the misses to find words being said on camera that the map does not know.

## What lives here

- `index.html`: the page. Bio, mission numbers and cards are inline.
- `style.css`: all styles, no framework. The pixel font is self-hosted in `fonts/`.
- `avatar.jpg` (240px), `icon-192.png`, `apple-touch-icon.png`, `og.jpg` (1200x630 share image).
- `data.json`: built by the Action. Never hand-edit; it is overwritten on the next run.
- `scripts/refresh-data.mjs`: the build. Plain Node 20+, no dependencies.
- `.github/workflows/refresh-youtube.yml`: schedule + deploy.

## How to edit

| What | How |
|---|---|
| Copy, cards, bio, mission numbers | Edit `index.html`, push to `main`. Live in about a minute. |
| Styling | Edit `style.css`, push. |
| A keyword's destination | Change its **Page link** in the Trigger Word sheet, then Actions → *Refresh data and deploy* → Run workflow. Live in about a minute. |
| Add a keyword | Add a row to the Trigger Word sheet (Sheet1 for a ManyChat trigger, "Bio link only" otherwise) with a **Page label** and **Page link**, then run the workflow. |
| Popular chips | Automatic from search analytics. |
| YouTube videos | Automatic. |
| No-match message | In `index.html`, search for "Nothing found for". |

## Secrets (GitHub → Settings → Secrets → Actions)

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `YOUTUBE_API_KEY`, `STUDIOHAWK_YT_CHANNEL_ID`
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

## Run the build locally

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/refresh-data.mjs
```

Without YouTube keys the videos are preserved from the existing `data.json`.

## Rolling back

Cloudflare dashboard → Pages → `harry-insta` → Deployments → three-dot menu
on any earlier deployment → Rollback. Or `git revert HEAD` and push.
