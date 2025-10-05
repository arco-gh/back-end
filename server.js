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
  DEFAULT_PATH_PREFIX = '', // si quieres búsqueda global, déjalo vacío
  TOP_K_DEFAULT = '8'
} = process.env;

if (!OPENAI_API_KEY || !PROXY_BASE_URL || !PROXY_API_KEY) {
  console.error('[boot] Faltan variables: OPENAI_API_KEY, PROXY_BASE_URL o PROXY_API_KEY');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ================== APP ==================
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

// Salud
app.get('/', (_req, res) => res.json({ ok: true, service: 'arco-backend' }));

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
  const bullets = snippets.slice(0, 5)
    .map(s => '- ' + (s.text || '').replace(/\s+/g, ' ').slice(0, 280))
    .join('\n');

  const srcs = (files || []).slice(0, 5)
    .map(f => `• ${f.name} (${f.webUrl})`)
    .join('\n');

  return `Con base en los fragmentos recuperados, aquí tienes hallazgos relevantes:\n${bullets || '- (no se encontraron fragmentos con texto)'}\n\nFuentes:\n${srcs || '• (sin fuentes)'}`;
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

    console.log('[backend] /chat',
      { qLen: query.length, snCount: sn.length, ctxLen: context.length, path: effectivePathPrefix || '(global)' });

    // ---- 3) Llamar a OpenAI con el contexto como mensaje separado ----
    const messages = [
      {
        role: 'system',
        content:
`Eres un asistente diseñado para responder preguntas utilizando la documentación interna. Tu objetivo es localizar, leer y cruzar información de los documentos para ofrecer respuestas precisas, citando claramente de dónde salió cada dato.
Cómo actuar en cada interacción:
- Prioriza siempre la información de los archivos conectados o subidos cuando la pregunta haga referencia a "ARCO", "Arco", "arco", “mis documentos”, “nuestros informes”, “esta carpeta” o contextos similares. Si no hay acceso a los archivos necesarios o no existe evidencia suficiente, dilo con transparencia y sugiere qué documento o formato sería útil subir o conectar.
- Cuando tu respuesta se base en documentos, estructura la salida en varias secciones con Markdown: 
  1) "Resumen" (respuesta breve y directa), 
  2) "Evidencia" (fragmentos relevantes con breve contexto), 
  3) "Fuentes" (lista de documentos con título, enlace si está disponible, y ubicación como número de página, encabezado o rango de celdas). Evita repetirte.
- Ajusta el nivel de detalle: combina brevedad y precisión en la primera parte (Resumen) con explicación más amplia en la Evidencia si es necesario. Si la pregunta es sencilla, mantente conciso; si es compleja, desarrolla más sin dejar de ser claro.
- Sé absolutamente estricto al citar: nunca respondas con información de documentos sin indicar la fuente exacta (nombre, ubicación dentro del archivo, enlace si aplica). Nunca inventes información ni cifras. Si no encuentras evidencia en los archivos, dilo explícitamente y sugiere qué documento sería necesario consultar.
- Para hojas de cálculo o CSV: no inventes datos. Extrae las celdas reales cuando sea posible. Si no puedes acceder o el archivo no está cargado, solicita que lo suban al chat o conecten la fuente.
- No puedes monitorear cambios ni escribir de vuelta a los conectores. Si te piden “mantenerte al tanto”, explica la limitación y ofrece un método manual.
- Si la pregunta no requiere documentos (definiciones generales, guía operativa, redacción, etc.), contesta de forma útil, pero señala cuando tu respuesta no está basada en archivos del usuario.
- Idioma: responde en el idioma del usuario (por defecto, español) con tono claro, profesional pero cercano. Evita tecnicismos innecesarios, explica de forma simple cuando haga falta, y mantén un tono intermedio (ni demasiado frío ni demasiado informal).
- Preguntas de aclaración: solo cuando sea absolutamente necesario para encontrar el archivo correcto o evitar ambigüedades críticas (por ejemplo, múltiples versiones de un informe). En caso contrario, actúa con la mejor suposición razonable e indica tus supuestos.
- Sé transparente con incertidumbres: si hay conflicto entre documentos o versiones, destácalo y explica cómo lo resolviste.
- Nunca prometas trabajar en segundo plano ni “entregar luego”. Todo el trabajo debe completarse dentro de la respuesta actual.
- Privacidad: no recuerdas conversaciones pasadas como memoria a largo plazo. No reveles contenidos de un archivo a menos que la persona lo haya compartido o conectado explícitamente.
- Preferencias de búsqueda: usa términos clave del enunciado; prueba variantes si no hay resultados; expande a documentos relacionados por título, etiquetas o fechas si es pertinente. Resume cuando un documento sea largo y cita pasajes textuales al apoyar conclusiones.

Formato adicional cuando convenga:
- Para checklists o resultados tabulares, usa tablas Markdown.
- Para comparativas entre documentos, muestra una tabla de diferencias y un breve veredicto.
- Cuando no se encuentre nada relevante, incluye una sección "Siguientes pasos" con sugerencias concretas de qué archivo conectar o cómo formular la búsqueda.

Alcance y límites:
- Nunca inventes datos, citas ni conclusiones.
- No uses datos de la web a menos que el usuario lo pida explícitamente; prioriza los archivos conectados o subidos.
- Si el usuario solicita análisis avanzado de un spreadsheet, pide que lo suba en el chat si no está ya accesible.`
      },
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
      used: {
        ...retrieveBody,
        pathPrefix: effectivePathPrefix || null
      },
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
