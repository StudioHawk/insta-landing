#!/usr/bin/env node
/**
 * Fetch the latest 3 StudioHawk YouTube videos and write them to data.json.
 *
 * SCOPE: YouTube only. The Supabase keyword half of this script was removed
 * once format-finder's /api/public/insta-keywords endpoint became the source
 * of truth for search keywords — insta now fetches keywords LIVE from FF on
 * every page load. Do not re-add Supabase keyword fetching here; the two
 * paths are intentionally separate so they can't drift out of sync.
 *
 * Output shape (data.json):
 *   {
 *     "youtubeVideos": [{ id, title, thumbnailUrl, url }, ...],
 *     "generatedAt": ISO timestamp
 *   }
 *
 * Used by .github/workflows/refresh-youtube.yml (scheduled daily + manual).
 */
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const DATA_PATH = path.join(REPO_ROOT, "data.json");

const { YOUTUBE_API_KEY, STUDIOHAWK_YT_CHANNEL_ID } = process.env;

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
  const fetched = await fetchYouTubeVideos();
  const existing = await loadExistingData();

  // If YouTube failed, preserve the previous value rather than emptying it.
  const youtubeVideos = fetched ?? existing?.youtubeVideos ?? [];

  // data.json deliberately no longer carries an `entries` field — keywords
  // live in format-finder and are fetched live by index.html.
  const data = {
    youtubeVideos,
    generatedAt: new Date().toISOString(),
  };

  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(
    `Wrote data.json: ${youtubeVideos.length} videos` +
      (fetched === null ? " (preserved from previous run)" : ""),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
