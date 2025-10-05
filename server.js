// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

// ================== CONFIG ==================
const {
  PORT = 4000,
  OPENAI_API_KEY,
  PROXY_BASE_URL,           // ej: https://gptsp.azurewebsites.net
  PROXY_API_KEY,            // x-api-key del proxy
  DEFAULT_PATH_PREFIX = '', // vacío = búsqueda global (recomendado si quieres todo el corpus)
  TOP_K_DEFAULT = '8'
} = process.env;

if (!OPENAI_API_KEY || !PROXY_BASE_URL || !PROXY_API_KEY) {
  console.error('[boot] Faltan variables: OPENAI_API_KEY, PROXY_BASE_URL o PROXY_API_KEY');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Prompt endurecido (versión recomendada, compacta para ahorrar tokens)
const MAIN_RULES = `
Responde usando SOLO el contexto de documentos proporcionado. Si hay fragmentos, asume acceso legítimo y NO digas “no tengo acceso…”. Si el contexto está vacío/insuficiente, dilo y sugiere qué documento faltaría.

Salida (Markdown):
1) **Resumen** breve y directo.
2) **Evidencia**: 2–5 citas cortas (1–3 líneas) con breve contexto.
3) **Fuentes**: nombre, enlace si existe y ubicación (página/encabezado/rango; si no hay, “s/d”).

Precisión y estilo:
- Nunca inventes datos/citas. Si no hay evidencia, dilo.
- Si es hoja de cálculo/CSV y no ves celdas, pide el archivo.
- Si la pregunta no requiere documentos, respóndelo pero señala que no usaste archivos del usuario.
- Español claro, profesional y conciso; pide aclaración solo si es crítico.
`.trim();

// ================== APP ==================
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

// Salud
app.get('/', (_req, res) => res.json({ ok: true, service: 'arco-backend' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

// ===== Utils =====
async function fetchJson(url, options = {}, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: ctrl.signal });
    const raw = await resp.text();
    const data = raw ? JSON.parse(raw) : {};
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status}`);
      err.status = resp.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

function buildFallbackFromSnippets(query, snippets = [], files = []) {
  const bullets = (snippets || []).slice(0, 5)
    .map(s => '- ' + (s.text || '').replace(/\s+/g, ' ').slice(0, 280))
    .join('\n');

  const srcs = (files || []).slice(0, 5)
    .map(f => `• ${f.name} (${f.webUrl})`)
    .join('\n');

  return `**Resumen**\nNo fue posible generar respuesta del modelo, pero aquí están hallazgos relevantes.\n\n**Evidencia**\n${bullets || '- (no se encontraron fragmentos con texto)'}\n\n**Fuentes**\n${srcs || '• (sin fuentes)'}`;
}

// ================== /chat ==================
app.post('/chat', async (req, res) => {
  try {
    const { query, pathPrefix, topK, fileTypes } = req.body || {};
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ ok: false, error: 'Falta "query" (string)' });
    }

    // ---- 1) Llamar al proxy /retrieve ----
    const effectivePathPrefix = (pathPrefix ?? DEFAULT_PATH_PREFIX)?.trim();
    const retrieveBody = {
      query,
      topK: Number(topK || TOP_K_DEFAULT) || 8,
      maxCharsPerChunk: 1000,
      fileTypes: Array.isArray(fileTypes) && fileTypes.length ? fileTypes : ['pdf', 'docx', 'txt'],
      includeFileText: false
    };
    if (effectivePathPrefix) retrieveBody.pathPrefix = effectivePathPrefix;

    const retrieve = await fetchJson(`${PROXY_BASE_URL}/retrieve`, {
      method: 'POST',
      headers: {
        'x-api-key': PROXY_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(retrieveBody)
    });

    // ---- 2) Construir CONTEXTO exclusivamente desde snippets ----
    const sn = Array.isArray(retrieve?.snippets) ? retrieve.snippets : [];
    const context = sn
      .map(s => (s?.text || '').toString().trim().slice(0, 1000))
      .filter(Boolean)
      .join('\n---\n');

    // Pista de fuentes para incentivar citas
    const files = Array.isArray(retrieve?.topFiles) ? retrieve.topFiles : [];
    const sourcesHint = files.slice(0, 6).map(f => `• ${f.name} — ${f.webUrl}`).join('\n');

    console.log('[backend] /chat', {
      qLen: query.length,
      snCount: sn.length,
      ctxLen: context.length,
      path: effectivePathPrefix || '(global)'
    });

    // ---- 3) Llamar a OpenAI con el contexto como mensaje separado ----
    const messages = [
      { role: 'system', content: MAIN_RULES },
      { role: 'system', content: `Contexto (fragmentos de documentos internos):\n${context || '(vacío)'}` },
      { role: 'system', content: sourcesHint ? `Fuentes sugeridas:\n${sourcesHint}` : 'Fuentes sugeridas: (ninguna)' },
      { role: 'user', content: query }
    ];

    let answer = '';
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.2
      });
      answer = completion.choices?.[0]?.message?.content?.trim() || '';
      console.log('[backend] answerPreview:', answer.slice(0, 160));
    } catch (e) {
      console.error('[openai] error', e.status || '', e.message);
    }

    // ---- 4) Fallback si el modelo no devolvió nada útil ----
    if (!answer) {
      answer = buildFallbackFromSnippets(query, sn, files);
    }

    // ---- 5) Respuesta ----
    res.json({
      ok: true,
      query,
      used: { ...retrieveBody, pathPrefix: effectivePathPrefix || null },
      answer,
      snippets: sn,
      topFiles: files,
      debug: {
        contextPreview: context.slice(0, 400),
        snippetsCount: sn.length
      }
    });
  } catch (e) {
    console.error('[backend] /chat error', e.status || 500, e.message, e.data || '');
    res.status(e.status || 500).json({
      ok: false,
      error: e.message,
      status: e.status || 500,
      details: e.data || null
    });
  }
});

// ================== START ==================
app.listen(PORT, () => {
  console.log(`ARCO backend running on http://localhost:${PORT}`);
});
