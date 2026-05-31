const express = require("express");
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const { execSync } = require("child_process");
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
  execSync(`npx edge-tts --voice pt-BR-FranciscaNeural --text "${texto.replace(/"/g, ' ')}" --write-media ${audioPath}`, { timeout: 30000 });
  adicionarHistorico({ status: "Audio Pronto", details: "Voz gerada com sucesso." });
  return audioPath;
}

async function baixarMusica() {
  const musicPath = "./videos/musica.mp3";
  if (fs.existsSync(musicPath)) return musicPath;
  const musicas = [
    "https://cdn.pixabay.com/download/audio/2022/05/27/audio_1808fbf07a.mp3",
    "https://cdn.pixabay.com/download/audio/2021/11/25/audio_5bac3aa40c.mp3",
    "https://cdn.pixabay.com/download/audio/2022/03/10/audio_c8c8a73467.mp3"
  ];
  const url = musicas[Math.floor(Math.random() * musicas.length)];
  const r = await axios.get(url, { responseType: "arraybuffer" });
  fs.writeFileSync(musicPath, Buffer.from(r.data));
  return musicPath;
}

async function gerarVideo(texto, audioPath, s) {
  adicionarHistorico({ status: "Gerando Video", details: "Renderizando vídeo com FFmpeg..." });
  const videoPath = `./videos/video_${Date.now()}.mp4`;
  const textoLegenda = texto
    .replace(/'/g, " ")
    .replace(/:/g, "\\:")
    .replace(/"/g, " ")
    .replace(/,/g, "\\,");
  const musicPath = await baixarMusica();
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input("color=c=black:s=720x1280:r=24:d=30")
      .inputFormat("lavfi")
      .input(audioPath)
      .input(musicPath)
      .outputOptions([
        "-filter_complex",
        `[1:a]volume=1.0[a1];[2:a]volume=0.3[a2];[a1][a2]amix=inputs=2:duration=shortest[aout];[0:v]drawtext=text='${textoLegenda}':fontcolor=white:fontsize=45:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.6:boxborderw=15[vout]`,
        "-map", "[vout]",
        "-map", "[aout]",
        "-t", "30",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-pix_fmt", "yuv420p"
      ])
      .output(videoPath)
      .on("end", () => {
        adicionarHistorico({ status: "Video Pronto", details: "Vídeo renderizado com sucesso." });
        resolve(videoPath);
      })
      .on("error", (e) => reject(new Error(`FFmpeg: ${e.message}`)))
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

    // Aguarda até 3 minutos verificando o status
    let tentativas = 0;
    let pronto = false;
    while (tentativas < 18) {
      await new Promise(r => setTimeout(r, 10000));
      const status = await axios.get(
        `https://graph.facebook.com/v19.0/${containerId}?fields=status_code&access_token=${s.instagram_token}`
      );
      adicionarHistorico({ status: "Publicando", details: `Instagram processando... (${(tentativas + 1) * 10}s)` });
      if (status.data.status_code === "FINISHED") {
        pronto = true;
        break;
      }
      tentativas++;
    }

    if (!pronto) throw new Error("Instagram demorou demais para processar o vídeo.");

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

configurarAgendamentos(
