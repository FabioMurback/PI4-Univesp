const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const escala = require('./conforto/escala');
const { obterTextMensal } = require('./conforto/clima');

const app = express();
const PORT = process.env.PORT || 3000;

// =========================
// FAIXAS DE CLASSIFICAÇÃO (Conforto Ambiental)
// Baseado no documento "Análise Multivariável e
// Classificação de Conforto Ambiental".
// =========================
const REGRAS = {
  // Temperatura Operacional (°C)
  temperatura: {
    unidade: '°C',
    criticoBaixo: 18.0,   // abaixo -> Crítico (frio excessivo)
    idealMin: 20.0,       // 20.0 a 24.0 -> OK
    idealMax: 24.0,
    criticoAlto: 26.5     // acima -> Crítico (calor excessivo)
  },
  // Umidade Relativa do Ar (%)
  umidade: {
    unidade: '%',
    criticoBaixo: 30,     // abaixo -> Crítico (ar extremamente seco)
    idealMin: 40,         // 40 a 65 -> OK
    idealMax: 65,
    criticoAlto: 75       // acima -> Crítico (ar saturado)
  },
  // Luminosidade (lux)
  luminosidade: {
    unidade: 'lux',
    criticoBaixo: 200,    // abaixo -> Crítico (insuficiente)
    idealMin: 500,        // 500 a 1200 -> OK
    idealMax: 1200,
    criticoAlto: 2200     // acima -> Crítico (ofuscamento)
  },
  // Pressão Atmosférica (gradiente barométrico em hPa / 2h)
  pressao: {
    unidade: 'hPa',
    limiteEstavel: 1.5,   // ± 1,5 hPa -> estável (OK)
    limiteAlerta: 2.5     // > 2,5 hPa (queda ou elevação) -> Atenção
  }
};

// =========================
// ESCALA DE CONFORTO TÉRMICO (Relatório Final PJI410, seção 3.2)
// - Temperatura de conforto adaptativa: Tc = 0,31 · text + 17,8,
//   com text = média de 30 dias da temperatura externa (Open-Meteo).
// - Níveis: Desconforto/Atenção – frio, Confortável, Atenção/Desconforto – calor.
// - Requisitos de operação: correção de aferição do sensor, média móvel
//   de 10 minutos e histerese de 0,3 °C na troca de nível.
// =========================
const OFFSET_TEMPERATURA = parseFloat(process.env.OFFSET_TEMPERATURA || '0'); // correção de aferição do BME280 (°C)
const JANELA_SUAVIZACAO_MIN = 10;                                             // média móvel (minutos)
let indiceNivelAnterior = null;                                               // estado para a histerese

// =========================
// MIDDLEWARES
// =========================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Raiz redireciona para o dashboard.
app.get('/', (req, res) => {
  res.redirect('/leitura.html');
});

// =========================
// CONEXÃO COM POSTGRESQL
// =========================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

// Garante que a tabela e as 4 colunas existam (mantendo id e data_registro).
async function garantirEsquema() {
  const sqlTabela = `
    CREATE TABLE IF NOT EXISTS pi_leituras_sensores (
      id SERIAL PRIMARY KEY,
      temperatura NUMERIC,
      umidade NUMERIC,
      pressao NUMERIC,
      luminosidade NUMERIC,
      data_registro TIMESTAMP DEFAULT NOW()
    )
  `;

  // Bancos que já existiam armazenavam apenas temperatura e luminosidade.
  const sqlColunas = `
    ALTER TABLE pi_leituras_sensores
      ADD COLUMN IF NOT EXISTS umidade NUMERIC,
      ADD COLUMN IF NOT EXISTS pressao NUMERIC
  `;

  // Colunas da escala de conforto térmico (calculadas a cada gravação).
  const sqlColunasConforto = `
    ALTER TABLE pi_leituras_sensores
      ADD COLUMN IF NOT EXISTS text_mensal NUMERIC,
      ADD COLUMN IF NOT EXISTS temperatura_conforto NUMERIC,
      ADD COLUMN IF NOT EXISTS desvio_z NUMERIC,
      ADD COLUMN IF NOT EXISTS nivel_conforto VARCHAR(24),
      ADD COLUMN IF NOT EXISTS prob_frio NUMERIC,
      ADD COLUMN IF NOT EXISTS prob_calor NUMERIC
  `;

  // Votos de sensação térmica registrados no painel (validação em campo).
  const sqlVotos = `
    CREATE TABLE IF NOT EXISTS votos_conforto (
      id SERIAL PRIMARY KEY,
      registrado_em TIMESTAMP DEFAULT NOW(),
      voto SMALLINT NOT NULL CHECK (voto BETWEEN -3 AND 3),
      preferencia VARCHAR(12) CHECK (preferencia IN ('mais_quente', 'sem_mudanca', 'mais_frio')),
      leitura_id INTEGER,
      temperatura NUMERIC,
      umidade NUMERIC,
      text_mensal NUMERIC,
      desvio_z NUMERIC,
      nivel_exibido VARCHAR(24),
      prob_frio NUMERIC,
      prob_calor NUMERIC
    )
  `;

  await pool.query(sqlTabela);
  await pool.query(sqlColunas);
  await pool.query(sqlColunasConforto);
  await pool.query(sqlVotos);
}

pool.connect()
  .then(async (client) => {
    console.log('Conectado ao PostgreSQL com sucesso.');
    client.release();
    try {
      await garantirEsquema();
      console.log('Esquema do banco verificado (4 grandezas + escala de conforto + votos).');
    } catch (err) {
      console.error('Erro ao garantir esquema do banco:', err.message);
    }
  })
  .catch((err) => {
    console.error('Erro ao conectar no PostgreSQL:', err.message);
  });

// =========================
// CLASSIFICAÇÕES INDIVIDUAIS
// Cada função retorna: nivel (ok|atencao|critico), diagnostico,
// impacto (efeito no ocupante) e sugestao (ação individual).
// =========================
function classificarTemperatura(valor) {
  const cfg = REGRAS.temperatura;

  if (valor < cfg.criticoBaixo) {
    return {
      nivel: 'critico',
      diagnostico: 'Frio Excessivo',
      impacto: 'Rigidez muscular, queda de destreza motora e desconforto acentuado.',
      sugestao: 'Feche janelas e portas e desligue o ventilador. Se o frio continuar, vista uma camada a mais de roupa.'
    };
  }
  if (valor < cfg.idealMin) {
    return {
      nivel: 'atencao',
      diagnostico: 'Levemente Frio',
      impacto: 'Sensação de frescor excessivo para tarefas estáticas prolongadas.',
      sugestao: 'Feche a janela ou reduza a ventilação.'
    };
  }
  if (valor <= cfg.idealMax) {
    return {
      nivel: 'ok',
      diagnostico: 'Faixa Ideal',
      impacto: 'Equilíbrio térmico e máximo rendimento cognitivo.',
      sugestao: 'Temperatura ideal. Nenhuma ação necessária.'
    };
  }
  if (valor <= cfg.criticoAlto) {
    return {
      nivel: 'atencao',
      diagnostico: 'Levemente Quente',
      impacto: 'Início de sonolência e leve sudorese.',
      sugestao: 'Abra a janela ou ligue o ventilador em velocidade baixa.'
    };
  }
  return {
    nivel: 'critico',
    diagnostico: 'Calor Excessivo',
    impacto: 'Fadiga precoce, estresse térmico e queda de concentração.',
    sugestao: 'Mantenha o ar circulando (janela e ventilador) e faça uma pausa. Se houver ar-condicionado, use-o em modo leve.'
  };
}

// Temperatura avaliada pela escala adaptativa (substitui as faixas fixas
// quando a temperatura externa média está disponível).
function classificarTemperaturaEscala(conforto) {
  return {
    nivel: conforto.nivelVisual,
    rotulo: conforto.nivel.toUpperCase(),
    diagnostico: conforto.nivel,
    impacto: conforto.frase,
    sugestao: conforto.recomendacao
  };
}

// Média móvel da temperatura nos últimos minutos, com a correção de aferição.
function temperaturaSuavizada(leituras) {
  const ultima = leituras[leituras.length - 1];
  const tFim = new Date(ultima.data_registro).getTime();
  const janela = leituras.filter((l) => tFim - new Date(l.data_registro).getTime() <= JANELA_SUAVIZACAO_MIN * 60000);
  const media = janela.reduce((acc, l) => acc + Number(l.temperatura), 0) / janela.length;
  return { valor: media + OFFSET_TEMPERATURA, leituras: janela.length };
}

// Calcula a escala para a situação atual (com suavização e histerese).
async function avaliarConfortoAtual(leituras) {
  const tm = await obterTextMensal();
  if (tm.valor === null || tm.valor === undefined) return null;
  const ts = temperaturaSuavizada(leituras);
  const conforto = await escala.avaliar(ts.valor, tm.valor, indiceNivelAnterior);
  indiceNivelAnterior = conforto.indice;
  return { ...conforto, leiturasNaMedia: ts.leituras, janelaMinutos: JANELA_SUAVIZACAO_MIN,
    offsetSensor: OFFSET_TEMPERATURA, fonteTextMensal: tm.fonte, diasTextMensal: tm.dias };
}

function classificarUmidade(valor) {
  const cfg = REGRAS.umidade;

  if (valor < cfg.criticoBaixo) {
    return {
      nivel: 'critico',
      diagnostico: 'Ar Extremamente Seco',
      impacto: 'Irritação ocular, garganta seca e vulnerabilidade a infecções aéreas.',
      sugestao: 'Ligue um umidificador de ambiente e hidrate-se com frequência.'
    };
  }
  if (valor < cfg.idealMin) {
    return {
      nivel: 'atencao',
      diagnostico: 'Umidade Baixa',
      impacto: 'Leve desconforto respiratório e sede frequente.',
      sugestao: 'Considere um umidificador e mantenha-se hidratado.'
    };
  }
  if (valor <= cfg.idealMax) {
    return {
      nivel: 'ok',
      diagnostico: 'Faixa Ideal',
      impacto: 'Higidez do trato respiratório e taxa ótima de evaporação.',
      sugestao: 'Umidade ideal. Nenhuma ação necessária.'
    };
  }
  if (valor <= cfg.criticoAlto) {
    return {
      nivel: 'atencao',
      diagnostico: 'Umidade Elevada',
      impacto: 'Dificuldade na evaporação do suor e sensação de ar pesado.',
      sugestao: 'Melhore a ventilação ou use um desumidificador.'
    };
  }
  return {
    nivel: 'critico',
    diagnostico: 'Ar Saturado / Muito Úmido',
    impacto: 'Sensação intensa de mormaço, risco de proliferação fúngica e bolor.',
    sugestao: 'Ligue o desumidificador ou o ar-condicionado em modo "dry" e ventile.'
  };
}

function classificarLuminosidade(valor) {
  const cfg = REGRAS.luminosidade;

  if (valor < cfg.criticoBaixo) {
    return {
      nivel: 'critico',
      diagnostico: 'Iluminação Insuficiente',
      impacto: 'Esforço visual excessivo, cefaleia e perda de nitidez em vídeo.',
      sugestao: 'Acenda a iluminação principal ou uma luz de apoio direcionada.'
    };
  }
  if (valor < cfg.idealMin) {
    return {
      nivel: 'atencao',
      diagnostico: 'Iluminação Fraca',
      impacto: 'Subótimo para leitura contínua e gravação profissional.',
      sugestao: 'Reforce a iluminação do ambiente para leitura/gravação.'
    };
  }
  if (valor <= cfg.idealMax) {
    return {
      nivel: 'ok',
      diagnostico: 'Faixa Ideal',
      impacto: 'Conforto visual balanceado, contraste perfeito e clareza.',
      sugestao: 'Iluminação ideal. Nenhuma ação necessária.'
    };
  }
  if (valor <= cfg.criticoAlto) {
    return {
      nivel: 'atencao',
      diagnostico: 'Iluminação Alta',
      impacto: 'Possível reflexo incômodo em telas e brilho elevado.',
      sugestao: 'Use difusores, cortinas ou reduza as fontes de luz.'
    };
  }
  return {
    nivel: 'critico',
    diagnostico: 'Ofuscamento / Excesso',
    impacto: 'Dor ocular, estresse visual e saturação em câmeras.',
    sugestao: 'Feche cortinas/persianas e reduza a luz direta sobre o espaço.'
  };
}

// A pressão é avaliada pelo gradiente barométrico (variação em ~2h),
// e não pelo valor absoluto.
function classificarPressao(gradiente, horas) {
  const cfg = REGRAS.pressao;

  // Sem histórico suficiente para calcular tendência.
  if (horas < 0.5) {
    return {
      nivel: 'ok',
      diagnostico: 'Coletando Tendência',
      impacto: 'Aguardando histórico para avaliar a estabilidade barométrica.',
      sugestao: 'Sem dados suficientes ainda. Nenhuma ação necessária.'
    };
  }

  if (gradiente <= -cfg.limiteAlerta) {
    return {
      nivel: 'atencao',
      diagnostico: 'Tendência de Instabilidade',
      impacto: 'Aproximação de chuva/tempestade; sensibilidade em enxaqueca barométrica.',
      sugestao: 'Queda rápida de pressão: feche janelas para prevenir chuva e vento.'
    };
  }
  if (gradiente >= cfg.limiteAlerta) {
    return {
      nivel: 'atencao',
      diagnostico: 'Frente Fria / Massa Estável',
      impacto: 'Entrada de ar mais denso e seco.',
      sugestao: 'Elevação rápida de pressão: monitore a ventilação e a umidade.'
    };
  }
  return {
    nivel: 'ok',
    diagnostico: 'Pressão Estável',
    impacto: 'Condições atmosféricas estáveis sem interferência fisiológica.',
    sugestao: 'Pressão estável. Nenhuma ação necessária.'
  };
}

// =========================
// TENDÊNCIAS (para pressão e umidade)
// Calcula a variação de um campo na janela de ~2 horas.
// =========================
function calcularTendencia(leituras, campo) {
  if (!leituras || leituras.length < 2) {
    return { variacao2h: 0, horas: 0, delta: 0 };
  }

  const ultima = leituras[leituras.length - 1];
  const tUlt = new Date(ultima.data_registro).getTime();
  const inicioJanela = tUlt - 2 * 3600 * 1000;

  // Referência: leitura mais antiga dentro da janela de 2h.
  let ref = leituras[0];
  for (const l of leituras) {
    if (new Date(l.data_registro).getTime() >= inicioJanela) {
      ref = l;
      break;
    }
  }

  const tRef = new Date(ref.data_registro).getTime();
  const horas = (tUlt - tRef) / 3600000;
  const delta = Number(ultima[campo]) - Number(ref[campo]);
  const variacao2h = horas > 0 ? (delta / horas) * 2 : 0;

  return { variacao2h, horas, delta };
}

// =========================
// CLASSIFICAÇÃO GERAL (multivariável)
// Cenários prescritivos do documento, avaliados por prioridade.
// =========================
function classificarGeral(ctx) {
  const {
    temperatura, umidade, luminosidade,
    evalTemp, evalUmid, evalLux, evalPress,
    gradientePressao, umidadeSubindo, conforto
  } = ctx;

  const avaliacoes = [evalTemp, evalUmid, evalLux, evalPress];
  const criticos = avaliacoes.filter((e) => e.nivel === 'critico');

  // Com a escala: "alta" = Atenção/Desconforto – calor; "baixa" = Atenção/Desconforto – frio.
  const tempAlta = conforto ? conforto.indice >= 3 : temperatura > REGRAS.temperatura.idealMax;
  const tempBaixa = conforto ? conforto.indice <= 1 : temperatura < REGRAS.temperatura.idealMin;
  const tempOk = evalTemp.nivel === 'ok';
  const umidOk = evalUmid.nivel === 'ok';
  const umidElevada = umidade > REGRAS.umidade.idealMax;
  const umidMediaAlta = umidade >= REGRAS.umidade.idealMin;

  // 1. Degradação severa: 3+ variáveis críticas (ex.: T > 27 °C, L < 200 lux, UR > 75%).
  if (criticos.length >= 3) {
    return {
      nivel: 'critico',
      titulo: 'Degradação Ambiental Severa',
      mensagem: 'Ambiente totalmente desajustado. Antes de iniciar as atividades, ajuste a ventilação (janela ou ventilador), acenda as luzes e verifique a circulação de ar.'
    };
  }

  // 2. Temperatura alta + Umidade elevada (cenário específico de abafamento).
  if (tempAlta && umidElevada) {
    return {
      nivel: 'critico',
      titulo: 'Ambiente Abafado com Estresse Térmico',
      mensagem: 'Percebo que o ambiente está quente e abafado. Abra as janelas para renovar o ar e ligue o ventilador. Se houver ar-condicionado, use o modo desumidificação.'
    };
  }

  // 3. Demais combinações com 2 variáveis críticas.
  if (criticos.length >= 2) {
    return {
      nivel: 'critico',
      titulo: 'Degradação Ambiental Severa',
      mensagem: 'Ambiente totalmente desajustado. Antes de iniciar as atividades, ajuste a ventilação (janela ou ventilador), acenda as luzes e verifique a circulação de ar.'
    };
  }

  // 4. Temperatura normal/alta + Umidade < 30%.
  if (!tempBaixa && umidade < REGRAS.umidade.criticoBaixo) {
    return {
      nivel: 'atencao',
      titulo: 'Ar Excessivamente Seco',
      mensagem: 'A temperatura está controlada, mas o ar está muito seco. Sugiro ligar um umidificador de ambiente e hidratar-se com frequência.'
    };
  }

  // 5. Temperatura baixa + Umidade média/alta.
  if (tempBaixa && umidMediaAlta) {
    return {
      nivel: 'atencao',
      titulo: 'Ambiente Frio e Úmido',
      mensagem: 'O ambiente está frio para permanência prolongada. Feche janelas e portas e, se necessário, vista um agasalho.'
    };
  }

  // 6. Temperatura e Umidade OK + Luminosidade > 2.200 lux.
  if (tempOk && umidOk && luminosidade > REGRAS.luminosidade.criticoAlto) {
    return {
      nivel: 'atencao',
      titulo: 'Desconforto Visual por Ofuscamento',
      mensagem: 'As condições térmicas estão boas, mas a claridade está excessiva. Sugiro fechar cortinas/persianas ou reposicionar as fontes de luz.'
    };
  }

  // 7. Temperatura e Umidade OK + Luminosidade < 200 lux.
  if (tempOk && umidOk && luminosidade < REGRAS.luminosidade.criticoBaixo) {
    return {
      nivel: 'atencao',
      titulo: 'Iluminação Crítica / Penumbra',
      mensagem: 'O espaço está escuro para trabalho ou gravação. Sugiro acender a iluminação principal ou ligar uma luz de apoio direcionada.'
    };
  }

  // 8. Queda brusca de Pressão + Umidade em elevação.
  if (gradientePressao <= -REGRAS.pressao.limiteAlerta && umidadeSubindo) {
    return {
      nivel: 'atencao',
      titulo: 'Instabilidade Climática Externa',
      mensagem: 'Detectada queda rápida na pressão com alta umidade externa. Sugiro fechar janelas para prevenir a entrada de chuva e vento forte.'
    };
  }

  // Todas as variáveis na faixa ideal.
  const temCritico = avaliacoes.some((e) => e.nivel === 'critico');
  const temAtencao = avaliacoes.some((e) => e.nivel === 'atencao');

  if (!temCritico && !temAtencao) {
    return {
      nivel: 'ok',
      titulo: 'Ambiente em Conforto Pleno',
      mensagem: 'O ambiente encontra-se em condições ideais de conforto térmico, higrométrico e luminoso. Nenhuma ação necessária.'
    };
  }

  // Fallback: combinações não previstas explicitamente no documento.
  const problemas = avaliacoes.filter((e) => e.nivel !== 'ok');
  const listaSugestoes = problemas.map((e) => e.sugestao).join(' ');

  return {
    nivel: temCritico ? 'critico' : 'atencao',
    titulo: 'Ajustes Pontuais Recomendados',
    mensagem: 'Algumas variáveis estão fora da faixa ideal. ' + listaSugestoes
  };
}

// =========================
// MONTAGEM DO RESUMO COMPLETO
// Recebe o array de leituras (ordem cronológica crescente).
// =========================
async function montarResumo(leituras) {
  const ultima = leituras[leituras.length - 1];

  const temperatura = Number(ultima.temperatura);
  const umidade = Number(ultima.umidade);
  const pressao = Number(ultima.pressao);
  const luminosidade = Number(ultima.luminosidade);

  const tendPressao = calcularTendencia(leituras, 'pressao');
  const tendUmidade = calcularTendencia(leituras, 'umidade');

  const conforto = await avaliarConfortoAtual(leituras);
  const evalTemp = conforto ? classificarTemperaturaEscala(conforto) : classificarTemperatura(temperatura);
  const evalUmid = classificarUmidade(umidade);
  const evalLux = classificarLuminosidade(luminosidade);
  const evalPress = classificarPressao(tendPressao.variacao2h, tendPressao.horas);

  const geral = classificarGeral({
    temperatura, umidade, luminosidade,
    evalTemp, evalUmid, evalLux, evalPress,
    gradientePressao: tendPressao.variacao2h,
    umidadeSubindo: tendUmidade.variacao2h > 3,
    conforto
  });

  return {
    classificacoes: {
      temperatura: { ...evalTemp, valor: temperatura, unidade: REGRAS.temperatura.unidade },
      umidade: { ...evalUmid, valor: umidade, unidade: REGRAS.umidade.unidade },
      pressao: {
        ...evalPress,
        valor: pressao,
        unidade: REGRAS.pressao.unidade,
        gradiente: Number(tendPressao.variacao2h.toFixed(2))
      },
      luminosidade: { ...evalLux, valor: luminosidade, unidade: REGRAS.luminosidade.unidade }
    },
    geral,
    conforto
  };
}

// =========================
// ROTAS
// =========================
app.get('/teste', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS servidor');

    res.status(200).json({
      status: 'ok',
      mensagem: 'API funcionando normalmente.',
      banco: 'db_leituras',
      servidor: result.rows[0].servidor
    });
  } catch (err) {
    console.error('Erro na rota /teste:', err.message);
    res.status(500).json({
      status: 'erro',
      mensagem: 'Falha ao consultar o banco.',
      detalhe: err.message
    });
  }
});

// =========================
// ROTA PARA GRAVAR DADOS (4 grandezas)
// =========================
app.post('/api/gravar', async (req, res) => {
  try {
    const { temperatura, umidade, pressao, luminosidade } = req.body;

    if (
      temperatura === undefined ||
      umidade === undefined ||
      pressao === undefined ||
      luminosidade === undefined
    ) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'Os campos temperatura, umidade, pressao e luminosidade são obrigatórios.'
      });
    }

    const temperaturaNum = parseFloat(temperatura);
    const umidadeNum = parseFloat(umidade);
    const pressaoNum = parseFloat(pressao);
    const luminosidadeNum = parseFloat(luminosidade);

    if (
      Number.isNaN(temperaturaNum) ||
      Number.isNaN(umidadeNum) ||
      Number.isNaN(pressaoNum) ||
      Number.isNaN(luminosidadeNum)
    ) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'Valores inválidos para uma ou mais grandezas.'
      });
    }

    // Escala de conforto da leitura individual (sem suavização/histerese),
    // gravada junto para análises e para a validação em campo.
    let c = null;
    try {
      const tm = await obterTextMensal();
      if (tm.valor !== null && tm.valor !== undefined) {
        c = await escala.avaliar(temperaturaNum + OFFSET_TEMPERATURA, tm.valor);
      }
    } catch (e) {
      console.error('Escala não calculada nesta leitura:', e.message);
    }

    const sql = `
      INSERT INTO pi_leituras_sensores
        (temperatura, umidade, pressao, luminosidade,
         text_mensal, temperatura_conforto, desvio_z, nivel_conforto, prob_frio, prob_calor)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, temperatura, umidade, pressao, luminosidade, data_registro, nivel_conforto
    `;

    const result = await pool.query(sql, [
      temperaturaNum, umidadeNum, pressaoNum, luminosidadeNum,
      c ? c.textMensal : null, c ? c.temperaturaConforto : null, c ? c.desvio : null,
      c ? c.nivel : null, c ? c.probFrio : null, c ? c.probCalor : null
    ]);

    return res.status(200).json({
      status: 'sucesso',
      mensagem: 'Dados gravados com sucesso.',
      dados: result.rows[0]
    });
  } catch (err) {
    console.error('Erro ao gravar dados:', err.message);
    return res.status(500).json({
      status: 'erro',
      mensagem: 'Erro ao gravar no banco de dados.',
      detalhe: err.message
    });
  }
});

// =========================
// LISTAR LEITURAS
// =========================
app.get('/api/leituras', async (req, res) => {
  try {
    const limite = parseInt(req.query.limite, 10) || 30;

    const sql = `
      SELECT id, temperatura, umidade, pressao, luminosidade, data_registro
      FROM pi_leituras_sensores
      ORDER BY id DESC
      LIMIT $1
    `;

    const result = await pool.query(sql, [limite]);
    const dados = result.rows.slice().reverse();

    return res.status(200).json({
      status: 'sucesso',
      quantidade: dados.length,
      leituras: dados
    });
  } catch (err) {
    console.error('Erro ao consultar leituras:', err.message);
    return res.status(500).json({
      status: 'erro',
      mensagem: 'Erro ao consultar leituras.',
      detalhe: err.message
    });
  }
});

// =========================
// ÚLTIMO STATUS DO AMBIENTE
// =========================
app.get('/api/status-estudio', async (req, res) => {
  try {
    // Traz a janela recente para permitir o cálculo de tendência (pressão/umidade).
    const sql = `
      SELECT id, temperatura, umidade, pressao, luminosidade, data_registro
      FROM pi_leituras_sensores
      ORDER BY id DESC
      LIMIT 200
    `;

    const result = await pool.query(sql);

    if (!result.rows.length) {
      return res.status(200).json({
        status: 'sucesso',
        mensagem: 'Nenhuma leitura encontrada.',
        dados: null
      });
    }

    const dados = result.rows.slice().reverse();
    const resumo = await montarResumo(dados);

    return res.status(200).json({
      status: 'sucesso',
      leitura: dados[dados.length - 1],
      ...resumo
    });
  } catch (err) {
    console.error('Erro ao consultar status do ambiente:', err.message);
    return res.status(500).json({
      status: 'erro',
      mensagem: 'Erro ao consultar status do ambiente.',
      detalhe: err.message
    });
  }
});

// =========================
// RESUMO PARA DASHBOARD
// =========================
app.get('/api/resumo-dashboard', async (req, res) => {
  try {
    // Janela ampla para gráficos de tendência e cálculo de gradiente.
    const limite = 200;

    const sql = `
      SELECT id, temperatura, umidade, pressao, luminosidade, data_registro
      FROM pi_leituras_sensores
      ORDER BY id DESC
      LIMIT $1
    `;

    const result = await pool.query(sql, [limite]);

    if (!result.rows.length) {
      return res.status(200).json({
        status: 'sucesso',
        metricas: null,
        leituras: [],
        classificacoes: null,
        geral: null
      });
    }

    const dados = result.rows.slice().reverse();
    const ultima = dados[dados.length - 1];

    const media = (campo) =>
      dados.reduce((acc, item) => acc + Number(item[campo]), 0) / dados.length;

    const resumo = await montarResumo(dados);

    return res.status(200).json({
      status: 'sucesso',
      metricas: {
        ultimaTemperatura: Number(ultima.temperatura),
        ultimaUmidade: Number(ultima.umidade),
        ultimaPressao: Number(ultima.pressao),
        ultimaLuminosidade: Number(ultima.luminosidade),
        mediaTemperatura: Number(media('temperatura').toFixed(2)),
        mediaUmidade: Number(media('umidade').toFixed(2)),
        mediaPressao: Number(media('pressao').toFixed(2)),
        mediaLuminosidade: Number(media('luminosidade').toFixed(0)),
        ultimaAtualizacao: ultima.data_registro
      },
      leituras: dados,
      classificacoes: resumo.classificacoes,
      geral: resumo.geral,
      conforto: resumo.conforto
    });
  } catch (err) {
    console.error('Erro ao montar resumo do dashboard:', err.message);
    return res.status(500).json({
      status: 'erro',
      mensagem: 'Erro ao montar resumo do dashboard.',
      detalhe: err.message
    });
  }
});

// =========================
// VOTOS DE SENSAÇÃO TÉRMICA (validação da escala em campo)
// =========================
const PREFERENCIAS = ['mais_quente', 'sem_mudanca', 'mais_frio'];

app.post('/api/votos', async (req, res) => {
  try {
    const voto = Number(req.body.voto);
    const preferencia = req.body.preferencia || null;
    if (!Number.isInteger(voto) || voto < -3 || voto > 3) {
      return res.status(400).json({ status: 'erro', mensagem: 'O voto deve ser um número inteiro de -3 a +3.' });
    }
    if (preferencia !== null && !PREFERENCIAS.includes(preferencia)) {
      return res.status(400).json({ status: 'erro', mensagem: 'Preferência inválida.' });
    }

    // Associa o voto à situação exibida no painel naquele momento.
    const r = await pool.query(`
      SELECT id, temperatura, umidade, pressao, luminosidade, data_registro
      FROM pi_leituras_sensores ORDER BY id DESC LIMIT 200`);
    const dados = r.rows.slice().reverse();
    const ultima = dados[dados.length - 1] || null;
    const c = dados.length ? await avaliarConfortoAtual(dados) : null;

    const ins = await pool.query(`
      INSERT INTO votos_conforto
        (voto, preferencia, leitura_id, temperatura, umidade, text_mensal, desvio_z, nivel_exibido, prob_frio, prob_calor)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, registrado_em`, [
      voto, preferencia, ultima ? ultima.id : null,
      c ? c.temperaturaInterna : (ultima ? ultima.temperatura : null), ultima ? ultima.umidade : null,
      c ? c.textMensal : null, c ? c.desvio : null, c ? c.nivel : null, c ? c.probFrio : null, c ? c.probCalor : null
    ]);

    return res.status(201).json({ status: 'sucesso', mensagem: 'Voto registrado. Obrigado!', voto: ins.rows[0], nivelExibido: c ? c.nivel : null });
  } catch (err) {
    console.error('Erro ao registrar voto:', err.message);
    return res.status(500).json({ status: 'erro', mensagem: 'Erro ao registrar voto.', detalhe: err.message });
  }
});

// Resumo dos votos por nível exibido (tabela da validação em campo).
app.get('/api/votos/resumo', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT nivel_exibido,
             COUNT(*)::int AS votos,
             SUM(CASE WHEN voto >= 2 THEN 1 ELSE 0 END)::int AS calor,
             SUM(CASE WHEN voto <= -2 THEN 1 ELSE 0 END)::int AS frio,
             ROUND(AVG(voto)::numeric, 2) AS voto_medio
      FROM votos_conforto
      GROUP BY nivel_exibido
      ORDER BY MIN(desvio_z)`);
    const total = r.rows.reduce((a, l) => a + l.votos, 0);
    return res.status(200).json({ status: 'sucesso', total, porNivel: r.rows });
  } catch (err) {
    console.error('Erro ao resumir votos:', err.message);
    return res.status(500).json({ status: 'erro', mensagem: 'Erro ao resumir votos.', detalhe: err.message });
  }
});

// =========================
// INICIALIZAÇÃO
// =========================
escala.carregarModelo();
obterTextMensal().then((tm) => console.log('Temperatura externa média (30 dias):', tm.valor, tm.fonte || tm.erro));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
