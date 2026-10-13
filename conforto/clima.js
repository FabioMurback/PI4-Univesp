// =========================================================
// Temperatura externa média de 30 dias (Open-Meteo, sem chave de acesso).
// Atualizada no máximo uma vez a cada 6 horas; em caso de falha,
// mantém o último valor válido.
// Licença dos dados: CC BY 4.0 — Open-Meteo.com
// =========================================================
const LAT = parseFloat(process.env.LATITUDE || '-21.79');   // Poços de Caldas (MG)
const LON = parseFloat(process.env.LONGITUDE || '-46.57');
const VALIDADE_MS = 6 * 3600 * 1000;

let cache = { valor: null, dias: 0, atualizadoEm: 0, fonte: null, erro: null };

function mediaDe30Dias(serie) {
  const v = serie.filter((x) => x !== null && Number.isFinite(x)).slice(-30);
  if (v.length < 20) throw new Error(`Série insuficiente: ${v.length} dias válidos`);
  return { media: v.reduce((a, b) => a + b, 0) / v.length, dias: v.length };
}

async function obterTextMensal() {
  // Valor fixo opcional (útil para testes ou se a API ficar indisponível).
  if (process.env.TEXT_MENSAL_FIXA) {
    return { valor: parseFloat(process.env.TEXT_MENSAL_FIXA), dias: 30, fonte: 'variável TEXT_MENSAL_FIXA' };
  }
  if (cache.valor !== null && Date.now() - cache.atualizadoEm < VALIDADE_MS) return cache;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
      '&daily=temperature_2m_mean&past_days=31&forecast_days=1&timezone=America%2FSao_Paulo';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
    const j = await r.json();
    const serie = j.daily.temperature_2m_mean.slice(0, -1); // exclui o dia corrente (incompleto)
    const { media, dias } = mediaDe30Dias(serie);
    cache = { valor: media, dias, atualizadoEm: Date.now(), fonte: 'Open-Meteo', erro: null };
  } catch (e) {
    console.error('Falha ao obter temperatura externa:', e.message);
    cache = { ...cache, erro: e.message };
  }
  return cache;
}

module.exports = { obterTextMensal, mediaDe30Dias, LAT, LON };
