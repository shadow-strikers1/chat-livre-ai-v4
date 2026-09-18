/**
 * /api/chat.js
 * Vercel Serverless Function
 *
 * Recebe: { provider, messages, attachments }
 * Retorna: { text, provider }
 *
 * Nunca expõe API keys ao frontend. Lê chaves de process.env.
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const GEMINI_MODEL = 'gemini-3.6-flash';
const OPENROUTER_MODEL = 'openrouter/free';

// Limites para evitar abuso
const MAX_MESSAGE_CHARS = 12000;
const MAX_MESSAGES = 40;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024; // ~3MB total (base64 aproximado)

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp'];
const PDF_EXT = ['pdf'];
const TEXT_EXT = ['txt', 'csv', 'json', 'html', 'htm', 'css', 'js', 'c', 'cpp', 'h', 'hpp', 'java', 'py', 'md'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    res.status(400).json({ error: 'Corpo da requisição inválido.' });
    return;
  }

  const { provider, messages, attachments } = body || {};

  if (!provider || !['gemini', 'openrouter'].includes(provider)) {
    res.status(400).json({ error: 'Provedor inválido.' });
    return;
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Nenhuma mensagem enviada.' });
    return;
  }

  if (messages.length > MAX_MESSAGES) {
    res.status(400).json({ error: `Muitas mensagens no histórico (máximo ${MAX_MESSAGES}).` });
    return;
  }

  for (const m of messages) {
    if (typeof m.content !== 'string' || typeof m.role !== 'string') {
      res.status(400).json({ error: 'Formato de mensagem inválido.' });
      return;
    }
    if (m.content.length > MAX_MESSAGE_CHARS) {
      res.status(400).json({ error: `Mensagem muito longa (máximo ${MAX_MESSAGE_CHARS} caracteres).` });
      return;
    }
  }

  const safeAttachments = Array.isArray(attachments) ? attachments.slice(0, MAX_ATTACHMENTS) : [];

  if (safeAttachments.length > MAX_ATTACHMENTS) {
    res.status(400).json({ error: `Máximo de ${MAX_ATTACHMENTS} arquivos por mensagem.` });
    return;
  }

  let totalAttachmentBytes = 0;
  for (const att of safeAttachments) {
    if (!att || typeof att.dataUrl !== 'string' || typeof att.name !== 'string') {
      res.status(400).json({ error: 'Anexo inválido.' });
      return;
    }
    totalAttachmentBytes += att.dataUrl.length * 0.75; // aproximação base64 -> bytes
  }
  if (totalAttachmentBytes > MAX_ATTACHMENT_BYTES) {
    res.status(400).json({ error: 'Tamanho total dos anexos excede o limite de 3MB.' });
    return;
  }

  // Valida suporte de tipo de arquivo por provedor
  if (safeAttachments.length > 0 && provider === 'openrouter') {
    const hasNonText = safeAttachments.some(att => {
      const ext = getExtFromName(att.name);
      return IMAGE_EXT.includes(ext) || PDF_EXT.includes(ext);
    });
    if (hasNonText) {
      res.status(400).json({ error: 'O provedor OpenRouter não suporta imagens ou PDFs, apenas texto e código.' });
      return;
    }
  }

  try {
    let text;
    if (provider === 'gemini') {
      text = await callGemini(messages, safeAttachments);
    } else {
      text = await callOpenRouter(messages, safeAttachments);
    }
    res.status(200).json({ text, provider });
  } catch (err) {
    console.error('Erro no provedor de IA:', err);
    const message = err && err.message ? err.message : 'Erro ao gerar resposta.';
    res.status(502).json({ error: message });
  }
};

function getExtFromName(name) {
  const parts = String(name).split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

/* ---------------- GEMINI ---------------- */
async function callGemini(messages, attachments) {
  if (!GEMINI_API_KEY) {
    throw new Error('Serviço Gemini não configurado no servidor.');
  }

  const contents = messages.map((m, i) => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = [{ text: m.content }];

    // Anexa arquivos apenas na última mensagem do usuário
    if (i === messages.length - 1 && role === 'user' && attachments.length > 0) {
      for (const att of attachments) {
        const ext = getExtFromName(att.name);
        const match = att.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) continue;
        const [, mimeType, base64Data] = match;

        if (IMAGE_EXT.includes(ext) || PDF_EXT.includes(ext) || mimeType.startsWith('image/') || mimeType === 'application/pdf') {
          parts.push({ inline_data: { mime_type: mimeType, data: base64Data } });
        } else if (TEXT_EXT.includes(ext)) {
          try {
            const decoded = Buffer.from(base64Data, 'base64').toString('utf-8');
            parts.push({ text: `\n\n[Arquivo anexado: ${att.name}]\n${decoded.slice(0, 20000)}` });
          } catch (e) {
            // ignora arquivo que não pôde ser decodificado
          }
        }
      }
    }
    return { role, parts };
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: { maxOutputTokens: 4096 }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('Gemini API erro:', errText);
    throw new Error('Erro ao consultar o Gemini.');
  }

  const data = await response.json();
  const candidate = data.candidates && data.candidates[0];
  const text = candidate && candidate.content && candidate.content.parts
    ? candidate.content.parts.map(p => p.text || '').join('')
    : '';

  if (!text) {
    throw new Error('O Gemini não retornou uma resposta válida.');
  }

  return text;
}

/* ---------------- OPENROUTER ---------------- */
async function callOpenRouter(messages, attachments) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('Serviço OpenRouter não configurado no servidor.');
  }

  // OpenRouter (modo texto/código) - anexa conteúdo de arquivos de texto como contexto
  const formattedMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content
  }));

  if (attachments.length > 0) {
    let extraText = '';
    for (const att of attachments) {
      const ext = getExtFromName(att.name);
      if (TEXT_EXT.includes(ext)) {
        const match = att.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          try {
            const decoded = Buffer.from(match[2], 'base64').toString('utf-8');
            extraText += `\n\n[Arquivo anexado: ${att.name}]\n${decoded.slice(0, 20000)}`;
          } catch (e) { /* ignora */ }
        }
      }
    }
    if (extraText && formattedMessages.length > 0) {
      formattedMessages[formattedMessages.length - 1].content += extraText;
    }
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: formattedMessages,
      max_tokens: 4096
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('OpenRouter API erro:', errText);
    throw new Error('Erro ao consultar o OpenRouter.');
  }

  const data = await response.json();
  const text = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';

  if (!text) {
    throw new Error('O OpenRouter não retornou uma resposta válida.');
  }

  return text;
}
