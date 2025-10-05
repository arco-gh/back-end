// server.js (versión genérica, sin sesgos de dominio)
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
  DEFAULT_PATH_PREFIX = '', // vacío = búsqueda global
  TOP_K_DEFAULT = '10'      // pide un poco más y deja que el prompt seleccione
} = process.env;

if (!OPENAI_API_KEY || !PROXY_BASE_URL || !PROXY_API_KEY) {
  console.error('[boot] Faltan variables: OPENAI_API_KEY, PROXY_BASE_URL o PROXY_API_KEY');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Prompt genérico y compacto (no sesgado, sin “riesgos”-centrismo)
const MAIN_RULES = `
Responde usando SOLO el contexto de documentos proporcionado cuando se haga mención a ARCO, arco, Arco, mis documentos, los documentos, la empresa o cualquier término semejante. Si existen fragmentos, asume acceso legítimo y NO uses frases como “no tengo acceso…”, “no hay información específica” o similares.
Si el término exacto no aparece pero el contexto contiene procedimientos, políticas, requisitos, definiciones o ejemplos aplicables, DEDUCE y explica con claridad. Cita siempre la fuente de donde se derivan las conclusiones.
Si el contexto está vacío o es claramente insuficiente, dilo y sugiere qué documento/ sección haría falta.

Salida (Markdown):
1) **Resumen** breve y directo.
2) **Evidencia**: 2–5 citas cortas (1–3 líneas) con una línea de contexto.
3) **Fuentes**: nombre del documento, enlace si existe y ubicación (página/encabezado/rango; si no hay, “s/d”).

Precisión y estilo:
- Nunca inventes datos o citas. Si no hay evidencia, indícalo.
- Si la pregunta no requiere documentos, respóndela pero señala que no usaste archivos del usuario.
- Español claro y profesional; pide aclaración solo si es crítico evitar una interpretación errónea.
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

function buildFallbackFromSnippets(snippets = [], files = []) {
  const bullets = (snippets || []).slice(0, 5)
    .map(s => '- ' + (s.text || '').replace(/\s+/g, ' ').slice(0, 280))
    .join('\n');
  const srcs = (files || []).slice(0, 5)
    .map(f => `• ${f.name} (${f.webUrl})`)
    .join('\n');
  return `**Resumen**\nNo fue posible generar respuesta completa del modelo, pero aquí van fragmentos relevantes.\n\n**Evidencia**\n${bullets || '- (no se encontraron fragmentos con texto)'}\n\n**Fuentes**\n${srcs || '• (sin fuentes)'}`;
}

function looksEvasive(answer = '') {
  const a = (answer || '').toLowerCase();
  const patterns = [
    'no tengo acceso', 'no cuento con acceso', 'no hay información específica',
    'no encuentro información', 'no dispongo de información', 'no está disponible',
    'no suficiente información', 'no tengo suficiente contexto',
    'el contexto proporcionado no incluye', 'no puedo acceder'
  ];
  return patterns.some(p => a.includes(p));
}

function hasSourcesSection(answer = '') {
  return /(^|\n)\s*\*\*?fuentes\*?\*:?/i.test(answer || '');
}

function appendSourcesIfMissing(answer = '', files = []) {
  if (hasSourcesSection(answer) || !files?.length) return answer;
  const list = files.slice(0, 6).map(f => `• ${f.name}${f.webUrl ? ` (${f.webUrl})` : ''}`).join('\n');
  return `${answer}\n\n**Fuentes**\n${list}`;
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
      topK: Number(topK || TOP_K_DEFAULT) || 10,
      maxCharsPerChunk: 900,
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

    // ---- 2) Contexto desde snippets (siempre) ----
    const sn = Array.isArray(retrieve?.snippets) ? retrieve.snippets : [];
    const context = sn
      .map(s => (s?.text || '').toString().trim().slice(0, 1000))
      .filter(Boolean)
      .join('\n---\n');

    const files = Array.isArray(retrieve?.topFiles) ? retrieve.topFiles : [];
    const sourcesHint = files.slice(0, 6).map(f => `• ${f.name} — ${f.webUrl}`).join('\n');

    console.log('[backend] /chat', {
      qLen: query.length,
      snCount: sn.length,
      ctxLen: context.length,
      path: effectivePathPrefix || '(global)'
    });

    // ---- 3) Llamada a OpenAI ----
    const baseMessages = [
      { role: 'system', content: MAIN_RULES },
      { role: 'system', content: `Contexto (fragmentos de documentos internos):\n${context || '(vacío)'}` },
      { role: 'system', content: sourcesHint ? `Fuentes sugeridas:\n${sourcesHint}` : 'Fuentes sugeridas: (ninguna)' },
      { role: 'user', content: query }
    ];

    let answer = '';
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: baseMessages,
        temperature: 0.2
      });
      answer = completion.choices?.[0]?.message?.content?.trim() || '';
      console.log('[backend] answerPreview:', answer.slice(0, 160));
    } catch (e) {
      console.error('[openai] error', e.status || '', e.message);
    }

    // ---- 4) Anti-disclaimer genérico (no sesgado) ----
    const hasContext = context && context.length > 0;
    if (hasContext && (looksEvasive(answer) || answer.length < 30)) {
      try {
        const retryMessages = [
          { role: 'system', content: 'Usa EXCLUSIVAMENTE el contexto siguiente para responder la pregunta. No uses disclaimers. Si falta evidencia, dilo, pero intenta responder lo que sí esté soportado. Formato: **Resumen**, **Evidencia** (2–5 citas) y **Fuentes**.' },
          { role: 'system', content: `Contexto:\n${context}` },
          { role: 'user', content: `Pregunta: ${query}\nTarea: Responde directo y cita 2–5 fragmentos relevantes, luego lista las fuentes.` }
        ];
        const retry = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: retryMessages,
          temperature: 0.1
        });
        const retryAnswer = retry.choices?.[0]?.message?.content?.trim();
        if (retryAnswer) {
          answer = retryAnswer;
          console.log('[backend] anti-disclaimer retry applied');
        }
      } catch (e) {
        console.warn('[backend] retry failed:', e.message);
      }
    }

    // ---- 5) Fallback y asegurado de fuentes ----
    if (!answer) {
      answer = buildFallbackFromSnippets(sn, files);
    } else {
      answer = appendSourcesIfMissing(answer, files);
    }

    // ---- 6) Respuesta ----
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
