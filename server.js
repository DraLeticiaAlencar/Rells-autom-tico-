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
const HISTORY_FILE  = "./data/history.json";

fs.ensureDirSync("./data");
fs.ensureDirSync("./videos");

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
    { text: texto, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.45, similarity_boost: 0.80 } },
    { headers: { "xi-api-key": s.eleven_key, "Content-Type": "application/json" }, responseType: "arraybuffer" }
  );
  const audioPath = `./videos/audio_${Date.now()}.mp3`;
  fs.writeFileSync(audioPath, Buffer.from(r.data));
  adicionarHistorico({ status: "Áudio Pronto", details: "Voz gerada com sucesso." });
  return audioPath;
}

async function gerarVideoComTexto(texto, audioPath) {
  adicionarHistorico({ status: "Renderizando Vídeo", details: "Montando vídeo com FFmpeg..." });
  const outputPath = `./videos/reels_${Date.now()}.mp4`;
  const palavras = texto.split(/\s+/);
  const filterLines = [];

  filterLines.push("color=c=black:size=1080x1920:rate=30[base]");

  palavras.forEach((palavra, i) => {
    const inicio = i * 1.5;
    const fim = inicio + 1.5;
    filterLines.push(
      `[base]drawtext=text='${palavra.replace(/'/g, "\\'")}':fontcolor=white:fontsize=110:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,${inicio},${fim})'[base]`
    );
  });

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(audioPath)
      .complexFilter(filterLines.join(";"))
      .outputOptions(["-pix_fmt yuv420p", "-shortest", "-movflags +faststart"])
      .output(outputPath)
      .on("end", () => {
        fs.removeSync(audioPath);
        adicionarHistorico({ status: "Vídeo Pronto", details: "Vídeo gerado com sucesso." });
        resolve(outputPath);
      })
      .on("error", (err) => reject(new Error(`FFmpeg erro: ${err.message}`)))
      .run();
  });
}

async function postarNoInstagram(videoPath, roteiro, s) {
  adicionarHistorico({ status: "Postando", details: "Fazendo upload para o Instagram..." });
  const videoUrl = `${s.server_domain}/videos/${path.basename(videoPath)}`;
  const caption = `${roteiro}\n\n#autoestima #relacionamento #mulherempoderada #viradachave #reels #motivacao`;

  const containerRes = await axios.post(
    `https://graph.facebook.com/v19.0/${s.instagram_account_id}/media`,
    { media_type: "REELS", video_url: videoUrl, caption, share_to_feed: true },
    { params: { access_token: s.instagram_token } }
  );
  const containerId = containerRes.data.id;
  adicionarHistorico({ status: "Postando", details: `Aguardando processamento do Instagram...` });

  let statusCode = "IN_PROGRESS", tentativas = 0;
  while (statusCode !== "FINISHED" && tentativas < 20) {
    await new Promise(r => setTimeout(r, 8000));
    const sr = await axios.get(`https://graph.facebook.com/v19.0/${containerId}`,
      { params: { fields: "status_code", access_token: s.instagram_token } });
    statusCode = sr.data.status_code;
    tentativas++;
    if (statusCode === "ERROR") throw new Error("Instagram rejeitou o vídeo.");
  }

  const publishRes = await axios.post(
    `https://graph.facebook.com/v19.0/${s.instagram_account_id}/media_publish`,
    { creation_id: containerId },
    { params: { access_token: s.instagram_token } }
  );
  adicionarHistorico({ status: "Publicado", details: "✅ Reels publicado!", roteiro, video_url: `https://www.instagram.com/p/${publishRes.data.id}/` });
  setTimeout(() => fs.removeSync(videoPath), 60000);
}

async function executarFluxoCompleto() {
  const s = lerSettings();
  if (!s.openai_key) return adicionarHistorico({ status: "Erro Config", details: "❌ OpenAI Key não configurada." });
  if (!s.eleven_key) return adicionarHistorico({ status: "Erro Config", details: "❌ ElevenLabs Key não configurada." });
  if (!s.eleven_voice_id) return adicionarHistorico({ status: "Erro Config", details: "❌ Voice ID não configurado." });
  if (!s.instagram_token) return adicionarHistorico({ status: "Erro Config", details: "❌ Instagram Token não configurado." });
  if (!s.instagram_account_id) return adicionarHistorico({ status: "Erro Config", details: "❌ Account ID não configurado." });
  if (!s.server_domain) return adicionarHistorico({ status: "Erro Config", details: "❌ Domínio não configurado." });

  try {
    const roteiro = await gerarRoteiro(s);
    const audioPath = await gerarAudio(roteiro, s);
    const videoPath = await gerarVideoComTexto(roteiro, audioPath);
    await postarNoInstagram(videoPath, roteiro, s);
  } catch (err) {
    adicionarHistorico({ status: "Erro", details: `❌ ${err.message}` });
  }
}

cron.schedule("* * * * *", () => {
  const s = lerSettings();
  if (!s.automation_active) return;
  const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false }).slice(0, 5);
  if (s.schedules.includes(agora)) {
    console.log(`[${agora}] ⚡ Disparando fluxo automático...`);
    executarFluxoCompleto().catch(console.error);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 Reels AutoPilot rodando na porta ${PORT}`));
