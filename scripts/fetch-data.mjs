#!/usr/bin/env node
/**
 * Fetch Supabase microsites + latest 3 YouTube videos, write data.json.
 *
 * Reads microsites DIRECTLY (no ideas.shot_plan coupling). Any microsite
 * with >=1 keyword AND a non-null deployed_url is searchable on insta.
 *
 * Used by .github/workflows/refresh-data.yml (scheduled + manual dispatch).
 * Safe to run locally if the same env vars are set (source ../.env.local).
 */
import { createClient } from "@supabase/supabase-js";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const DATA_PATH = path.join(REPO_ROOT, "data.json");

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  YOUTUBE_API_KEY,
  STUDIOHAWK_YT_CHANNEL_ID,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function fetchEntries() {
  // Order by updated_at DESC so that when two microsites share a keyword,
  // the more-recently-edited row wins (deterministic + matches old behaviour
  // of build-insta-site.ts which sorted ideas newest-first).
  const { data, error } = await supabase
    .from("microsites")
    .select("title, description, deployed_url, keywords, updated_at")
    .eq("type", "skill")
    .not("deployed_url", "is", null)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`Supabase error: ${error.message}`);

  const entries = {};
  for (const row of data ?? []) {
    const url = typeof row.deployed_url === "string" ? row.deployed_url.trim() : "";
    if (!url) continue;                                    // belt-and-braces: skip empty URLs
    const kws = Array.isArray(row.keywords) ? row.keywords : [];
    for (const rawKw of kws) {
      const kw = typeof rawKw === "string" ? rawKw.trim().toLowerCase() : "";
      if (!kw) continue;
      if (!entries[kw]) {
        entries[kw] = {
          title: row.title ?? "",
          description: row.description ?? "",
          url,
        };
      }
      // First keyword wins — matches current insta-resolve dedupe behaviour.
    }
  }
  return entries;
}

async function fetchYouTubeVideos() {
  if (!YOUTUBE_API_KEY || !STUDIOHAWK_YT_CHANNEL_ID) {
    console.warn("YouTube env missing — skipping video fetch");
    return null;
  }

  // Channel → uploads playlist
  const chUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${STUDIOHAWK_YT_CHANNEL_ID}&key=${YOUTUBE_API_KEY}`;
  const chRes = await fetch(chUrl);
  if (!chRes.ok) {
    console.warn(`YouTube channels API ${chRes.status}: ${await chRes.text()}`);
    return null;
  }
  const chBody = await chRes.json();
  const uploadsId = chBody.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) {
    console.warn(`No uploads playlist for channel ${STUDIOHAWK_YT_CHANNEL_ID}`);
    return null;
  }

  // Latest 3 videos
  const plUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=3&playlistId=${uploadsId}&key=${YOUTUBE_API_KEY}`;
  const plRes = await fetch(plUrl);
  if (!plRes.ok) {
    console.warn(`YouTube playlistItems API ${plRes.status}: ${await plRes.text()}`);
    return null;
  }
  const plBody = await plRes.json();
  return (plBody.items ?? []).map((item) => {
    const s = item.snippet;
    const videoId = s.resourceId.videoId;
    const thumbs = s.thumbnails ?? {};
    const thumb = thumbs.maxres || thumbs.high || thumbs.medium || thumbs.default;
    return {
      id: videoId,
      title: s.title,
      thumbnailUrl: thumb?.url ?? "",
      url: `https://youtu.be/${videoId}`,
    };
  });
}

async function loadExistingData() {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  const entries = await fetchEntries();
  const fetchedVideos = await fetchYouTubeVideos();
  const existing = await loadExistingData();

  // If YouTube failed, preserve the previous value rather than emptying it.
  const youtubeVideos = fetchedVideos ?? existing?.youtubeVideos ?? [];

  const data = {
    entries,
    youtubeVideos,
    generatedAt: new Date().toISOString(),
  };

  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(
    `Wrote data.json: ${Object.keys(entries).length} entries, ${youtubeVideos.length} videos` +
      (fetchedVideos === null ? " (youtube preserved from previous run)" : "")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
