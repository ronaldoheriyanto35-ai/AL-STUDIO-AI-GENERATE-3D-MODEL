// AL STUDIO AI & GENERATE 3D MODEL: backend Node.js (Express). Butuh Node 18+.
//   POST /api/upload  perantara ke Roblox Open Cloud (Assets API)
//   POST /api/chat    perantara ke API Anthropic untuk asisten Luau
//   GET  /api/health  cek status
const express = require("express");
const multer = require("multer");
const path = require("path");

const app = express();
app.set("trust proxy", 1);
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ---------- Pembatas permintaan sederhana (per IP, di memori) ---------- */
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + " " + req.path, now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return res.status(429).json({ error: "Terlalu banyak permintaan. Coba lagi sebentar." });
    recent.push(now); hits.set(key, recent); next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of hits) if (!a.length || now - a[a.length - 1] > 120000) hits.delete(k);
}, 60000).unref();

/* ---------- Login: bila FIREBASE_API_KEY diisi, semua /api/* wajib login ---------- */
async function requireLogin(req, res, next) {
  const key = process.env.FIREBASE_API_KEY;
  if (!key) return next();
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Masuk dulu untuk memakai fitur ini." });
  try {
    const r = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + encodeURIComponent(key), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }),
    });
    if (!r.ok) return res.status(401).json({ error: "Sesi login tidak valid. Masuk ulang." });
    next();
  } catch (e) {
    res.status(502).json({ error: "Tidak bisa memeriksa login. Coba lagi." });
  }
}

app.get("/api/health", (req, res) =>
  res.json({ ok: true, ai: !!process.env.ANTHROPIC_API_KEY, login: !!process.env.FIREBASE_API_KEY })
);

/* ---------- Upload ke Roblox Open Cloud ---------- */
const API = "https://apis.roblox.com/assets/v1";
const TYPES = {
  decal: { assetType: "Decal", mimes: { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", bmp: "image/bmp", tga: "image/tga" } },
  audio: { assetType: "Audio", mimes: { mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", flac: "audio/flac" } },
  file: { assetType: "Model", mimes: { rbxm: "model/x-rbxm", rbxmx: "model/x-rbxm", fbx: "model/fbx" } },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.post("/api/upload", limit(10, 60000), requireLogin, upload.single("file"), async (req, res) => {
  try {
    const { type, apiKey, target, ownerId, name, description } = req.body;
    const cfg = TYPES[type];
    if (!cfg) return res.status(400).json({ error: "Tipe tidak valid" });
    if (!req.file || !apiKey || !ownerId || !name)
      return res.status(400).json({ error: "File, API key, ID pemilik, dan nama wajib diisi" });

    const ext = req.file.originalname.split(".").pop().toLowerCase();
    const mime = cfg.mimes[ext];
    if (!mime) return res.status(400).json({ error: `Ekstensi .${ext} tidak didukung untuk ${cfg.assetType}` });

    const creator = target === "group" ? { groupId: String(ownerId) } : { userId: String(ownerId) };
    const meta = {
      assetType: cfg.assetType,
      displayName: name.slice(0, 50),
      description: (description || "").slice(0, 1000),
      creationContext: { creator },
    };

    const form = new FormData();
    form.append("request", JSON.stringify(meta));
    form.append("fileContent", new Blob([req.file.buffer], { type: mime }), req.file.originalname);

    const r = await fetch(`${API}/assets`, { method: "POST", headers: { "x-api-key": apiKey }, body: form });
    const op = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: op.message || "Upload ditolak Roblox", detail: op });

    // Tunggu sampai Roblox selesai memproses (termasuk pemeriksaan moderasi)
    const opId = op.path.split("/").pop();
    for (let i = 0; i < 30; i++) {
      await sleep(1500);
      const pr = await fetch(`${API}/operations/${opId}`, { headers: { "x-api-key": apiKey } });
      const st = await pr.json();
      if (st.done) {
        if (st.error) return res.status(400).json({ error: st.error.message || "Moderasi/validasi gagal", detail: st.error });
        const assetId = st.response.assetId;
        return res.json({ ok: true, assetId, name: meta.displayName, url: `https://create.roblox.com/store/asset/${assetId}` });
      }
    }
    res.status(202).json({ error: "Masih diproses Roblox, cek lagi nanti", operationId: opId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Asisten Luau (API Anthropic) ---------- */
const SYSTEM =
  "Kamu adalah asisten pemrograman Luau untuk Roblox di situs AL STUDIO AI & GENERATE 3D MODEL. Jawab dalam bahasa yang dipakai pengguna (default Bahasa Indonesia), singkat dan praktis.\n" +
  "- Tulis kode Luau modern: pakai task.wait/task.spawn, GetService, type annotation bila membantu, hindari API yang sudah usang.\n" +
  "- Selalu taruh kode dalam blok ```lua dan sebutkan di mana script harus ditempatkan (ServerScriptService, StarterPlayerScripts, ReplicatedStorage, dst).\n" +
  "- Untuk perbaikan bug, jelaskan penyebabnya dulu, lalu beri kode yang sudah diperbaiki.\n" +
  "- Ingatkan validasi di server untuk RemoteEvent dan DataStore bila relevan.\n" +
  "- Jangan membuat exploit, cheat, executor, atau script untuk merusak game orang lain. Tawarkan alternatif untuk game milik pengguna sendiri.\n" +
  "Pesan pengguna diawali jenis script yang dipilih.";

app.post("/api/chat", limit(20, 60000), requireLogin, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "Asisten belum aktif: ANTHROPIC_API_KEY belum diisi di server." });
  let msgs = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
  msgs = msgs
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return res.status(400).json({ error: "Pesan tidak valid" });
  if (msgs.reduce((n, m) => n + m.content.length, 0) > 24000) return res.status(413).json({ error: "Pesan terlalu panjang" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: process.env.MODEL || "claude-sonnet-5-5", max_tokens: 2048, system: SYSTEM, messages: msgs }),
    });
    if (r.status === 429) return res.status(429).json({ error: "Batas pemakaian AI tercapai. Coba lagi nanti." });
    if (!r.ok) return res.status(502).json({ error: "Layanan AI sedang bermasalah." });
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    res.json({ text, truncated: data.stop_reason === "max_tokens" });
  } catch (e) {
    res.status(502).json({ error: "Layanan AI tidak terjangkau." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Jalan di http://localhost:${PORT}`));
