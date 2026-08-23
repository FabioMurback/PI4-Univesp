// =========================================================
// Monitor de Conforto Ambiental - ESP32
// Sensores:
//   - BME280 (I2C): Temperatura, Umidade Relativa e Pressao Atmosferica
//   - BH1750 (I2C): Luminosidade (lux)
// Envia os 4 valores via HTTPS (JSON) para a API no Render.
// =========================================================

// importando as bibliotecas necessarias
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <BH1750.h>

// =========================
// Configurando o WIFI
// coloque o nome da sua rede wifi em ssid
// coloque a senha da sua rede wifi em password
// =========================
const char* ssid = "LoWiSecD";
const char* password = "naaSs!sprocureis0rv&teenAo@chei";

// URL pública do Render
const char* apiUrl = "https://univesp-pi3-v0wv.onrender.com/api/gravar";

// =========================
// SENSORES (barramento I2C)
// Ligacao padrao no ESP32: SDA = GPIO21, SCL = GPIO22
// BME280 -> endereco 0x76 (alguns modulos usam 0x77)
// BH1750 -> endereco 0x23
// =========================
#define BME280_ENDERECO 0x76
#define SEA_LEVEL_PRESSURE_HPA 1013.25  // referencia (apenas p/ calculo de altitude, opcional)

Adafruit_BME280 bme;
BH1750 luximetro;

bool bmeOk = false;
bool bhOk = false;

// =========================
// WIFI
// =========================
void conectarWiFi() {
  Serial.print("Conectando ao Wi-Fi");
  WiFi.begin(ssid, password);

  int tentativas = 0;
  while (WiFi.status() != WL_CONNECTED && tentativas < 40) {
    delay(500);
    Serial.print(".");
    tentativas++;
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Wi-Fi conectado com sucesso!");
    Serial.print("IP do ESP32: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Falha ao conectar ao Wi-Fi.");
  }
}

// =========================
// INICIALIZACAO DOS SENSORES
// =========================
void iniciarSensores() {
  Wire.begin();  // SDA=21, SCL=22 (padrao ESP32)

  // BME280 - temperatura, umidade e pressao
  bmeOk = bme.begin(BME280_ENDERECO);
  if (!bmeOk) {
    // tenta o endereco alternativo
    bmeOk = bme.begin(0x77);
  }
  if (bmeOk) {
    Serial.println("BME280 inicializado com sucesso.");
  } else {
    Serial.println("Falha ao inicializar o BME280. Verifique a ligacao/endereco.");
  }

  // BH1750 - luminosidade
  bhOk = luximetro.begin(BH1750::CONTINUOUS_HIGH_RES_MODE);
  if (bhOk) {
    Serial.println("BH1750 inicializado com sucesso.");
  } else {
    Serial.println("Falha ao inicializar o BH1750. Verifique a ligacao/endereco.");
  }
}

// =========================
// ENVIO HTTPS PARA O RENDER
// =========================
// Numero maximo de tentativas de envio (cobre o "cold start" do Render free).
#define MAX_TENTATIVAS_ENVIO 4

bool enviarDados(float temperatura, float umidade, float pressao, float luminosidade) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi desconectado. Tentando reconectar...");
    conectarWiFi();

    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("Nao foi possivel reconectar ao Wi-Fi.");
      return false;
    }
  }

  // Monta o JSON uma unica vez.
  String json = "{";
  json += "\"temperatura\":" + String(temperatura, 2) + ",";
  json += "\"umidade\":" + String(umidade, 2) + ",";
  json += "\"pressao\":" + String(pressao, 2) + ",";
  json += "\"luminosidade\":" + String(luminosidade, 2);
  json += "}";

  for (int tentativa = 1; tentativa <= MAX_TENTATIVAS_ENVIO; tentativa++) {
    WiFiClientSecure client;
    client.setInsecure();  // para testes; em produção prefira validar certificado

    HTTPClient http;

    Serial.print("Tentativa ");
    Serial.print(tentativa);
    Serial.print(" - Conectando à URL: ");
    Serial.println(apiUrl);

    if (!http.begin(client, apiUrl)) {
      Serial.println("Falha ao iniciar conexao HTTPS.");
      delay(3000);
      continue;
    }

    http.setTimeout(20000);
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);  // segue redirecionamentos
    http.addHeader("Content-Type", "application/json");

    Serial.print("JSON enviado: ");
    Serial.println(json);

    int codigoHTTP = http.POST(json);
    String resposta = http.getString();

    Serial.print("Codigo HTTP: ");
    Serial.println(codigoHTTP);
    Serial.print("Resposta da API: ");
    Serial.println(resposta);

    // Sucesso somente para respostas 2xx.
    if (codigoHTTP >= 200 && codigoHTTP < 300) {
      http.end();
      return true;
    }

    // 404/502/503 costumam indicar o servico "acordando" (cold start).
    if (codigoHTTP == 404 || codigoHTTP == 502 || codigoHTTP == 503) {
      Serial.println("Servico possivelmente inicializando. Aguardando para tentar novamente...");
    } else if (codigoHTTP <= 0) {
      Serial.print("Erro de conexao: ");
      Serial.println(http.errorToString(codigoHTTP));
    } else {
      Serial.print("Resposta inesperada da API. Codigo: ");
      Serial.println(codigoHTTP);
    }

    http.end();

    if (tentativa < MAX_TENTATIVAS_ENVIO) {
      delay(5000);  // aguarda o servico ficar disponivel
    }
  }

  Serial.println("Falha ao enviar apos multiplas tentativas.");
  return false;
}

// =========================
// TESTE OPCIONAL DE SAÚDE DA API
// =========================
void testarAPI() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  String urlTeste = "https://univesp-pi3-v0wv.onrender.com/teste";

  Serial.println("Testando rota /teste...");

  if (!http.begin(client, urlTeste)) {
    Serial.println("Falha ao abrir rota /teste.");
    return;
  }

  http.setTimeout(15000);
  int codigoHTTP = http.GET();

  if (codigoHTTP > 0) {
    Serial.print("GET /teste HTTP: ");
    Serial.println(codigoHTTP);
    Serial.println(http.getString());
  } else {
    Serial.print("Erro no GET /teste: ");
    Serial.println(http.errorToString(codigoHTTP));
  }

  http.end();
}

// =========================
// SETUP
// =========================
void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("Inicializando sensores...");
  iniciarSensores();

  conectarWiFi();

  if (WiFi.status() == WL_CONNECTED) {
    testarAPI();
  }
}

// =========================
// LOOP
// =========================
void loop() {
  delay(10000);

  if (!bmeOk || !bhOk) {
    Serial.println("Sensores nao inicializados corretamente. Tentando reiniciar sensores...");
    iniciarSensores();
    if (!bmeOk || !bhOk) {
      return;
    }
  }

  float temperatura = bme.readTemperature();          // °C
  float umidade = bme.readHumidity();                 // % UR
  float pressao = bme.readPressure() / 100.0F;        // hPa
  float luminosidade = luximetro.readLightLevel();    // lux

  if (isnan(temperatura) || isnan(umidade) || isnan(pressao)) {
    Serial.println("Falha ao ler o sensor BME280.");
    return;
  }

  if (luminosidade < 0) {
    Serial.println("Falha ao ler o sensor BH1750.");
    return;
  }

  Serial.print("Temperatura: ");
  Serial.print(temperatura);
  Serial.print(" °C | Umidade: ");
  Serial.print(umidade);
  Serial.print(" % | Pressao: ");
  Serial.print(pressao);
  Serial.print(" hPa | Luminosidade: ");
  Serial.print(luminosidade);
  Serial.println(" lux");

  bool sucesso = enviarDados(temperatura, umidade, pressao, luminosidade);

  if (sucesso) {
    Serial.println("Envio concluido com sucesso.");
  } else {
    Serial.println("Falha no envio para a API.");
  }

  Serial.println("-----------------------------------");
}
