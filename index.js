import express from "express";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();
const PORT = process.env.PORT || 3000;

// ── Your paid proxies ─────────────────────────────────────────────────────────
const PAID_PROXIES = [
  "http://dxicdysy:yndikr9coeto@31.59.20.176:6754",
  "http://dxicdysy:yndikr9coeto@31.56.127.193:7684",
  "http://dxicdysy:yndikr9coeto@45.38.107.97:6014",
  "http://dxicdysy:yndikr9coeto@198.105.121.200:6462",
  "http://dxicdysy:yndikr9coeto@64.137.96.74:6641",
  "http://dxicdysy:yndikr9coeto@198.23.243.226:6361",
  "http://dxicdysy:yndikr9coeto@38.154.185.97:6370",
  "http://dxicdysy:yndikr9coeto@84.247.60.125:6095",
  "http://dxicdysy:yndikr9coeto@142.111.67.146:5611",
  "http://dxicdysy:yndikr9coeto@191.96.254.138:6185",
];

// ── Free proxy sources ────────────────────────────────────────────────────────
async function fetchFreeProxies() {
  const proxies = [];

  // Source 1: proxifly
  try {
    const r = await fetch("https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.json", {
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) {
      const list = await r.json();
      for (const p of list.slice(0, 100)) {
        if (p.ip && p.port) proxies.push(`http://${p.ip}:${p.port}`);
      }
      console.log(`[free-proxies] proxifly: ${proxies.length} proxies`);
    }
  } catch (e) { console.warn("[free-proxies] proxifly failed:", e.message); }

  // Source 2: TheSpeedX list
  try {
    const r = await fetch("https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", {
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) {
      const text = await r.text();
      const lines = text.trim().split("\n").slice(0, 200);
      for (const line of lines) {
        const [ip, port] = line.trim().split(":");
        if (ip && port) proxies.push(`http://${ip}:${port}`);
      }
      console.log(`[free-proxies] TheSpeedX total now: ${proxies.length}`);
    }
  } catch (e) { console.warn("[free-proxies] TheSpeedX failed:", e.message); }

  // Source 3: clarketm list
  try {
    const r = await fetch("https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt", {
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) {
      const text = await r.text();
      const lines = text.trim().split("\n").slice(0, 100);
      for (const line of lines) {
        const clean = line.trim().split(" ")[0];
        if (clean && clean.includes(":")) proxies.push(`http://${clean}`);
      }
      console.log(`[free-proxies] clarketm total now: ${proxies.length}`);
    }
  } catch (e) { console.warn("[free-proxies] clarketm failed:", e.message); }

  // Source 4: hookzof list
  try {
    const r = await fetch("https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt", {
      signal: AbortSignal.timeout(8000)
    });
    if (r.ok) {
      const text = await r.text();
      const lines = text.trim().split("\n").slice(0, 100);
      for (const line of lines) {
        const clean = line.trim();
        if (clean && clean.includes(":")) proxies.push(`socks5://${clean}`);
      }
      console.log(`[free-proxies] hookzof total now: ${proxies.length}`);
    }
  } catch (e) { console.warn("[free-proxies] hookzof failed:", e.message); }

  // Shuffle and dedupe
  const unique = [...new Set(proxies)].sort(() => Math.random() - 0.5);
  console.log(`[free-proxies] Total unique free proxies: ${unique.length}`);
  return unique;
}

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
  return (baseUrl && token) ? `${baseUrl}?token=${token}&expires=${expires}&h=1&lang=en` : null;
}

// ── Try a single proxy/direct for a URL ──────────────────────────────────────
async function tryFetch(url, options, proxyUrl = null) {
  const fetchOpts = { ...options, signal: AbortSignal.timeout(10000) };
  if (proxyUrl) fetchOpts.agent = new HttpsProxyAgent(proxyUrl);
  const res = await fetch(url, fetchOpts);
  return res;
}

// ── Fetch trying direct then paid then free proxies ───────────────────────────
async function fetchWithFallback(url, options = {}, label = "", freeProxies = []) {
  // Order: direct → paid proxies → free proxies
  const attempts = [
    { label: "direct", proxy: null },
    ...PAID_PROXIES.map(p => ({ label: `paid:${p.split("@")[1]}`, proxy: p })),
    ...freeProxies.map(p => ({ label: `free:${p}`, proxy: p })),
  ];

  for (let i = 0; i < attempts.length; i++) {
    const { label: aLabel, proxy } = attempts[i];
    try {
      process.stdout.write(`[${label}] ${i + 1}/${attempts.length} ${aLabel} ... `);
      const res = await tryFetch(url, options, proxy);

      if (res.status === 403 || res.status === 429 || res.status === 407 || res.status === 502) {
        console.log(`❌ ${res.status}`);
        continue;
      }
      console.log(`✅ ${res.status}`);
      return res;
    } catch (e) {
      console.log(`💥 ${e.message.substring(0, 60)}`);
    }
  }

  throw new Error(`All ${attempts.length} attempts failed for: ${url}`);
}

// ── Core logic ────────────────────────────────────────────────────────────────
async function getStream(movieId) {
  console.log(`\n[getStream] movie=${movieId} — fetching free proxies...`);
  const freeProxies = await fetchFreeProxies();

  // 1. Warmup
  const r1 = await fetchWithFallback(
    `https://vixsrc.to/movie/${movieId}`,
    { headers: { ...BASE_HEADERS, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", "Upgrade-Insecure-Requests": "1" } },
    "warmup", freeProxies
  );

  let cookieStr = "";
  const setCookieHeader = r1.headers.get("set-cookie");
  if (setCookieHeader) {
    cookieStr = setCookieHeader.split(/,(?=[^ ].*?=)/).map(c => c.split(";")[0].trim()).join("; ");
  }
  console.log(`[cookies] ${cookieStr || "(none)"}`);

  // 2. API
  async function getEmbedUrl() {
    const r = await fetchWithFallback(
      `https://vixsrc.to/api/movie/${movieId}`,
      { headers: { ...BASE_HEADERS, Accept: "application/json, text/plain, */*", Referer: `https://vixsrc.to/movie/${movieId}`, Cookie: cookieStr, "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" } },
      "api", freeProxies
    );
    if (!r.ok) { const b = await r.text(); throw new Error(`API ${r.status}: ${b.substring(0, 200)}`); }
    const text = await r.text();
    const data = decodeApiResponse(text);
    let src = data.src || "";
    if (src.startsWith("/")) src = "https://vixsrc.to" + src;
    console.log(`[api] src: ${src}`);
    return src;
  }

  let src = await getEmbedUrl();

  // 3. Embed page
  let r2 = await fetchWithFallback(
    src,
    { headers: { ...BASE_HEADERS, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", Referer: "https://vixsrc.to/", Cookie: cookieStr, "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" } },
    "embed", freeProxies
  );

  if (r2.status === 410) {
    src = await getEmbedUrl();
    r2 = await fetchWithFallback(src, { headers: { ...BASE_HEADERS, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", Referer: "https://vixsrc.to/", Cookie: cookieStr, "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" } }, "embed-retry", freeProxies);
  }

  if (r2.status !== 200 && r2.status !== 304) throw new Error(`Embed page returned ${r2.status}`);

  const html = await r2.text();
  console.log(`[embed] length=${html.length} hasMasterPlaylist=${html.includes("masterPlaylist")}`);
  const playlistUrl = parseMasterPlaylist(html);
  if (!playlistUrl) throw new Error("Could not extract playlist URL");

  // 4. M3U8
  const r3 = await fetchWithFallback(
    playlistUrl,
    { headers: { ...BASE_HEADERS, Accept: "*/*", Referer: src, Cookie: cookieStr, "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" } },
    "m3u8", freeProxies
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
  if (!movieId) return res.status(400).json({ error: "Missing ?id= parameter" });
  try {
    const result = await getStream(movieId);
    res.json(result);
  } catch (err) {
    console.error(`[ERROR]`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
