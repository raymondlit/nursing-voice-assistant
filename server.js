require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 生产环境强制 HTTPS（Render / Railway 等会传递 x-forwarded-proto）
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    if (proto !== 'https') {
      return res.redirect(`https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/asr' });

/* ---------- WebSocket 语音中继 / 演示模式 ---------- */
wss.on('connection', (ws) => {
  let asrWs = null;
  let demoTimer = null;
  let demoWords = [];
  let demoIndex = 0;

  const sendToClient = (obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  const asrUrl = process.env.ASR_WS_URL;

  // 真实 ASR 模式：建立到外部 ASR 服务的 WebSocket，并双向转发
  if (asrUrl) {
    const headers = {};
    if (process.env.ASR_API_KEY) {
      headers['Authorization'] = `Bearer ${process.env.ASR_API_KEY}`;
    }
    asrWs = new WebSocket(asrUrl, { headers });

    asrWs.on('open', () => console.log('[ASR] connected'));
    asrWs.on('message', (data) => {
      const text = data.toString();
      // 先把原始消息透传给前端
      sendToClient({ type: 'raw', data: text });

      // 尝试解析常见格式
      try {
        const j = JSON.parse(text);
        const t = j.text || j.result || j.transcript || j.data;
        if (t) {
          const isFinal = j.is_final || j.isFinal || j.final || j.end;
          sendToClient({ type: isFinal ? 'final' : 'interim', text: t });
        }
      } catch (e) {}
    });
    asrWs.on('error', (err) => {
      console.error('[ASR] error', err.message);
      sendToClient({ type: 'error', message: err.message });
    });
    asrWs.on('close', () => sendToClient({ type: 'error', message: 'ASR 连接已关闭' }));
  }

  ws.on('message', (data) => {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.type === 'start') {
        if (!asrUrl) startDemo();
      } else if (msg.type === 'stop') {
        stopDemo();
        if (asrWs && asrWs.readyState === WebSocket.OPEN) asrWs.close();
      }
    } else {
      // 二进制 PCM 直接转发
      if (asrWs && asrWs.readyState === WebSocket.OPEN) asrWs.send(data);
    }
  });

  ws.on('close', () => {
    stopDemo();
    if (asrWs && asrWs.readyState === WebSocket.OPEN) asrWs.close();
  });

  function startDemo() {
    const text = process.env.DEMO_TRANSCRIPT || '请补充演示文本';
    demoWords = text.split(/\s+/);
    demoIndex = 0;
    if (demoTimer) clearInterval(demoTimer);
    demoTimer = setInterval(() => {
      if (demoIndex >= demoWords.length) {
        sendToClient({ type: 'final', text: demoWords.join(' ') });
        clearInterval(demoTimer);
        demoTimer = null;
        return;
      }
      const current = demoWords.slice(0, demoIndex + 1).join(' ');
      sendToClient({ type: 'interim', text: current });
      demoIndex++;
    }, 350);
  }

  function stopDemo() {
    if (demoTimer) clearInterval(demoTimer);
    demoTimer = null;
  }
});

/* ---------- AI 护理记录生成 ---------- */
app.post('/api/generate-record', async (req, res) => {
  const { transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: '缺少转写文本' });

  try {
    const record = await generateNursingRecord(transcript);
    res.json(record);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '生成失败', detail: err.message });
  }
});

async function generateNursingRecord(transcript) {
  if (process.env.LLM_API_URL && process.env.LLM_API_KEY) {
    return await generateWithLLM(transcript);
  }
  return generateDemoRecord(transcript);
}

async function generateWithLLM(transcript) {
  const systemPrompt = `你是一名护理文书助手。请根据护士语音转写内容，提取并生成如下结构的 JSON，不要任何解释、不要 markdown 代码块：
{
  "bed_no": "床号",
  "name": "姓名",
  "temperature": 体温数字,
  "pulse": 脉搏数字,
  "respiration": 呼吸数字,
  "blood_pressure": "血压 mmHg",
  "chief_complaint": "主诉",
  "physical_exam": "查体",
  "treatment": "处理意见"
}
规则：
1. 只返回 JSON。
2. 数字字段若未提及返回 null，字符串字段未提及返回空字符串。
3. 不要把 markdown 标记返回进来。`;

  const response = await fetch(process.env.LLM_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `语音转写：\n${transcript}` },
      ],
      temperature: 0.2,
    }),
  });

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content || '';

  // 清洗 markdown
  content = content.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

  let record = safeJsonParse(content);
  if (!record) record = extractFieldsFallback(transcript);
  return normalizeRecord(record);
}

function generateDemoRecord(transcript) {
  return normalizeRecord(extractFieldsFallback(transcript));
}

function extractFieldsFallback(text) {
  const r = {
    bed_no: '',
    name: '',
    temperature: null,
    pulse: null,
    respiration: null,
    blood_pressure: '',
    chief_complaint: '',
    physical_exam: '',
    treatment: '',
  };

  const bed = text.match(/床号[:\s]+(\d+)/);
  if (bed) r.bed_no = bed[1];

  const name = text.match(/(?:姓名|患者)[:\s]+([\u4e00-\u9fa5]{2,4})/);
  if (name) r.name = name[1];

  const t = text.match(/体温[:\s]+(\d+(\.\d+)?)/);
  if (t) r.temperature = parseFloat(t[1]);

  const p = text.match(/脉搏[:\s]+(\d+)/);
  if (p) r.pulse = parseInt(p[1]);

  const resp = text.match(/呼吸[:\s]+(\d+)/);
  if (resp) r.respiration = parseInt(resp[1]);

  const bp = text.match(/血压[:\s]+(\d{2,3}\/\d{2,3})/);
  if (bp) r.blood_pressure = bp[1];

  const cc = text.match(/主诉[:\s]+([^查体处理]+)/);
  if (cc) r.chief_complaint = cc[1].trim();

  const pe = text.match(/查体[:\s]+([^处理]+)/);
  if (pe) r.physical_exam = pe[1].trim();

  const tr = text.match(/处理(?:意见)?[:\s]+(.+)/);
  if (tr) r.treatment = tr[1].trim();

  return r;
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    const m = str.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (e2) {}
    }
  }
  return null;
}

function normalizeRecord(record) {
  const empty = {
    bed_no: '',
    name: '',
    temperature: null,
    pulse: null,
    respiration: null,
    blood_pressure: '',
    chief_complaint: '',
    physical_exam: '',
    treatment: '',
  };
  return { ...empty, ...record };
}

/* ---------- 模拟 HIS 提交 ---------- */
app.post('/api/his/submit', (req, res) => {
  console.log('[HIS] 收到护理记录：');
  console.log(JSON.stringify(req.body, null, 2));
  res.json({ success: true, message: '护理记录已成功提交至 HIS' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));