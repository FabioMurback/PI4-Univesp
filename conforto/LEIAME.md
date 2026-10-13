# Escala indicativa de conforto térmico (PJI410)

Implementa a escala do Relatório Final (seção 3.2): temperatura de conforto adaptativa
`Tc = 0,31 · text + 17,8` (ASHRAE 55), com `text` = média de 30 dias da temperatura externa,
e probabilidades de frio/conforto/calor estimadas pelo modelo adaptativo probabilístico
treinado na ASHRAE Global Thermal Comfort Database II.

| Nível | Temperatura interna |
|---|---|
| Desconforto – frio | abaixo de Tc − 3,5 °C |
| Atenção – frio | de Tc − 3,5 a Tc − 0,9 °C |
| Confortável | de Tc − 0,9 a Tc + 2,6 °C |
| Atenção – calor | de Tc + 2,6 a Tc + 3,5 °C |
| Desconforto – calor | acima de Tc + 3,5 °C |

## Arquivos
- `escala.js` – cálculo do nível, probabilidades, recomendação e histerese (0,3 °C).
- `clima.js` – média de 30 dias da Open-Meteo (cache de 6 h).
- `modelo_conforto.onnx` – modelo (entrada: [ta, text]); usado se `onnxruntime-node` estiver instalado.
  Sem ele, `escala.js` usa os mesmos coeficientes em JavaScript (resultado idêntico).
- `limites_escala.json` – limites da escala.

## Variáveis de ambiente (Render → Environment)
| Variável | Padrão | Uso |
|---|---|---|
| `LATITUDE`, `LONGITUDE` | -21.79, -46.57 (Poços de Caldas) | local da temperatura externa |
| `OFFSET_TEMPERATURA` | 0 | correção de aferição do BME280 (°C); ex.: `-0.8` se o sensor lê 0,8 °C acima do termômetro de referência |
| `TEXT_MENSAL_FIXA` | — | fixa a temperatura externa média (apenas para testes) |

## Rotas novas
- `GET /api/resumo-dashboard` e `GET /api/status-estudio` passam a trazer o objeto `conforto`.
- `POST /api/votos` `{ "voto": -3..3, "preferencia": "mais_quente" | "sem_mudanca" | "mais_frio" }`
- `GET /api/votos/resumo` – votos por nível exibido (validação em campo).

## Banco de dados
Criado automaticamente na inicialização: novas colunas em `pi_leituras_sensores`
(`text_mensal`, `temperatura_conforto`, `desvio_z`, `nivel_conforto`, `prob_frio`, `prob_calor`)
e a tabela `votos_conforto`.
