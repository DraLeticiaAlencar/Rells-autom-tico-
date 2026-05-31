const express = require("express");
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const { createCanvas } = require("canvas");

const app = express();
app.use(express.json());
app.use(express.static("public"));
app.use("/videos", express.static("videos"));

const SETTINGS_FILE = "./data/settings.json";
const HISTORY_FILE  = "./data/history.json";

fs.ensureDirSync("./data");
fs.ensureDirSync("./videos");
fs.ensureDirSync("./public");

const DEFAULT_SETTINGS = {
  openai_key: "",
  prompt_base: "Crie um gancho poderoso de 1 frase para um Reels sobre relacionamento e autoestima feminina. Deve ser impactante, em caixa alta, máximo 12 palavras. Responda apenas com a frase.",
  eleven_key: "",
  eleven_voice_id: "",
  instagram_token: "",
  instagram_account_id: "",
  server_domain: "",
  schedules: ["08:00","12:00","17:00","21:00"],
  automation_active: false
};

function lerSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) fs.writeJsonSync(SETTINGS_FILE, DEFAULT_SETTINGS, { spaces: 2 });
  return fs.readJsonSync(SETTINGS_FILE);
}
function salvarSettings(d) { fs.writeJsonSync(SETTINGS_FILE, d, { spaces: 2 }); }
function lerHistorico() { if (!fs.existsSync(HISTORY_FILE)) return []; return fs.readJsonSync(HISTORY_FILE); }
function adicionarHistorico(entrada) {
  const h = lerHistorico();
  h.unshift({ ...entrada, timestamp: new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) });
  fs.writeJsonSync(HISTORY_FILE, h.slice(0, 50), { spaces: 2 });
}

app.get("/api/settings", (req, res) => res.json(lerSettings()));
app.post("/api/settings", (req, res) => { salvarSettings(req.body); res.json({ message: "✅ Configurações salvas!" }); });
app.get("/api/history", (req, res) => res.json(lerHistorico()));
app.post("/api/force-trigger", async (req, res) => {
  res.json({ message: "🚀 Processo iniciado!" });
  executarFluxoCompleto().catch(console.error);
});

async function gerarRoteiro(s) {
  adicionarHistorico({ status: "Gerando Roteiro", details: "Pedindo roteiro para a IA..." });
  const r = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    { model: "gpt-4o-mini", messages: [{ role: "user", content: s.prompt_base }], max_tokens: 60, temperature: 0.9 },
    { headers: { Authorization: `Bearer ${s.openai_key}` } }
  );
  const roteiro = r.data.choices[0].message.content.trim().toUpperCase();
  adicionarHistorico({ status: "Roteiro Criado", details: "IA gerou o roteiro.", roteiro });
  return roteiro;
}

async function gerarAudio(texto, s) {
  adicionarHistorico({ status: "Gerando Áudio", details: "Sintetizando voz no ElevenLabs..." });
  const r = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${s.eleven_voice_id}`,
    { text: texto, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.35 } },
    { headers: { "xi-api-key": s.eleven_key, "Content-Type": "application/json" }, responseType: "arraybuffer" }
  );
  const audioPath = `./videos/audio_${Date.now()}.mp3`;
  fs.writeFileSync(audioPath, Buffer.from(r.data));
  adicionarHistorico({ status: "Áudio Pronto", details: "Voz gerada com sucesso." });
  return audioPath;
}

async function gerarFramesVideo(texto, duracaoSegundos) {
  adicionarHistorico({ status: "Renderizando Vídeo", details: "Criando frames do vídeo..." });
  const WIDTH = 1080, HEIGHT = 1920, FPS = 30;
  const totalFrames = duracaoSegundos * FPS;
  const framesDir = `./videos/frames_${Date.now()}`;
  fs.ensureDirSync(framesDir);
  const palavras = texto.split(/\s+/);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  for (let i = 0; i < totalFrames; i++) {
    const progresso = i / totalFrames;
    const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    grad.addColorStop(0, "#0a0010");
    grad.addColorStop(1, "#1a0030");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
