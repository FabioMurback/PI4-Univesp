const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// =========================
// CONFIGURAÇÕES DO ESTÚDIO
// =========================
const REGRAS_ESTUDIO = {
  temperatura: {
    idealMin: 20,
    idealMax: 24,
    alertaMin: 18,
    alertaMax: 27
  },
  luminosidade: {
    idealMin: 1200,
    idealMax: 2600,
    alertaMin: 700,
    alertaMax: 3200
  }
};

// =========================
// MIDDLEWARES
// =========================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// =========================
// CONEXÃO COM POSTGRESQL
// =========================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

pool.connect()
  .then((client) => {
    console.log('Conectado ao PostgreSQL com sucesso.');
    client.release();
  })
  .catch((err) => {
    console.error('Erro ao conectar no PostgreSQL:', err.message);
  });

// =========================
// FUNÇÕES DE ALERTA
// =========================
function avaliarTemperatura(valor) {
  const cfg = REGRAS_ESTUDIO.temperatura;

  if (valor < cfg.alertaMin) {
    return {
      nivel: 'critico',
      titulo: 'Temperatura muito baixa',
      mensagem: 'O ambiente está frio demais e pode comprometer o conforto durante a gravação.'
    };
  }

  if (valor > cfg.alertaMax) {
    return {
      nivel: 'critico',
      titulo: 'Temperatura muito alta',
      mensagem: 'O ambiente está quente demais e pode gerar desconforto, fadiga e queda de desempenho.'
    };
  }

  if (valor < cfg.idealMin) {
    return {
      nivel: 'atencao',
      titulo: 'Temperatura abaixo da faixa ideal',
      mensagem: 'O estúdio está um pouco frio. Avalie ajustar ventilação ou climatização.'
    };
  }

  if (valor > cfg.idealMax) {
    return {
      nivel: 'atencao',
      titulo: 'Temperatura acima da faixa ideal',
      mensagem: 'O estúdio está um pouco quente. Avalie ventilação, climatização ou pausas.'
    };
  }

  return {
    nivel: 'ok',
    titulo: 'Temperatura adequada',
    mensagem: 'A temperatura está dentro da faixa recomendada para uso do estúdio.'
  };
}

function avaliarLuminosidade(valor) {
  const cfg = REGRAS_ESTUDIO.luminosidade;

  if (valor < cfg.alertaMin) {
    return {
      nivel: 'critico',
      titulo: 'Iluminação muito baixa',
      mensagem: 'O ambiente está escuro demais para gravações com boa qualidade visual.'
    };
  }

  if (valor > cfg.alertaMax) {
    return {
      nivel: 'critico',
      titulo: 'Iluminação excessiva',
      mensagem: 'A luminosidade está muito alta e pode gerar ofuscamento ou desconforto visual.'
    };
  }

  if (valor < cfg.idealMin) {
    return {
      nivel: 'atencao',
      titulo: 'Iluminação abaixo da faixa ideal',
      mensagem: 'A iluminação está um pouco baixa. Avalie reforçar a luz do ambiente.'
    };
  }

  if (valor > cfg.idealMax) {
    return {
      nivel: 'atencao',
      titulo: 'Iluminação acima da faixa ideal',
      mensagem: 'A iluminação está acima do ideal. Avalie difusores, cortinas ou reposicionamento.'
    };
  }

  return {
    nivel: 'ok',
    titulo: 'Iluminação adequada',
    mensagem: 'A luminosidade está dentro da faixa recomendada para o estúdio.'
  };
}

function gerarResumoLeitura(leitura) {
  const alertaTemp = avaliarTemperatura(Number(leitura.temperatura));
  const alertaLum = avaliarLuminosidade(Number(leitura.luminosidade));

  let nivelGeral = 'ok';

  if (alertaTemp.nivel === 'critico' || alertaLum.nivel === 'critico') {
    nivelGeral = 'critico';
  } else if (alertaTemp.nivel === 'atencao' || alertaLum.nivel === 'atencao') {
    nivelGeral = 'atencao';
  }

  return {
    leitura,
    alertas: {
      temperatura: alertaTemp,
      luminosidade: alertaLum,
      geral: nivelGeral
    }
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
// ROTA PARA GRAVAR DADOS
// =========================
app.post('/api/gravar', async (req, res) => {
  try {
    const { temperatura, luminosidade } = req.body;

    if (temperatura === undefined || luminosidade === undefined) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'Os campos temperatura e luminosidade são obrigatórios.'
      });
    }

    const temperaturaNum = parseFloat(temperatura);
    const luminosidadeNum = parseInt(luminosidade, 10);

    if (Number.isNaN(temperaturaNum) || Number.isNaN(luminosidadeNum)) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'Valores inválidos para temperatura ou luminosidade.'
      });
    }

    const sql = `
      INSERT INTO pi_leituras_sensores (temperatura, luminosidade)
      VALUES ($1, $2)
      RETURNING id, temperatura, luminosidade, data_registro
    `;

    const result = await pool.query(sql, [temperaturaNum, luminosidadeNum]);

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
      SELECT id, temperatura, luminosidade, data_registro
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
// ÚLTIMO STATUS DO ESTÚDIO
// =========================
app.get('/api/status-estudio', async (req, res) => {
  try {
    const sql = `
      SELECT id, temperatura, luminosidade, data_registro
      FROM pi_leituras_sensores
      ORDER BY id DESC
      LIMIT 1
    `;

    const result = await pool.query(sql);

    if (!result.rows.length) {
      return res.status(200).json({
        status: 'sucesso',
        mensagem: 'Nenhuma leitura encontrada.',
        dados: null
      });
    }

    const resumo = gerarResumoLeitura(result.rows[0]);

    return res.status(200).json({
      status: 'sucesso',
      ...resumo
    });
  } catch (err) {
    console.error('Erro ao consultar status do estúdio:', err.message);
    return res.status(500).json({
      status: 'erro',
      mensagem: 'Erro ao consultar status do estúdio.',
      detalhe: err.message
    });
  }
});

// =========================
// RESUMO PARA DASHBOARD
// =========================
app.get('/api/resumo-dashboard', async (req, res) => {
  try {
    const limite = 30;

    const sql = `
      SELECT id, temperatura, luminosidade, data_registro
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
        alertas: null
      });
    }

    const dados = result.rows.slice().reverse();
    const ultima = dados[dados.length - 1];

    const mediaTemp = dados.reduce((acc, item) => acc + Number(item.temperatura), 0) / dados.length;
    const mediaLum = dados.reduce((acc, item) => acc + Number(item.luminosidade), 0) / dados.length;

    const resumo = gerarResumoLeitura(ultima);

    return res.status(200).json({
      status: 'sucesso',
      metricas: {
        ultimaTemperatura: Number(ultima.temperatura),
        ultimaLuminosidade: Number(ultima.luminosidade),
        mediaTemperatura: Number(mediaTemp.toFixed(2)),
        mediaLuminosidade: Math.round(mediaLum),
        ultimaAtualizacao: ultima.data_registro
      },
      leituras: dados,
      alertas: resumo.alertas
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
// INICIALIZAÇÃO
// =========================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});