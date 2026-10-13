// =========================================================
// Escala indicativa de conforto térmico (PJI410)
// Modelo: adaptativo probabilístico — regressão logística multinomial
// sobre o desvio z = ta − Tc, com Tc = 0,31 · text + 17,8 (ASHRAE 55),
// treinada na ASHRAE Global Thermal Comfort Database II (57.483 registros).
//
// O cálculo das probabilidades usa o modelo ONNX (modelo_conforto.onnx)
// quando a biblioteca onnxruntime-node está disponível. Se não estiver,
// usa os mesmos coeficientes em JavaScript puro (resultados idênticos,
// diferença < 1e-6, verificado em 1.000 casos).
// =========================================================
const path = require('path');
const LIM = require('./limites_escala.json'); // atencao_frio, atencao_calor, desconforto, a, b

// Coeficientes do modelo final (classes: frio, conforto, calor)
const COEF = [-0.1904601683346848, -0.03398255810883032, 0.22444272644350696];
const INTERC = [-0.752881237493092, 1.5295366624959716, -0.7766554250031186];

const NIVEIS = ['Desconforto – frio', 'Atenção – frio', 'Confortável', 'Atenção – calor', 'Desconforto – calor'];

// Recomendações revisadas a partir da pesquisa de campo (seção 3.3 do relatório).
const RECOMENDACAO = {
  'Desconforto – frio': 'Feche janelas e portas e desligue o ventilador. Se o frio continuar, vista uma camada a mais de roupa.',
  'Atenção – frio': 'O ambiente está esfriando: feche a janela ou reduza a ventilação.',
  'Confortável': 'Condição térmica adequada. Nenhuma ação necessária.',
  'Atenção – calor': 'O ambiente está aquecendo: abra a janela ou ligue o ventilador em velocidade baixa.',
  'Desconforto – calor': 'Mantenha o ar circulando (janela aberta e ventilador) e feche cortinas se houver sol direto. Faça uma pausa e hidrate-se. Se houver ar-condicionado, use-o em modo leve.'
};

// Correspondência com os níveis visuais do painel (ok | atencao | critico).
const NIVEL_VISUAL = {
  'Desconforto – frio': 'critico', 'Atenção – frio': 'atencao', 'Confortável': 'ok',
  'Atenção – calor': 'atencao', 'Desconforto – calor': 'critico'
};

// Limites (em z) entre níveis consecutivos, do frio para o calor.
const CORTES = [-LIM.desconforto, LIM.atencao_frio, LIM.atencao_calor, LIM.desconforto];
const HISTERESE = 0.3; // °C

// ---------- ONNX (opcional) ----------
let ort = null, sessao = null, carregando = null;
try { ort = require('onnxruntime-node'); } catch (e) { ort = null; }

async function carregarModelo() {
  if (!ort || sessao) return sessao;
  if (!carregando) {
    carregando = ort.InferenceSession.create(path.join(__dirname, 'modelo_conforto.onnx'))
      .then((s) => { sessao = s; console.log('Modelo de conforto ONNX carregado.'); return s; })
      .catch((e) => { console.error('ONNX indisponível, usando coeficientes em JS:', e.message); ort = null; return null; });
  }
  return carregando;
}

function temperaturaConforto(textMensal) { return LIM.a * textMensal + LIM.b; }

function probabilidadesJS(z) {
  const l = COEF.map((c, i) => INTERC[i] + c * z);
  const m = Math.max(...l);
  const e = l.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return { frio: e[0] / s, conforto: e[1] / s, calor: e[2] / s };
}

async function probabilidades(ta, textMensal) {
  await carregarModelo();
  if (sessao) {
    const entrada = new ort.Tensor('float32', Float32Array.from([ta, textMensal]), [1, 2]);
    const saida = await sessao.run({ entrada });
    const p = saida.probabilities.data;
    return { frio: p[0], conforto: p[1], calor: p[2], motor: 'onnx' };
  }
  return { ...probabilidadesJS(ta - temperaturaConforto(textMensal)), motor: 'js' };
}

function indicePorDesvio(z) {
  if (z < CORTES[0]) return 0;   // Desconforto – frio
  if (z < CORTES[1]) return 1;   // Atenção – frio
  if (z <= CORTES[2]) return 2;  // Confortável
  if (z <= CORTES[3]) return 3;  // Atenção – calor
  return 4;                      // Desconforto – calor
}

// Aplica histerese: só troca de nível se o desvio ultrapassar o limite em 0,3 °C.
function indiceComHisterese(z, indiceAnterior) {
  const novo = indicePorDesvio(z);
  if (indiceAnterior === null || indiceAnterior === undefined || novo === indiceAnterior) return novo;
  if (novo > indiceAnterior) { // esquentando: precisa passar do corte superior do nível anterior + margem
    return z > CORTES[indiceAnterior] + HISTERESE ? novo : indiceAnterior;
  }
  // esfriando: precisa ficar abaixo do corte inferior do nível anterior − margem
  return z < CORTES[indiceAnterior - 1] - HISTERESE ? novo : indiceAnterior;
}

function proximoLimite(indice, tc) {
  const fmt = (v) => v.toFixed(1).replace('.', ',');
  if (indice === 2) return `Fica Confortável entre ${fmt(tc + CORTES[1])} °C e ${fmt(tc + CORTES[2])} °C.`;
  if (indice > 2) {
    const t = indice < 4 ? tc + CORTES[indice] : null;
    return t !== null ? `Acima de ${fmt(t)} °C, o nível muda para ${NIVEIS[indice + 1]}.` : `Abaixo de ${fmt(tc + CORTES[3])} °C, o nível volta para Atenção – calor.`;
  }
  const t = indice > 0 ? tc + CORTES[indice - 1] : null;
  return t !== null ? `Abaixo de ${fmt(t)} °C, o nível muda para ${NIVEIS[indice - 1]}.` : `Acima de ${fmt(tc + CORTES[0])} °C, o nível volta para Atenção – frio.`;
}

/**
 * Avalia o conforto térmico.
 * @param {number} ta  temperatura interna (°C), já corrigida e suavizada
 * @param {number} textMensal  média de 30 dias da temperatura externa (°C)
 * @param {number|null} indiceAnterior  índice do nível exibido antes (para histerese)
 */
async function avaliar(ta, textMensal, indiceAnterior = null) {
  const tc = temperaturaConforto(textMensal);
  const z = ta - tc;
  const indice = indiceComHisterese(z, indiceAnterior);
  const nivel = NIVEIS[indice];
  const p = await probabilidades(ta, textMensal);
  const lado = indice >= 3 ? 'calor' : indice <= 1 ? 'frio' : (p.calor >= p.frio ? 'calor' : 'frio');
  // Arredonda a partir do mesmo valor exibido no painel (3 casas), para a frase e o cartão coincidirem.
  const pct = Math.round(100 * +(lado === 'calor' ? p.calor : p.frio).toFixed(3));
  return {
    nivel, indice, nivelVisual: NIVEL_VISUAL[nivel], recomendacao: RECOMENDACAO[nivel],
    temperaturaInterna: +ta.toFixed(2), textMensal: +textMensal.toFixed(2),
    temperaturaConforto: +tc.toFixed(2), desvio: +z.toFixed(2),
    probFrio: +p.frio.toFixed(3), probConforto: +p.conforto.toFixed(3), probCalor: +p.calor.toFixed(3),
    frase: `Cerca de ${pct} em cada 100 pessoas sentiriam ${lado} nesta condição.`,
    proximoLimite: proximoLimite(indice, tc),
    faixas: {
      desconfortoFrioAbaixo: +(tc + CORTES[0]).toFixed(2), atencaoFrioAbaixo: +(tc + CORTES[1]).toFixed(2),
      confortavelAte: +(tc + CORTES[2]).toFixed(2), desconfortoCalorAcima: +(tc + CORTES[3]).toFixed(2)
    },
    motor: p.motor
  };
}

module.exports = { avaliar, temperaturaConforto, probabilidadesJS, indicePorDesvio, indiceComHisterese, NIVEIS, RECOMENDACAO, LIM, carregarModelo };
