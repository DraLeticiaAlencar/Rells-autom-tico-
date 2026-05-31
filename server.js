const express = require("express");
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
const { execSync } = require("child_process");
const ffmpeg = require("fluent-ffmpeg");
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
app.use(express.json());
app.use(express.static("public"));
app.use("/videos", express.static("videos"));

const SETTINGS_FILE = "./data/settings.json";
const HISTORY_FILE = "./data/history.json";

fs.ensureDirSync("./data");
fs.ensureDirSync("./videos");

const DEFAULT_SETTINGS = {
  groq_key: "",
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
  const s = fs.readJsonSync(SETTINGS_FILE);
  if (process.env.GROQ_KEY) s.groq_key = process.env.GROQ_KEY;
  if (process.env.ELEVEN_KEY) s.eleven_key = process.env.ELEVEN_KEY;
  if (process.env.ELEVEN_VOICE_ID) s.eleven_voice_id = process.env.ELEVEN_VOICE_ID;
  if (process.env.INSTAGRAM_TOKEN) s.instagram_token = process.env.INSTAGRAM_TOKEN;
  if (process.env.INSTAGRAM_ACCOUNT_ID) s.instagram_account_id = process.env.INSTAGRAM_ACCOUNT_ID;
  if (process.env.SERVER_DOMAIN) s.server_domain = process.env.SERVER_DOMAIN;
  return s;
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
  if (!s.groq_key) throw new Error("Groq API Key não configurada.");
  adicionarHistorico({ status: "Gerando Roteiro", details: "Pedindo roteiro para a IA..." });
  try {
    const r = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      { model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: s.prompt_base }], max_tokens: 60, temperature: 0.9 },
      { headers: { Authorization: `Bearer ${s.groq_key}` }, timeout: 30000 }
    );
    const roteiro = r.data.choices[0].message.content.trim().toUpperCase();
    adicionarHistorico({ status: "Roteiro Criado", details: "IA gerou o roteiro.", roteiro });
    return roteiro;
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message || "Erro desconhecido";
    throw new Error(`Groq: ${msg}`);
  }
}

async function gerarAudio(texto, s) {
  adicionarHistorico({ status: "Gerando Audio", details: "Sintetizando voz..." });
  const audioPath = `./videos/audio_${Date.now()}.mp3`;
  const gTTS = require("node-gtts")("pt");
  await new Promise((resolve, reject) => {
    gTTS.save(audioPath, texto, (err) => err ? reject(err) : resolve());
  });
  adicionarHistorico({ status: "Audio Pronto", details: "Voz gerada com sucesso." });
  return audioPath;
}
async function gerarVideo(texto, audioPath, s) {
  adicionarHistorico({ status: "Gerando Video", details: "Renderizando vídeo com FFmpeg..." });
  const videoPath = `./videos/video_${Date.now()}.mp4`;
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input("color=c=black:s=1080x1920:r=30")
      .inputFormat("lavfi")
      .input(audioPath)
      .outputOptions(["-map 0:v", "-map 1:a", "-shortest", "-c:v libx264", "-c:a aac", "-pix_fmt yuv420p"])
      .output(videoPath)
      .on("end", () => {
        adicionarHistorico({ status: "Video Pronto", details: "Vídeo renderizado com sucesso." });
        resolve(videoPath);
      })
      .on("error", (e) => reject(new Error(`FFmpeg: ${e.message}`)))
      .run();
  });
}

async function publicarInstagram(videoPath, texto, s) {
  if (!s.instagram_token || !s.instagram_account_id || !s.server_domain) throw new Error("Configurações do Instagram incompletas.");
  adicionarHistorico({ status: "Publicando", details: "Enviando para o Instagram..." });
  try {
    const videoUrl = `${s.server_domain}/videos/${path.basename(videoPath)}`;
    const r1 = await axios.post(
      `https://graph.facebook.com/v19.0/${s.instagram_account_id}/media`,
      { media_type: "REELS", video_url: videoUrl, caption: texto, access_token: s.instagram_token }
    );
    const containerId = r1.data.id;
    await new Promise(r => setTimeout(r, 30000));
    await axios.post(
      `https://graph.facebook.com/v19.0/${s.instagram_account_id}/media_publish`,
      { creation_id: containerId, access_token: s.instagram_token }
    );
    adicionarHistorico({ status: "Publicado!", details: "Reels publicado com sucesso no Instagram! ✅" });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    throw new Error(`Instagram: ${msg}`);
  }
}

async function executarFluxoCompleto() {
  try {
    const s = lerSettings();
    const roteiro = await gerarRoteiro(s);
    const audioPath = await gerarAudio(roteiro, s);
    const videoPath = await gerarVideo(roteiro, audioPath, s);
    await publicarInstagram(videoPath, roteiro, s);
  } catch (e) {
    console.error("Erro no fluxo:", e.message);
    adicionarHistorico({ status: "Erro", details: e.message });
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

const jobs = [];
function configurarAgendamentos() {
  jobs.forEach(j => j.stop());
  jobs.length = 0;
  const s = lerSettings();
  if (!s.automation_active) return;
  s.schedules.forEach(horario => {
    const [h, m] = horario.split(":");
    const job = cron.schedule(`${m} ${h} * * *`, () => {
      executarFluxoCompleto().catch(console.error);
    }, { timezone: "America/Sao_Paulo" });
    jobs.push(job);
  });
}

configurarAgendamentos();
