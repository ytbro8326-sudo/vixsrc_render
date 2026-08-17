import express from "express";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();
const PORT = process.env.PORT || 3000;

// ── Proxy list ────────────────────────────────────────────────────────────────
const PROXIES = [
  "31.59.20.176:6754",
  "31.56.127.193:7684",
  "45.38.107.97:6014",
  "198.105.121.200:6462",
  "64.137.96.74:6641",
  "198.23.243.226:6361",
  "38.154.185.97:6370",
  "84.247.60.125:6095",
  "142.111.67.146:5611",
  "191.96.254.138:6185",
];
const PROXY_USER = "dxicdysy";
const PROXY_PASS = "yndikr9coeto";

// ── Headers ───────────────────────────────────────────────────────────────────
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const BASE_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function decodeApiResponse(raw) {
  raw = raw.trim();
  try { return JSON.parse(raw); } catch (_) {}
  try {
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch (_) {}
  throw new Error("Cannot decode API response");
}

function parseMasterPlaylist(html) {
  const idx = html.indexOf("window.masterPlaylist");
  if (idx === -1) return null;
  const start = html.indexOf("{", idx);
  if (start === -1) return null;

  let depth = 0, end = start;
  for (let i = start; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }

  const block = html.substring(start, end + 1);
  const baseUrl = block.match(/url\s*:\s*['"]([^'"]+)['"]/)?.[1] ?? null;
  const token   = block.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/)?.[1] ?? null;
  const expires = block.match(/['"]expires['"]\s*:\s*['"]([^'"]*)['"]/)?.[1] ?? null;

  return (baseUrl && token)
    ? `${baseUrl}?token=${token}&expires=${expires}&h=1&lang=en`
    : null;
}

// ── Fetch with direct + all proxy fallback ────────────────────────────────────
async function fetchWithFallback(url, options = {}, label = "") {
  // Build attempt list: direct first, then all proxies shuffled
  const proxyAttempts = [...PROXIES]
    .sort(() => Math.random() - 0.5)
    .map(p => `http://${PROXY_USER}:${PROXY_PASS}@${p}`);

  const attempts = [null, ...proxyAttempts]; // null = direct (no proxy)

  for (let i = 0; i < attempts.length; i++) {
    const proxyUrl = attempts[i];
    const label2 = proxyUrl ? `proxy[${i}] ${proxyUrl.split("@")[1]}` : "direct";
    try {
      console.log(`[${label}] Attempt ${i + 1}/${attempts.length} via ${label2}`);
      const fetchOpts = { ...options };
      if (proxyUrl) fetchOpts.agent = new HttpsProxyAgent(proxyUrl);

      const res = await fetch(url, fetchOpts);

      if (res.status === 403 || res.status === 429 || res.status === 407) {
        const body = await res.text();
        console.warn(`[${label}] ${label2} → ${res.status}, trying next. Body snippet: ${body.substring(0, 80)}`);
        continue;
      }

      console.log(`[${label}] ✅ Success via ${label2} → ${res.status}`);
      return res;
    } catch (err) {
      console.warn(`[${label}] ${label2} threw: ${err.message}`);
    }
  }

  throw new Error(`All ${attempts.length} attempts failed (1 direct + ${PROXIES.length} proxies) for: ${url}`);
}

// ── Core logic ────────────────────────────────────────────────────────────────
async function getStream(movieId) {
  // 1. Session warmup
  const r1 = await fetchWithFallback(
    `https://vixsrc.to/movie/${movieId}`,
    {
      headers: {
        ...BASE_HEADERS,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
    },
    "warmup"
  );

  // Collect cookies
  let cookieStr = "";
  const setCookieHeader = r1.headers.get("set-cookie");
  if (setCookieHeader) {
    cookieStr = setCookieHeader
      .split(/,(?=[^ ].*?=)/)
      .map((c) => c.split(";")[0].trim())
      .join("; ");
  }
  console.log(`[cookies] ${cookieStr || "(none)"}`);

  // 2. Get embed URL from API
  async function getEmbedUrl() {
    const r = await fetchWithFallback(
      `https://vixsrc.to/api/movie/${movieId}`,
      {
        headers: {
          ...BASE_HEADERS,
          Accept: "application/json, text/plain, */*",
          Referer: `https://vixsrc.to/movie/${movieId}`,
          Cookie: cookieStr,
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
      },
      "api"
    );

    if (!r.ok) {
      const body = await r.text();
      throw new Error(`API returned ${r.status}. Body: ${body.substring(0, 300)}`);
    }

    const text = await r.text();
    console.log(`[api] raw response: ${text.substring(0, 200)}`);
    const data = decodeApiResponse(text);
    let src = data.src || "";
    if (src.startsWith("/")) src = "https://vixsrc.to" + src;
    console.log(`[api] embed src: ${src}`);
    return src;
  }

  let src = await getEmbedUrl();

  // 3. Fetch embed page
  let r2 = await fetchWithFallback(
    src,
    {
      headers: {
        ...BASE_HEADERS,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        Referer: "https://vixsrc.to/",
        Cookie: cookieStr,
        "sec-fetch-dest": "iframe",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
      },
    },
    "embed"
  );

  // Retry on 410
  if (r2.status === 410) {
    console.log("[embed] Got 410, refreshing embed URL...");
    src = await getEmbedUrl();
    r2 = await fetchWithFallback(
      src,
      {
        headers: {
          ...BASE_HEADERS,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          Referer: "https://vixsrc.to/",
          Cookie: cookieStr,
          "sec-fetch-dest": "iframe",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "same-origin",
        },
      },
      "embed-retry"
    );
  }

  if (r2.status !== 200 && r2.status !== 304) {
    throw new Error(`Embed page returned ${r2.status}`);
  }

  const html = await r2.text();
  console.log(`[embed] html length: ${html.length}, has masterPlaylist: ${html.includes("masterPlaylist")}`);

  const playlistUrl = parseMasterPlaylist(html);
  if (!playlistUrl) throw new Error("Could not extract playlist URL from embed page");
  console.log(`[playlist] url: ${playlistUrl}`);

  // 4. Fetch M3U8
  const r3 = await fetchWithFallback(
    playlistUrl,
    {
      headers: {
        ...BASE_HEADERS,
        Accept: "*/*",
        Referer: src,
        Cookie: cookieStr,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
    },
    "m3u8"
  );

  if (!r3.ok) throw new Error(`Playlist fetch returned ${r3.status}`);
  const m3u8 = await r3.text();

  return { master_m3u8: playlistUrl, raw_m3u8: m3u8 };
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", usage: "GET /stream?id=<tmdb_movie_id>" });
});

app.get("/stream", async (req, res) => {
  const movieId = req.query.id;
  if (!movieId) {
    return res.status(400).json({ error: "Missing ?id= parameter. Example: /stream?id=280" });
  }

  try {
    const result = await getStream(movieId);
    res.json(result);
  } catch (err) {
    console.error(`[ERROR] id=${movieId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
