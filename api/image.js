/**
 * /api/image.js
 * Vercel Serverless Function
 *
 * Recebe: { prompt }
 * Retorna: { url }
 *
 * Usa Pollinations para gerar imagens. A chave nunca é exposta ao frontend.
 */

const POLLINATIONS_API_KEY = process.env.POLLINATIONS_API_KEY;

const MAX_PROMPT_CHARS = 800;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido.' });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    res.status(400).json({ error: 'Corpo da requisição inválido.' });
    return;
  }

  const { prompt } = body || {};

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'Descreva a imagem que deseja gerar.' });
    return;
  }

  if (prompt.length > MAX_PROMPT_CHARS) {
    res.status(400).json({ error: `Descrição muito longa (máximo ${MAX_PROMPT_CHARS} caracteres).` });
    return;
  }

  try {
    const seed = Math.floor(Math.random() * 1000000);
    const encodedPrompt = encodeURIComponent(prompt.trim());
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?seed=${seed}&nologo=true`;

    const headers = {};
    if (POLLINATIONS_API_KEY) {
      headers['Authorization'] = `Bearer ${POLLINATIONS_API_KEY}`;
    }

    // Verifica se a geração responde corretamente antes de repassar a URL ao frontend
    const checkResponse = await fetch(pollinationsUrl, { method: 'GET', headers });

    if (!checkResponse.ok) {
      console.error('Pollinations API erro:', checkResponse.status);
      res.status(502).json({ error: 'Erro ao gerar a imagem. Tente novamente.' });
      return;
    }

    res.status(200).json({ url: pollinationsUrl });
  } catch (err) {
    console.error('Erro ao gerar imagem:', err);
    res.status(502).json({ error: 'Erro ao gerar a imagem. Tente novamente.' });
  }
};
