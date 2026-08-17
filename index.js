import express from "express";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

// ── Tor SOCKS5 proxy ──────────────────────────────────────────────────────────
const TOR_SOCKS = "socks5h://127.0.0.1:9050";
const TOR_CONTROL_PORT = 9051;
const TOR_CONTROL_PASS = ""; // empty = no password (we use CookieAuth or no auth)

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

// ── Start Tor ─────────────────────────────────────────────────────────────────
let torReady = false;

async function startTor() {
  try {
    // Install tor if not present
    console.log("[tor] Checking tor installation...");
    try {
      await execAsync("which tor");
      console.log("[tor] tor already installed");
    } catch {
      console.log("[tor] Installing tor...");
      await execAsync("apt-get update -qq && apt-get install -y tor 2>&1");
      console.log("[tor] tor installed");
    }

    // Write torrc with control port enabled (no password)
    const torrc = `
SocksPort 9050
ControlPort 9051
CookieAuthentication 0
HashedControlPassword ""
MaxCircuitDirtiness 10
NewCircuitPeriod 10
`;
    await execAsync(`echo '${torrc}' > /etc/tor/torrc`);

    // Kill any existing tor process
    try { await execAsync("pkill tor"); await new Promise(r => setTimeout(r, 1000)); } catch {}

    // Start tor in background
    console.log("[tor] Starting tor daemon...");
    exec("tor -f /etc/tor/torrc > /tmp/tor.log 2>&1 &");

    // Wait for tor to bootstrap (up to 60s)
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const { stdout } = await execAsync("cat /tmp/tor.log 2>/dev/null | grep -i 'Bootstrapped 100'");
        if (stdout.includes("Bootstrapped 100")) {
          console.log("[tor] ✅ Tor bootstrapped successfully!");
          torReady = true;
          return true;
        }
        if (i % 5 === 0) {
          const { stdout: log } = await execAsync("tail -3 /tmp/tor.log 2>/dev/null || echo 'no log'");
          console.log(`[tor] waiting... (${i}s) ${log.trim()}`);
        }
      } catch {}
    }

    console.warn("[tor] ⚠️ Tor did not bootstrap in 60s, will try anyway");
    torReady = true;
    return false;
  } catch (e) {
    console.error("[tor] Failed to start tor:", e.message);
    return false;
  }
}

// Rotate Tor circuit (get new exit IP)
async function rotateTorCircuit() {
  try {
    await execAsync(`echo -e 'AUTHENTICATE ""\r\nSIGNAL NEWNYM\r\nQUIT' | nc 127.0.0.1 ${TOR_CONTROL_PORT}`);
    await new Promise(r => setTimeout(r, 2000)); // wait for new circuit
    console.log("[tor] 🔄 Circuit rotated");
  } catch (e) {
    console.warn("[tor] Could not rotate circuit:", e.message);
  }
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

// ── Single fetch attempt ──────────────────────────────────────────────────────
async function tryFetch(url, options, agentUrl = null) {
  const fetchOpts = { ...options, signal: AbortSignal.timeout(15000) };
  if (agentUrl) {
    fetchOpts.agent = agentUrl.startsWith("socks")
      ? new SocksProxyAgent(agentUrl)
      : new HttpsProxyAgent(agentUrl);
  }
  return await fetch(url, fetchOpts);
}

// ── Fetch with full fallback chain ────────────────────────────────────────────
async function fetchWithFallback(url, options = {}, label = "") {
  // Build attempt list
  const attempts = [
    { name: "direct",    agent: null },
    { name: "tor",       agent: TOR_SOCKS },
    ...PAID_PROXIES.map((p, i) => ({ name: `paid-${i + 1}`, agent: p })),
  ];

  for (let i = 0; i < attempts.length; i++) {
    const { name, agent } = attempts[i];
    try {
      process.stdout.write(`[${label}] ${i + 1}/${attempts.length} via ${name} ... `);
      const res = await tryFetch(url, options, agent);

      if ([403, 407, 429, 502, 503].includes(res.status)) {
        console.log(`❌ ${res.status}`);
        // Rotate Tor circuit if Tor just failed
        if (name === "tor") await rotateTorCircuit();
        continue;
      }

      console.log(`✅ ${res.status}`);
      return res;
    } catch (e) {
      console.log(`💥 ${e.message.substring(0, 80)}`);
    }
  }

  // Last resort: retry Tor with 3 fresh circuits
  console.log(`[${label}] Trying Tor with 3 fresh circuits...`);
  for (let i = 0; i < 3; i++) {
    await rotateTorCircuit();
    try {
      process.stdout.write(`[${label}] Tor circuit ${i + 1}/3 ... `);
      const res = await tryFetch(url, options, TOR_SOCKS);
      if (![403, 407, 429, 502, 503].includes(res.status)) {
        console.log(`✅ ${res.status}`);
        return res;
      }
      console.log(`❌ ${res.status}`);
    } catch (e) {
      console.log(`💥 ${e.message.substring(0, 80)}`);
    }
  }

  throw new Error(`All attempts failed for: ${url}`);
}

// ── Core logic ────────────────────────────────────────────────────────────────
async function getStream(movieId) {
  // Wait for Tor if still starting
  if (!torReady) {
    console.log("[getStream] Waiting for Tor to be ready...");
    for (let i = 0; i < 30; i++) {
      if (torReady) break;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 1. Warmup
  const r1 = await fetchWithFallback(
    `https://vixsrc.to/movie/${movieId}`,
    { headers: { ...BASE_HEADERS, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", "Upgrade-Insecure-Requests": "1" } },
    "warmup"
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
      "api"
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
    "embed"
  );

  if (r2.status === 410) {
    src = await getEmbedUrl();
    r2 = await fetchWithFallback(src, { headers: { ...BASE_HEADERS, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", Referer: "https://vixsrc.to/", Cookie: cookieStr, "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" } }, "embed-retry");
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
    "m3u8"
  );

  if (!r3.ok) throw new Error(`Playlist fetch returned ${r3.status}`);
  const m3u8 = await r3.text();
  return { master_m3u8: playlistUrl, raw_m3u8: m3u8 };
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", tor: torReady, usage: "GET /stream?id=<tmdb_movie_id>" });
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

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  // Start Tor in background — don't block server startup
  startTor().catch(e => console.error("[tor] startup error:", e.message));
});
