import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const {
  PORT = 4000,
  OPENAI_API_KEY,
  PROXY_BASE_URL,          // ej: https://gptsp.azurewebsites.net
  PROXY_API_KEY,           // x-api-key del proxy
  DEFAULT_PATH_PREFIX = 'General/Desarrollo_organizacional/Manuales',
  TOP_K_DEFAULT = '6'
} = process.env;

if (!OPENAI_API_KEY || !PROXY_BASE_URL || !PROXY_API_KEY) {
  console.error('Faltan variables: OPENAI_API_KEY, PROXY_BASE_URL, PROXY_API_KEY');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => res.json({ ok: true, service: 'arco-backend' }));

async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await resp.text();
    const data = text ? JSON.parse(text) : {};
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}`);
      err.status = resp.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally { clearTimeout(id); }
}

function buildPrompt(query, retrieve) {
  const snippets = retrieve?.snippets || [];
  const sources = snippets.map(s => `• ${s.file?.name} — ${s.file?.webUrl}`).join('\n');
  const context = retrieve?.combinedContext || snippets.map(s => s.text).join('\n---\n') || '';
  return `Eres un asistente de ARCO. Usa SOLO el contexto para responder.
Si no hay información suficiente, dilo y sugiere dónde encontrarla. Cita fuentes al final.

[Contexto]
${context || '(sin resultados de contexto)'}

[Pregunta]
${query}

[Fuentes sugeridas]
${sources || '(si no hay fuentes, omite esta sección en la respuesta)'}`;
}

app.post('/chat', async (req, res) => {
  try {
    const { query, pathPrefix, topK, fileTypes } = req.body || {};
    if (!query || typeof query !== 'string') return res.status(400).json({ error: 'Falta "query" (string)' });

    const retrieveBody = {
      query,
      pathPrefix: pathPrefix || DEFAULT_PATH_PREFIX,
      topK: Number(topK || TOP_K_DEFAULT),
      maxCharsPerChunk: 1200,
      fileTypes: Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['pdf','docx','txt'],
      includeFileText: false
    };

    const retrieve = await fetchJson(`${PROXY_BASE_URL}/retrieve`, {
      method: 'POST',
      headers: { 'x-api-key': PROXY_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(retrieveBody)
    });

    const prompt = buildPrompt(query, retrieve);
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Eres un asistente especializado en documentación interna de ARCO.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2
    });

    const answer = completion.choices?.[0]?.message?.content || 'No encontré información suficiente.';
    res.json({ ok: true, query, used: retrieveBody, answer, snippets: retrieve.snippets || [], topFiles: retrieve.topFiles || [] });
  } catch (e) {
    console.error('Error /chat:', e.status, e.message, e.data || '');
    res.status(e.status || 500).json({ ok: false, error: e.message, status: e.status || 500, details: e.data || null });
  }
});

app.listen(PORT, () => console.log(`ARCO backend running on http://localhost:${PORT}`));
