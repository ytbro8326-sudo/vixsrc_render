import express from "express";
import { SocksProxyAgent } from "socks-proxy-agent";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

const TOR_SOCKS = "socks5h://127.0.0.1:9050";
let torReady = false;

// ── Start Tor ─────────────────────────────────────────────────────────────────
async function startTor() {
  try {
    try {
      await execAsync("which tor");
      console.log("[tor] already installed");
    } catch {
      console.log("[tor] installing...");
      await execAsync("apt-get update -qq && apt-get install -y tor netcat-openbsd 2>&1");
    }

    const torrc = `SocksPort 9050\nControlPort 9051\nCookieAuthentication 0\nMaxCircuitDirtiness 10\nNewCircuitPeriod 10\n`;
    await execAsync(`printf '%s' '${torrc}' > /etc/tor/torrc`);

    try { await execAsync("pkill tor"); await new Promise(r => setTimeout(r, 1000)); } catch {}

    exec("tor -f /etc/tor/torrc > /tmp/tor.log 2>&1 &");
    console.log("[tor] starting daemon...");

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const { stdout } = await execAsync("grep -i 'Bootstrapped 100' /tmp/tor.log 2>/dev/null || true");
        if (stdout.includes("Bootstrapped 100")) {
          console.log("[tor] ✅ bootstrapped!");
          torReady = true;
          return;
        }
        if (i % 10 === 0) {
          const { stdout: log } = await execAsync("tail -2 /tmp/tor.log 2>/dev/null || true");
          console.log(`[tor] ${i}s ... ${log.trim()}`);
        }
      } catch {}
    }
    console.warn("[tor] ⚠️ did not bootstrap in 60s, trying anyway");
    torReady = true;
  } catch (e) {
    console.error("[tor] startup failed:", e.message);
  }
}

async function rotateTorCircuit() {
  try {
    await execAsync(`echo -e 'AUTHENTICATE ""\\r\\nSIGNAL NEWNYM\\r\\nQUIT' | nc 127.0.0.1 9051`);
    await new Promise(r => setTimeout(r, 2000));
    console.log("[tor] 🔄 new circuit");
  } catch (e) {
    console.warn("[tor] rotate failed:", e.message);
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

// ── Tor fetch with circuit rotation retries ───────────────────────────────────
async function torFetch(url, options = {}, label = "", maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`[${label}] attempt ${i + 1}/${maxRetries} via Tor...`);
      const agent = new SocksProxyAgent(TOR_SOCKS);
      const res = await fetch(url, { ...options, agent, signal: AbortSignal.timeout(20000) });

      if ([403, 429, 502, 503].includes(res.status)) {
        console.log(`[${label}] ❌ ${res.status} — rotating circuit...`);
        await rotateTorCircuit();
        continue;
      }

      console.log(`[${label}] ✅ ${res.status}`);
      return res;
    } catch (e) {
      console.log(`[${label}] 💥 ${e.message.substring(0, 80)} — rotating circuit...`);
      await rotateTorCircuit();
    }
  }
  throw new Error(`Tor failed after ${maxRetries} circuits for: ${url}`);
}

// ── Core logic ────────────────────────────────────────────────────────────────
async function getStream(movieId) {
  if (!torReady) {
    console.log("[getStream] waiting for Tor...");
    for (let i = 0; i < 60; i++) {
      if (torReady) break;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 1. Warmup
  const r1 = await torFetch(
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
    const r = await torFetch(
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
  let r2 = await torFetch(
    src,
    { headers: { ...BASE_HEADERS, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", Referer: "https://vixsrc.to/", Cookie: cookieStr, "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" } },
    "embed"
  );

  if (r2.status === 410) {
    src = await getEmbedUrl();
    r2 = await torFetch(src, { headers: { ...BASE_HEADERS, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", Referer: "https://vixsrc.to/", Cookie: cookieStr, "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" } }, "embed-retry");
  }

  if (r2.status !== 200 && r2.status !== 304) throw new Error(`Embed page returned ${r2.status}`);

  const html = await r2.text();
  console.log(`[embed] length=${html.length} hasMasterPlaylist=${html.includes("masterPlaylist")}`);
  const playlistUrl = parseMasterPlaylist(html);
  if (!playlistUrl) throw new Error("Could not extract playlist URL");

  // 4. M3U8
  const r3 = await torFetch(
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
  res.json({ status: "ok", tor: torReady });
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
  console.log(`✅ Server on port ${PORT}`);
  startTor().catch(e => console.error("[tor] error:", e.message));
});
