import express from "express";
import { SocksProxyAgent } from "socks-proxy-agent";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { writeFileSync } from "fs";

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

const TOR_SOCKS = "socks5h://127.0.0.1:9050";
let torReady = false;
let torLog = [];

// ── Start Tor ─────────────────────────────────────────────────────────────────
async function startTor() {
  try {
    // Install tor + deps
    console.log("[tor] installing tor...");
    const { stdout: installOut } = await execAsync(
      "apt-get update -qq 2>&1 && apt-get install -y tor netcat-openbsd 2>&1"
    );
    console.log("[tor] install done:", installOut.slice(-100));

    // Write torrc directly with fs
    const torrc = [
      "SocksPort 9050",
      "ControlPort 9051",
      "CookieAuthentication 0",
      "MaxCircuitDirtiness 10",
      "NewCircuitPeriod 10",
      "Log notice stdout",
    ].join("\n");
    writeFileSync("/etc/tor/torrc", torrc);
    console.log("[tor] torrc written");

    // Kill old tor
    try { await execAsync("pkill -9 tor"); } catch {}
    await new Promise(r => setTimeout(r, 1000));

    // Spawn tor and capture stdout
    const torProc = spawn("tor", ["-f", "/etc/tor/torrc"], { stdio: ["ignore", "pipe", "pipe"] });

    torProc.stdout.on("data", (data) => {
      const line = data.toString().trim();
      torLog.push(line);
      if (torLog.length > 50) torLog.shift();
      console.log("[tor]", line);
      if (line.includes("Bootstrapped 100%") || line.includes("Bootstrapped 100 percent")) {
        torReady = true;
        console.log("[tor] ✅ READY!");
      }
    });

    torProc.stderr.on("data", (data) => {
      const line = data.toString().trim();
      torLog.push("[stderr] " + line);
      console.log("[tor stderr]", line);
      if (line.includes("Bootstrapped 100")) {
        torReady = true;
        console.log("[tor] ✅ READY (from stderr)!");
      }
    });

    torProc.on("exit", (code) => {
      console.log(`[tor] process exited with code ${code}`);
      torReady = false;
    });

    // Wait up to 120s
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (torReady) return;
      if (i % 15 === 0) console.log(`[tor] waiting... ${i}s`);
    }

    console.warn("[tor] ⚠️ 120s passed, marking ready anyway");
    torReady = true;

  } catch (e) {
    console.error("[tor] startup failed:", e.message);
  }
}

async function rotateTorCircuit() {
  try {
    await execAsync(`echo -e 'AUTHENTICATE ""\\r\\nSIGNAL NEWNYM\\r\\nQUIT' | nc -q1 127.0.0.1 9051 2>/dev/null || true`);
    await new Promise(r => setTimeout(r, 3000));
    console.log("[tor] 🔄 circuit rotated");
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

// ── Tor fetch with retries ────────────────────────────────────────────────────
async function torFetch(url, options = {}, label = "", maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`[${label}] attempt ${i + 1}/${maxRetries}`);
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
      console.log(`[${label}] 💥 ${e.message.slice(0, 80)} — rotating...`);
      await rotateTorCircuit();
    }
  }
  throw new Error(`Tor failed after ${maxRetries} attempts for: ${url}`);
}

// ── Core logic ────────────────────────────────────────────────────────────────
async function getStream(movieId) {
  if (!torReady) {
    console.log("[getStream] waiting for Tor...");
    for (let i = 0; i < 120; i++) {
      if (torReady) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!torReady) throw new Error("Tor not ready yet — check /tor-log and retry in 30s");
  }

  const r1 = await torFetch(
    `https://vixsrc.to/movie/${movieId}`,
    { headers: { ...BASE_HEADERS, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", "Upgrade-Insecure-Requests": "1" } },
    "warmup"
  );

  let cookieStr = "";
  const sc = r1.headers.get("set-cookie");
  if (sc) cookieStr = sc.split(/,(?=[^ ].*?=)/).map(c => c.split(";")[0].trim()).join("; ");
  console.log(`[cookies] ${cookieStr || "(none)"}`);

  async function getEmbedUrl() {
    const r = await torFetch(
      `https://vixsrc.to/api/movie/${movieId}`,
      { headers: { ...BASE_HEADERS, Accept: "application/json, text/plain, */*", Referer: `https://vixsrc.to/movie/${movieId}`, Cookie: cookieStr, "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" } },
      "api"
    );
    if (!r.ok) { const b = await r.text(); throw new Error(`API ${r.status}: ${b.slice(0, 200)}`); }
    const data = decodeApiResponse(await r.text());
    let src = data.src || "";
    if (src.startsWith("/")) src = "https://vixsrc.to" + src;
    console.log(`[api] src: ${src}`);
    return src;
  }

  let src = await getEmbedUrl();

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
  const playlistUrl = parseMasterPlaylist(html);
  if (!playlistUrl) throw new Error("Could not extract playlist URL");

  const r3 = await torFetch(
    playlistUrl,
    { headers: { ...BASE_HEADERS, Accept: "*/*", Referer: src, Cookie: cookieStr, "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" } },
    "m3u8"
  );

  if (!r3.ok) throw new Error(`Playlist fetch returned ${r3.status}`);
  return { master_m3u8: playlistUrl, raw_m3u8: await r3.text() };
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", tor: torReady });
});

// Debug route — see raw tor log
app.get("/tor-log", (req, res) => {
  res.json({ ready: torReady, log: torLog });
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
