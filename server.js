const express = require("express");
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
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
    "https://api.groq.com/openai/v1/chat/completions",
    { model: "llama3-8b-8192", messages: [{ role: "user", content: s.prompt_base }], max_tokens: 60, temperature: 0.9 },
    { headers: { Authorization: `Bearer ${s.groq_key}` } }
  );
  const roteiro = r.data.choices[0].message.content.trim().toUpperCase();
  adicionarHistorico({ status: "Roteiro Criado", details: "IA gerou o roteiro.", roteiro });
  return roteiro;
}

async function gerarAudio(texto, s) {
  adicionarHistorico({ status: "Gerando Audio", details: "Sintetizando voz no ElevenLabs..." });
  const r = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${s.eleven_voice_id}`,
    { text: texto, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.45, similarity_boost: 0.80 } },
    { headers: { "xi-api-key": s.eleven_key, "Content-Type": "application/json" }, responseType: "arraybuffer" }
  );
  const audioPath = `./videos/audio_${Date.now()}.mp3`;
  fs.writeFileSync(audioPath, Buffer.from(r.data));
  adicionarHistorico({ status: "Audio Pronto", details: "Voz gerada com sucesso." });
  return audioPath;
}

async function gerarVideo(texto, audioPath, s) {
  adicionarHistorico({ status: "Gerando Video", details: "Renderizando vídeo com FFmpeg..." });
  const videoPath = `./videos/video_${Date.now()}.mp4`;
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(audioPath)
      .inputOptions(["-f lavfi"])
      .input("color=c=black:s=1080x1920:r=30")
      .complexFilter([
        `drawtext=text='${texto.replace(/'/g, "\\'")}':fontcolor=white:fontsize=60:x=(w-text_w)/2:y=(h-text_h)/2:font=Arial:fontweight=bold:borderw=3:bordercolor=black`
      ])
      .outputOptions(["-map 1:v", "-map 0:a", "-shortest", "-c:v libx264", "-c:a aac", "-pix_fmt yuv420p"])
      .output(videoPath)
      .on("end", () => {
        adicionarHistorico({ status: "Video Pronto", details: "Vídeo renderizado com sucesso." });
        resolve(videoPath);
      })
      .on("error", reject)
      .run();
  });
}

async function publicarInstagram(videoPath, texto, s) {
  adicionarHistorico({ status: "Publicando", details: "Enviando para o Instagram..." });
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
}

async function executarFluxoCompleto() {
  const s = lerSettings();
  const roteiro = await gerarRoteiro(s);
  const audioPath = await gerarAudio(roteiro, s);
  const videoPath = await gerarVideo(roteiro, audioPath, s);
  await publicarInstagram(videoPath, roteiro, s);
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
