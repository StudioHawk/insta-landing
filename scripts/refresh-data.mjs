#!/usr/bin/env node
/**
 * Build data.json for insta.harrysanders.com.
 *
 * Three sources, each isolated so one failing never blanks the others:
 *
 *   1. Search keywords (Supabase: microsites + manual_triggers + ideas).
 *      Replicates the aggregation Format Finder's /api/public/insta-keywords
 *      used to do at request time, so the page no longer depends on that
 *      app being alive. Owned-domain URLs are followed through redirects so
 *      the page links straight to the final address.
 *   2. Popular words (Supabase: insta_keyword_searches, last 90 days). The
 *      page shows these as tappable chips under the search box.
 *   3. Latest 3 YouTube videos (YouTube Data API).
 *
 * If a source fails, the previous data.json value for it is preserved.
 *
 * Output shape:
 *   {
 *     "entries":       { "<keyword>": { title, description, url } },
 *     "popular":       ["backlinks", "ai", ...],
 *     "youtubeVideos": [{ id, title, url, thumbnails: { medium, standard, maxres } }],
 *     "generatedAt":   ISO timestamp
 *   }
 *
 * Run by .github/workflows/refresh-youtube.yml (daily, on push, manual).
 */
import { promises as fs } from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data.json");
const HTML_PATH = path.join(__dirname, "..", "index.html");
const CSS_PATH = path.join(__dirname, "..", "style.css");

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  YOUTUBE_API_KEY,
  STUDIOHAWK_YT_CHANNEL_ID,
} = process.env;

// Hosts we own. Only these get redirect-resolved (and only these get UTMs
// on the page), everything else is stored exactly as authored.
const OWNED_HOSTS = ["hawkacademy.co", "studiohawk.com.au", "harrysanders.com"];

// Mirrors format-finder/lib/trigger-keywords.ts. A single-word trigger
// override on an idea is ignored when it is one of these.
const STOP_WORDS = new Set([
  "i", "you", "he", "she", "we", "they", "it",
  "my", "your", "our", "his", "her", "their", "its",
  "this", "that", "these", "those",
  "what", "which", "who", "whose", "whom",
  "him", "us", "them",
  "a", "an", "the",
  "at", "in", "on", "of", "to", "for", "with", "by", "from", "about",
  "into", "onto", "upon", "out", "off", "up", "down", "over", "under",
  "across", "through", "before", "after", "during", "without", "within",
  "below", "above", "here", "there",
  "and", "or", "but", "if", "when", "then", "than", "while", "as",
  "though", "although", "because", "since", "so", "yet",
  "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had",
  "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "must", "can",
  "please", "thanks", "thank", "hey", "ok", "okay", "well", "just", "like",
  "really", "now", "today", "tonight",
  "winner", "winners", "answer", "answers", "thoughts",
  "engagement", "engage", "comments", "comment",
  "anything", "everything", "something", "nothing",
  "anyone", "everyone", "someone", "noone",
]);

// ---------------------------------------------------------------------------
// Supabase (plain REST, no SDK)
// ---------------------------------------------------------------------------
async function sb(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      // Lift PostgREST's default 1000-row cap well above any table here.
      Range: "0-9999",
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status} on ${pathAndQuery}: ${await res.text()}`);
  return res.json();
}

function isOwned(hostname) {
  return OWNED_HOSTS.some((h) => hostname === h || hostname.endsWith("." + h));
}

// Canonical YouTube watch URL, so the page ships one clean link per video
// instead of youtu.be shorteners carrying ?si= tracking junk. The page turns
// these into an app-opening tap; anything it cannot parse is left alone.
function canonicaliseYouTube(raw) {
  let u;
  try { u = new URL(raw); } catch { return raw; }
  const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
  let id = null;
  if (host === "youtu.be") {
    id = u.pathname.split("/")[1] || null;
  } else if (host === "youtube.com" || host === "music.youtube.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
      if (m) id = m[1];
      else return raw; // channel, playlist, anything else: leave as authored
    }
  } else {
    return raw;
  }
  if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return raw;
  const t = u.searchParams.get("t") || u.searchParams.get("start") || "";
  const hms = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  const secs = hms ? (+hms[1] || 0) * 3600 + (+hms[2] || 0) * 60 + (+hms[3] || 0) : 0;
  return `https://www.youtube.com/watch?v=${id}${secs ? `&t=${secs}s` : ""}`;
}

// yt.openinapp.co serves an interstitial page rather than a redirect, so the
// viewer pays an extra page load before reaching the video. Pull the real
// YouTube URL out of that page; the page's own app-opening handles the rest.
async function unwrapOpenInApp(raw) {
  const res = await fetch(raw, { headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" } });
  if (!res.ok) throw new Error(`openinapp ${res.status}`);
  const html = await res.text();
  const m = html.match(/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[A-Za-z0-9_\-?=&;%.]+/);
  if (!m) throw new Error("no YouTube URL in the interstitial");
  return canonicaliseYouTube(m[0].replace(/&amp;/g, "&"));
}

// Follow redirects on owned domains and return the final URL, keeping any
// query string the original carried. Returns the input on any failure.
const resolveCache = new Map();
async function resolveUrl(raw) {
  if (resolveCache.has(raw)) return resolveCache.get(raw);
  let out = raw;
  try {
    const start = new URL(raw);
    if (start.hostname.endsWith("openinapp.co")) {
      out = await unwrapOpenInApp(raw);
    } else if (/(^|\.)(youtube\.com|youtu\.be)$/.test(start.hostname)) {
      out = canonicaliseYouTube(raw);
    } else if (isOwned(start.hostname)) {
      const res = await fetch(start.toString(), {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": "insta-landing-build/3.0 (+https://insta.harrysanders.com)" },
      });
      if (res.ok && res.url) {
        const final = new URL(res.url);
        if (isOwned(final.hostname)) {
          // Keep the original query (e.g. a hand-set utm) if the redirect dropped it.
          if (start.search && !final.search) final.search = start.search;
          out = final.toString();
        }
      } else if (!res.ok) {
        console.warn(`  ! ${res.status} for ${raw} (kept as-is)`);
      }
      // Drain the body so the connection can be reused.
      try { await res.arrayBuffer(); } catch { /* ignore */ }
    } else {
      out = start.toString();
    }
  } catch (err) {
    console.warn(`  ! could not resolve ${raw}: ${err.message}`);
  }
  if (out !== raw) console.log(`  ~ ${raw}\n    -> ${out}`);
  resolveCache.set(raw, out);
  return out;
}

// ---------------------------------------------------------------------------
// 1. Keywords. Same two-layer union format-finder served:
//    (a) every microsite.keywords[] entry, newest skill wins a clash
//    (b) every comment-bucket trigger word, resolved to one destination,
//        overlaid on top of (a)
// ---------------------------------------------------------------------------
async function buildEntries() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("Supabase env missing, skipping keywords");
    return null;
  }

  const [ideas, skills, manual] = await Promise.all([
    sb("ideas?select=id,trigger_keyword,trigger_keywords,status"),
    sb("microsites?select=id,title,description,deployed_url,keywords,source_idea_id,updated_at&type=eq.skill&deployed_url=not.is.null"),
    sb("manual_triggers?select=*"),
  ]);

  // trigger word (UPPER) -> set of idea ids, filmed-or-later ideas only
  const triggerToIdeaIds = new Map();
  for (const idea of ideas) {
    if (!idea.status || idea.status === "idea") continue;
    const kwSet = new Set();
    const override = typeof idea.trigger_keyword === "string" ? idea.trigger_keyword.trim() : "";
    if (override && !STOP_WORDS.has(override.toLowerCase())) {
      kwSet.add(override.toUpperCase());
    } else {
      for (const raw of Array.isArray(idea.trigger_keywords) ? idea.trigger_keywords : []) {
        const kw = String(raw).toUpperCase().trim();
        if (kw) kwSet.add(kw);
      }
    }
    for (const kw of kwSet) {
      if (!triggerToIdeaIds.has(kw)) triggerToIdeaIds.set(kw, new Set());
      triggerToIdeaIds.get(kw).add(idea.id);
    }
  }

  // manual triggers, comment bucket only
  const manualByKeyword = new Map();
  for (const m of manual) {
    if ((m.bucket ?? "comment") !== "comment") continue;
    const kw = String(m.keyword ?? "").toUpperCase().trim();
    if (!kw) continue;
    manualByKeyword.set(kw, {
      linked_skill_id: m.linked_skill_id ?? null,
      custom_url: m.custom_url ?? null,
      custom_label: m.custom_label ?? null,
    });
  }

  const skillById = new Map(skills.map((s) => [s.id, s]));
  const entries = {};

  // (a) microsite keywords, newest-updated skill first so it wins clashes
  const byRecency = [...skills].sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0));
  for (const s of byRecency) {
    if (!s.deployed_url) continue;
    for (const raw of Array.isArray(s.keywords) ? s.keywords : []) {
      const kw = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      if (!kw || entries[kw]) continue;
      entries[kw] = { title: s.title ?? "", description: s.description ?? "", url: s.deployed_url };
    }
  }

  // (b) trigger words overlay
  const allKeywords = new Set([...triggerToIdeaIds.keys(), ...manualByKeyword.keys()]);
  for (const keyword of allKeywords) {
    const lower = keyword.toLowerCase();
    const m = manualByKeyword.get(keyword);

    if (m?.custom_url) {
      entries[lower] = { title: m.custom_label ?? keyword, description: "", url: m.custom_url };
      continue;
    }

    let resolved = null;
    if (m?.linked_skill_id) {
      const s = skillById.get(m.linked_skill_id);
      if (s?.deployed_url) resolved = s;
    }
    if (!resolved) {
      const ideaIds = triggerToIdeaIds.get(keyword) ?? new Set();
      const explicit = skills.filter((s) => s.source_idea_id && ideaIds.has(s.source_idea_id));
      const byKeyword = skills.filter((s) =>
        (Array.isArray(s.keywords) ? s.keywords : []).some((k) => typeof k === "string" && k.toLowerCase() === lower),
      );
      const candidates = explicit.length > 0 ? explicit : byKeyword;
      if (candidates.length === 1) resolved = candidates[0];
    }
    if (!resolved?.deployed_url) continue;
    entries[lower] = { title: resolved.title ?? "", description: resolved.description ?? "", url: resolved.deployed_url };
  }

  // Follow redirects on our own domains so the page links to final URLs.
  console.log("Resolving destination URLs...");
  const uniqueUrls = [...new Set(Object.values(entries).map((e) => e.url))];
  for (const u of uniqueUrls) await resolveUrl(u);
  for (const e of Object.values(entries)) e.url = resolveCache.get(e.url) ?? e.url;

  // Stable key order so data.json diffs stay readable.
  return Object.fromEntries(Object.keys(entries).sort().map((k) => [k, entries[k]]));
}

// ---------------------------------------------------------------------------
// 2. Popular words: most-matched keywords over the last 90 days that still
//    exist in the map. Misses are logged with a "miss:" prefix and excluded.
// ---------------------------------------------------------------------------
async function buildPopular(entries) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !entries) return null;
  const since = new Date(Date.now() - 90 * 86400e3).toISOString();
  // Skip every prefixed row ("miss:", "click:", "open:", "video:"): only a
  // plain keyword means somebody searched that word and found something.
  const rows = await sb(`insta_keyword_searches?select=keyword&created_at=gte.${encodeURIComponent(since)}&keyword=not.like.*:*`);
  const counts = new Map();
  for (const r of rows) {
    const k = String(r.keyword ?? "").trim().toLowerCase();
    if (!k || !entries[k]) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  // Top up with evergreen words when the last 90 days are thin.
  const evergreen = ["backlinks", "ai", "local", "ecommerce", "brief", "pr", "trust", "technical"];
  for (const k of evergreen) if (ranked.length < 8 && entries[k] && !ranked.includes(k)) ranked.push(k);
  return ranked.slice(0, 8);
}

// ---------------------------------------------------------------------------
// 3. YouTube
// ---------------------------------------------------------------------------
async function fetchYouTubeVideos() {
  if (!YOUTUBE_API_KEY || !STUDIOHAWK_YT_CHANNEL_ID) {
    console.warn("YouTube env missing, skipping video fetch");
    return null;
  }
  const chRes = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${STUDIOHAWK_YT_CHANNEL_ID}&key=${YOUTUBE_API_KEY}`);
  if (!chRes.ok) { console.warn(`YouTube channels API ${chRes.status}: ${await chRes.text()}`); return null; }
  const uploadsId = (await chRes.json()).items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) { console.warn(`No uploads playlist for channel ${STUDIOHAWK_YT_CHANNEL_ID}`); return null; }

  const plRes = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=4&playlistId=${uploadsId}&key=${YOUTUBE_API_KEY}`);
  if (!plRes.ok) { console.warn(`YouTube playlistItems API ${plRes.status}: ${await plRes.text()}`); return null; }
  return ((await plRes.json()).items ?? []).map((item) => {
    const s = item.snippet;
    const id = s.resourceId.videoId;
    const t = s.thumbnails ?? {};
    return {
      id,
      title: s.title,
      url: `https://youtu.be/${id}`,
      // Only these two sizes are 16:9. YouTube's "high" (480x360) and
      // "standard" (640x480) are 4:3 and would crop in the page's frames.
      thumbnails: {
        medium: t.medium?.url ?? `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
        maxres: t.maxres?.url ?? null,
      },
    };
  });
}

// ---------------------------------------------------------------------------
async function loadExisting() {
  try { return JSON.parse(await fs.readFile(DATA_PATH, "utf8")); } catch { return null; }
}

async function guarded(label, fn) {
  try {
    const v = await fn();
    if (v === null) console.warn(`${label}: skipped`);
    return v;
  } catch (err) {
    console.error(`${label} failed: ${err.message}`);
    return null;
  }
}

// The harrysanders.com zone sets a 4 hour Browser Cache TTL, which overrides
// whatever Cache-Control the _headers file asks for. That once left visitors
// running fresh HTML against a stale stylesheet: a removed element was still
// on screen and the region picker rendered unstyled. The HTML itself always
// revalidates, so pinning the stylesheet URL to a hash of its contents means
// changed CSS always arrives on a URL nothing has cached. Nothing to remember
// on deploy: this runs on every build.
async function stampStylesheetVersion() {
  const css = await fs.readFile(CSS_PATH);
  const version = createHash("sha1").update(css).digest("hex").slice(0, 8);
  const html = await fs.readFile(HTML_PATH, "utf8");
  const next = html.replace(/href="style\.css(?:\?v=[^"]*)?"/, `href="style.css?v=${version}"`);
  if (next === html) {
    console.log(`Stylesheet already stamped v=${version}`);
    return false;
  }
  await fs.writeFile(HTML_PATH, next);
  console.log(`Stamped stylesheet v=${version} into index.html`);
  return true;
}

async function main() {
  const existing = await loadExisting();

  await guarded("stylesheet version", stampStylesheetVersion);

  const entries = await guarded("keywords", buildEntries);
  const popular = await guarded("popular", () => buildPopular(entries ?? existing?.entries));
  const videos = await guarded("youtube", fetchYouTubeVideos);

  const data = {
    entries: entries ?? existing?.entries ?? {},
    popular: popular ?? existing?.popular ?? [],
    youtubeVideos: videos ?? existing?.youtubeVideos ?? [],
    generatedAt: new Date().toISOString(),
  };

  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(
    `Wrote data.json: ${Object.keys(data.entries).length} keywords${entries ? "" : " (preserved)"}, ` +
    `${data.popular.length} popular${popular ? "" : " (preserved)"}, ` +
    `${data.youtubeVideos.length} videos${videos ? "" : " (preserved)"}`,
  );
  if (!entries && !existing?.entries) {
    console.error("No keywords available at all; refusing to publish an empty search.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
