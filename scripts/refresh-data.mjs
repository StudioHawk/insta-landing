#!/usr/bin/env node
/**
 * Build data.json for insta.harrysanders.com.
 *
 * Three sources, each isolated so one failing never blanks the others:
 *
 *   1. Search keywords (the Trigger Word Google Sheet, two tabs).
 *      "Bio link only" holds the topic words that used to come from Format
 *      Finder's microsite keywords; Sheet1 holds the ManyChat trigger words
 *      and wins any clash. A row reaches the page only with both a Page label
 *      and a Page link. Format Finder is no longer involved. Owned-domain URLs
 *      are followed through redirects so the page links to the final address.
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
import { inflateRawSync } from "zlib";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data.json");
const HTML_PATH = path.join(__dirname, "..", "index.html");
const CSS_PATH = path.join(__dirname, "..", "style.css");

const {
  TRIGGER_SHEET_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  YOUTUBE_API_KEY,
  STUDIOHAWK_YT_CHANNEL_ID,
} = process.env;

// Hosts we own. Only these get redirect-resolved (and only these get UTMs
// on the page), everything else is stored exactly as authored.
const OWNED_HOSTS = ["hawkacademy.co", "studiohawk.com.au", "harrysanders.com"];


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
// 1. Keywords, from the Trigger Word sheet.
//
// The sheet ID lives in the TRIGGER_SHEET_ID repo secret and must never be
// committed or logged: this repo is public, and the sheet also carries the
// ManyChat DM copy and CTRs. Read through Google's CSV export, which needs the
// sheet shared as "anyone with the link can view".
//
// Two tabs, read in order, later tab wins a clash (the same layering Format
// Finder used: topic keywords first, trigger words overlaid on top):
//   (a) "Bio link only" topic words, ex-Format Finder microsite keywords
//   (b) Sheet1, the ManyChat trigger words
// Columns are matched by exact header name, never by position. Sheet1's
// "Full message (opening DM -> link)" header also contains the word "link",
// so a loose match would read DM text as the destination URL.
// ---------------------------------------------------------------------------
const SHEET_TABS = [
  { gid: "1535177512", label: "Bio link only" },
  { gid: "0", label: "Sheet1 (ManyChat triggers)", name: "Sheet1", autofill: true },
];

// A Page label of "DM only" keeps a row off the page. Broad words like SEO or
// TOOLS only make sense in a DM straight after a specific video; on the page
// they would swallow unrelated searches (and near-misses, which the page
// tolerates).
const DM_ONLY = /^dm[\s-]*only$/i;

// A renamed column, a moved tab or link sharing switched off comes back as a
// short or empty list. Below this, keep yesterday's words instead of
// publishing a gutted search.
const MIN_KEYWORDS = 150;

// RFC 4180: quoted fields can hold commas, doubled quotes and line breaks,
// all of which turn up in the DM-copy column.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function readTab(gid) {
  const res = await fetch(
    `https://docs.google.com/spreadsheets/d/${TRIGGER_SHEET_ID}/export?format=csv&gid=${gid}`,
    { redirect: "follow" },
  );
  // Never put the URL in an error: it carries the sheet ID.
  if (!res.ok) throw new Error(`sheet tab gid=${gid}: HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/csv")) throw new Error(`sheet tab gid=${gid} did not return CSV (${type}); is link sharing still on?`);
  return parseCsv(await res.text());
}

function columnsOf(header, tabLabel) {
  const at = (re) => header.findIndex((h) => re.test(String(h).trim()));
  const cols = {
    words: at(/^words?(\s*\(s\))?$/i),
    label: at(/^page label$/i),
    link: at(/^page link$/i),
    description: at(/^page description$/i), // optional
  };
  const missing = ["words", "label", "link"].filter((k) => cols[k] < 0);
  if (missing.length) throw new Error(`${tabLabel}: no ${missing.join(" / ")} column in [${header.join(" | ")}]`);
  return cols;
}

// "rule book, rule book (DM trigger)" -> ["rule book"]. Bracketed notes are for
// Talia, not visitors, and would otherwise become searchable as-is. Trailing
// punctuation goes too ("Winner?" -> "winner").
function cleanWords(cell) {
  return String(cell ?? "")
    .replace(/\([^)]*\)/g, " ")
    .split(",")
    .map((w) => w.trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.,;:]+$/, ""))
    .filter((w) => w.length >= 2);
}

// ---------------------------------------------------------------------------
// DM links. Most Sheet1 rows are just a word: the resource lives in the DM
// message ("Full message") as a hyperlink behind the button text. Google's CSV
// export drops hyperlinks, but its .xlsx export keeps them, so read that. A
// minimal zip + regex reader, because this repo has no dependencies.
// ---------------------------------------------------------------------------
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("xlsx export is not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("xlsx export: bad zip directory");
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files[name] = () => (method === 0 ? data : inflateRawSync(data)).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
const xmlAttr = (tag, name) => (tag.match(new RegExp(`\\s${name.replace(":", "\\:")}="([^"]*)"`)) || [])[1];
const xmlDecode = (s) => String(s ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const colLetter = (i) => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

// Map of sheet row number (1-based) -> hyperlink URLs in the given column.
async function readTabHyperlinks(tabName, colIndex) {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${TRIGGER_SHEET_ID}/export?format=xlsx`, { redirect: "follow" });
  if (!res.ok) throw new Error(`xlsx export: HTTP ${res.status}`);
  const zip = unzip(Buffer.from(await res.arrayBuffer()));
  const sheetTag = [...(zip["xl/workbook.xml"]?.() ?? "").matchAll(/<sheet\b[^>]*>/g)].map((m) => m[0])
    .find((t) => xmlDecode(xmlAttr(t, "name")) === tabName);
  if (!sheetTag) throw new Error(`no tab named "${tabName}" in the xlsx export`);
  const relTag = [...(zip["xl/_rels/workbook.xml.rels"]?.() ?? "").matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0])
    .find((t) => xmlAttr(t, "Id") === xmlAttr(sheetTag, "r:id"));
  const sheetPath = "xl/" + String(xmlAttr(relTag ?? "", "Target") ?? "").replace(/^\/?(xl\/)?/, "");
  const relPath = sheetPath.replace("worksheets/", "worksheets/_rels/") + ".rels";
  const targets = Object.fromEntries([...(zip[relPath]?.() ?? "").matchAll(/<Relationship\b[^>]*>/g)]
    .map((m) => [xmlAttr(m[0], "Id"), xmlDecode(xmlAttr(m[0], "Target"))]));
  const col = colLetter(colIndex), out = new Map();
  for (const m of (zip[sheetPath]?.() ?? "").matchAll(/<hyperlink\b[^>]*>/g)) {
    const ref = (xmlAttr(m[0], "ref") ?? "").match(/^([A-Z]+)(\d+)/);
    const url = targets[xmlAttr(m[0], "r:id")];
    if (!ref || ref[1] !== col || !url || !/^https?:\/\//i.test(url)) continue;
    if (!out.has(+ref[2])) out.set(+ref[2], []);
    out.get(+ref[2]).push(url);
  }
  return out;
}

// Title + description for a resource the sheet only gave a link for.
// Hawk Academy's <h1> is the clean resource name ("Title Tag Optimizer"),
// where <title> carries marketing copy ("Free Title Tag Optimizer Prompt for
// Claude - Hawk Academy"), so prefer the h1. YouTube titles come from oEmbed,
// which needs no API key.
const describeCache = new Map();
async function describeResource(url) {
  if (describeCache.has(url)) return describeCache.get(url);
  let out = null;
  try {
    if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
      if (r.ok) { const j = await r.json(); if (j.title) out = { title: j.title, description: "" }; }
    } else {
      const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "insta-landing-build/3.0 (+https://insta.harrysanders.com)" } });
      if (r.ok && /text\/html/.test(r.headers.get("content-type") ?? "")) {
        const html = await r.text();
        const pick = (re) => xmlDecode((html.match(re) || [])[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        const title = pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
          || pick(/property="og:title"\s+content="([^"]*)"/i).replace(/\s*[|–-]\s*[^|–-]+$/, "")
          || pick(/<title[^>]*>([\s\S]*?)<\/title>/i).replace(/\s*[|–-]\s*[^|–-]+$/, "");
        const description = pick(/name="description"\s+content="([^"]*)"/i);
        if (title) out = { title, description };
      }
    }
  } catch (err) {
    console.warn(`  ! could not describe ${url}: ${err.message}`);
  }
  describeCache.set(url, out);
  return out;
}

async function buildEntries() {
  if (!TRIGGER_SHEET_ID) {
    console.warn("TRIGGER_SHEET_ID missing, skipping keywords");
    return null;
  }

  // Read every tab first: an auto-filled row borrows the label of the same
  // resource from anywhere in the sheet, so all explicit labels must be known.
  const tabs = [];
  for (const tab of SHEET_TABS) {
    const rows = await readTab(tab.gid);
    const cols = columnsOf(rows[0] ?? [], tab.label);
    let links = new Map();
    if (tab.autofill) {
      const msgCol = (rows[0] ?? []).findIndex((h) => /^full message/i.test(String(h).trim()));
      if (msgCol < 0) console.log(`::warning title=DM links not read::${tab.label} has no "Full message" column, so word-only rows stay off the page.`);
      else {
        try { links = await readTabHyperlinks(tab.name, msgCol); }
        catch (err) { console.log(`::warning title=DM links not read::${tab.label}: ${err.message}. Word-only rows stay off the page this run.`); }
      }
    }
    tabs.push({ tab, rows, cols, links });
  }

  // Labels already written anywhere in the sheet, by destination, so the same
  // resource reads the same wherever it appears.
  const known = new Map();
  for (const { rows, cols } of tabs) {
    for (const r of rows.slice(1)) {
      const title = String(r[cols.label] ?? "").trim(), url = String(r[cols.link] ?? "").trim();
      if (!title || DM_ONLY.test(title) || !/^https?:\/\//i.test(url)) continue;
      const key = await resolveUrl(url);
      if (!known.has(key)) known.set(key, { title, description: cols.description >= 0 ? String(r[cols.description] ?? "").trim() : "" });
    }
  }

  const entries = {};
  for (const { tab, rows, cols, links } of tabs) {
    const seenInTab = new Set(); // first row wins within a tab
    let words = 0, auto = 0, dmOnly = 0, noLink = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const list = cleanWords(r[cols.words]);
      if (!list.length) continue;
      let title = String(r[cols.label] ?? "").trim();
      let url = String(r[cols.link] ?? "").trim();
      let description = cols.description >= 0 ? String(r[cols.description] ?? "").trim() : "";
      if (DM_ONLY.test(title)) { dmOnly++; continue; }
      let isAuto = false;
      if (!/^https?:\/\//i.test(url)) {
        // Just a word: publish the resource its DM sends (sheet row i+1).
        const dm = (links.get(i + 1) ?? [])[0];
        if (!dm) { noLink++; continue; }
        url = dm; isAuto = true;
      }
      if (!title) {
        const key = await resolveUrl(url);
        const hit = known.get(key) ?? await describeResource(key);
        if (!hit?.title) { noLink++; continue; }
        title = hit.title;
        if (!description) description = hit.description ?? "";
      }
      for (const w of list) {
        if (seenInTab.has(w)) continue;
        seenInTab.add(w);
        entries[w] = { title, description, url };
        words++; if (isAuto) auto++;
      }
    }
    console.log(`  ${tab.label}: ${words} words` + (auto ? ` (${auto} labelled from the DM link)` : "") +
      (dmOnly ? `, ${dmOnly} rows marked DM only` : "") + (noLink ? `, ${noLink} rows with no link to publish` : ""));
  }

  const count = Object.keys(entries).length;
  if (count < MIN_KEYWORDS) {
    const msg = `Only ${count} words came back from the sheet (floor is ${MIN_KEYWORDS}), keeping yesterday's list. Check the sheet's columns and link sharing.`;
    console.log(`::warning title=Keywords not updated::${msg}`);
    throw new Error(msg);
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
