import express from "express";
import { SocksProxyAgent } from "socks-proxy-agent";
import { spawn } from "child_process";
import { promisify } from "util";
import { exec } from "child_process";
import { writeFileSync, mkdirSync } from "fs";

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

const TOR_SOCKS = "socks5h://127.0.0.1:9050";
let torReady = false;
let torLog = [];

function log(msg) {
  torLog.push(msg);
  if (torLog.length > 100) torLog.shift();
  console.log(msg);
}

async function startTor() {
  try {
    // tor is installed at build time — find it
    let torBin = null;
    const candidates = ["/usr/bin/tor", "/usr/sbin/tor", "/usr/local/bin/tor"];
    for (const bin of candidates) {
      try { await execAsync(`test -f ${bin}`); torBin = bin; break; } catch {}
    }
    if (!torBin) {
      try { const { stdout } = await execAsync("which tor"); torBin = stdout.trim(); } catch {}
    }
    if (!torBin) { log("[tor] FATAL: tor binary not found — was it installed at build time?"); return; }
    log(`[tor] binary: ${torBin}`);

    // Write torrc and data dir to /tmp
    const dataDir = "/tmp/tor-data";
    mkdirSync(dataDir, { recursive: true });
    const torrcPath = "/tmp/torrc";
    writeFileSync(torrcPath, [
      "SocksPort 9050",
      "ControlPort 9051",
      "CookieAuthentication 0",
      `DataDirectory ${dataDir}`,
      "Log notice stderr",
      "MaxCircuitDirtiness 10",
      "NewCircuitPeriod 10",
    ].join("\n"));
    log(`[tor] torrc written`);

    try { await execAsync("pkill -9 tor 2>/dev/null"); } catch {}
    await new Promise(r => setTimeout(r, 500));

    const torProc = spawn(torBin, ["-f", torrcPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    log(`[tor] spawned PID ${torProc.pid}`);

    const onData = (data) => {
      for (const line of data.toString().split("\n").filter(l => l.trim())) {
        log(`[tor] ${line}`);
        if (line.includes("Bootstrapped 100")) { torReady = true; log("[tor] ✅ READY!"); }
      }
    };
    torProc.stdout.on("data", onData);
    torProc.stderr.on("data", onData);
    torProc.on("error", e => log(`[tor] spawn error: ${e.message}`));
    torProc.on("exit", (code, sig) => { log(`[tor] exited code=${code} sig=${sig}`); torReady = false; });

    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (torReady) return;
    }
    log("[tor] ⚠️ timed out after 120s");
  } catch (e) {
    log("[tor] exception: " + e.message);
  }
}

async function rotateTorCircuit() {
  try {
    await execAsync(`echo -e 'AUTHENTICATE ""\\r\\nSIGNAL NEWNYM\\r\\nQUIT' | nc -q1 127.0.0.1 9051 2>/dev/null || true`);
    await new Promise(r => setTimeout(r, 3000));
    log("[tor] 🔄 rotated");
  } catch (e) { log("[tor] rotate failed: " + e.message); }
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const BASE_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

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

async function torFetch(url, options = {}, label = "", maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      log(`[${label}] attempt ${i + 1}/${maxRetries}`);
      const agent = new SocksProxyAgent(TOR_SOCKS);
      const res = await fetch(url, { ...options, agent, signal: AbortSignal.timeout(20000) });
      if ([403, 429, 502, 503].includes(res.status)) {
        log(`[${label}] ❌ ${res.status} — rotating...`);
        await rotateTorCircuit();
        continue;
      }
      log(`[${label}] ✅ ${res.status}`);
      return res;
    } catch (e) {
      log(`[${label}] 💥 ${e.message.slice(0, 100)}`);
      await rotateTorCircuit();
    }
  }
  throw new Error(`Tor failed after ${maxRetries} attempts for: ${url}`);
}

async function getStream(movieId) {
  if (!torReady) {
    log("[getStream] waiting for Tor...");
    for (let i = 0; i < 120; i++) {
      if (torReady) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!torReady) throw new Error("Tor not ready — check /tor-log");
  }

  const r1 = await torFetch(
    `https://vixsrc.to/movie/${movieId}`,
    { headers: { ...BASE_HEADERS, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", "Upgrade-Insecure-Requests": "1" } },
    "warmup"
  );

  let cookieStr = "";
  const sc = r1.headers.get("set-cookie");
  if (sc) cookieStr = sc.split(/,(?=[^ ].*?=)/).map(c => c.split(";")[0].trim()).join("; ");

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
    { headers: { ...BASE_HEADERS, Accept: "*/*", Referer: src, Cookie: cookieStr } },
    "m3u8"
  );

  if (!r3.ok) throw new Error(`Playlist fetch returned ${r3.status}`);
  return { master_m3u8: playlistUrl, raw_m3u8: await r3.text() };
}

app.get("/", (req, res) => res.json({ status: "ok", tor: torReady }));
app.get("/tor-log", (req, res) => res.json({ ready: torReady, log: torLog }));
app.get("/stream", async (req, res) => {
  const movieId = req.query.id;
  if (!movieId) return res.status(400).json({ error: "Missing ?id=" });
  try { res.json(await getStream(movieId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log(`✅ Server on port ${PORT}`);
  startTor().catch(e => log("[tor] fatal: " + e.message));
});
