# Shopee NF Sync

Servico que detecta pedidos Shopee sem dados fiscais, busca a NF-e autorizada no Bling e envia pra Shopee + dispara "Organizar Envio".

**Loja atual:** AMBTotal (teste e validacao)
**Futuro:** quando funcionar, esse codigo sera incorporado como modulo dentro de um service Render consolidado (junto com mover-pedidos e outros).

## Problema que resolve

NF emitida no Bling mas dados fiscais nao chegam na Shopee. Pedido fica travado em "A Enviar" mostrando "Enviar NF-e" em vez de "Ver Dados da NF-e".

Solucao automatica:
1. Lista pedidos Shopee `READY_TO_SHIP`
2. Detecta sem NF (campo `invoice_data` vazio)
3. Busca pedido no Bling via `numeroLoja = order_sn`
4. Baixa XML autorizado do Bling
5. Envia XML pra Shopee
6. Dispara "Organizar Envio"

Cron: a cada 10min, 06h-22h horario de Sao Paulo.

---

## Deploy Render

### Configuracao do service
- **Name:** `ambtotal-shopee-nf-sync`
- **Region:** Oregon
- **Branch:** main
- **Build:** `npm install`
- **Start:** `npm start`
- **Plan:** Free

### Environment Variables

```
TZ=America/Sao_Paulo

# Bling AMBTotal app "NF Shopee Sync"
BLING_CLIENT_ID=<do app>
BLING_CLIENT_SECRET=<do app>

# Shopee AMBTotal app
SHOPEE_PARTNER_ID=1233726
SHOPEE_PARTNER_KEY=<Test API Partner Key>
SHOPEE_BASE_URL=https://partner.test-stable.shopeemobile.com

# Opcional (sem isso o servico funciona, so nao loga em Supabase)
SUPABASE_URL=<se quiser usar>
SUPABASE_SERVICE_KEY=<se quiser usar>
```

### Quando for pra producao (apos Go-Live aprovado)
Mudar:
- `SHOPEE_BASE_URL` para `https://partner.shopeemobile.com`
- `SHOPEE_PARTNER_ID` e `SHOPEE_PARTNER_KEY` para credenciais Live (novas, diferentes das Test)

---

## OAuth inicial

### Bling

1. Cole no navegador logado no Bling AMBTotal:
```
https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=<BLING_CLIENT_ID>&state=oauth_init
```

2. Redirect retorna `?code=XXXX`. Copie rapido (code expira em 1min).

3. POST imediato:
```bash
curl -X POST https://ambtotal-shopee-nf-sync.onrender.com/setup-bling \
  -H "Content-Type: application/json" \
  -d '{"code": "COLE_O_CODE"}'
```

### Shopee

1. No Shopee Open Platform, painel do app, gere o invite URL de autorizacao
2. Loja AMBTotal autoriza, sera redirecionada pra
   `https://ambtotal-shopee-nf-sync.onrender.com/oauth/callback-shopee?code=...&shop_id=...`
3. Callback troca por tokens automaticamente. Voce ve tela "Autorizada com sucesso".

---

## Endpoints

| Metodo | Path | Pra que serve |
|---|---|---|
| GET | `/` | Info geral |
| GET | `/health` | Ping |
| GET | `/status` | Estado dos tokens |
| POST | `/setup-bling` | Salva tokens Bling apos OAuth |
| GET | `/oauth/callback-shopee` | Callback OAuth Shopee |
| POST | `/setup-shopee` | Alternativa manual ao callback |
| GET | `/pendentes` | Lista pedidos detectados (dry-run) |
| POST | `/sincronizar/:orderSn` | Forca sincronizacao de 1 pedido |
| POST | `/sincronizar-ciclo` | Forca ciclo completo agora |
| GET | `/logs?limit=50` | Ultimas execucoes (precisa Supabase) |

---

## Teste inicial

Pedidos AMBTotal identificados como travados:
- **260516GU8E75MH** (Bling pedido 793)
- **260516JKM2JTB0** (Bling pedido 816)

Sequencia:
1. `GET /pendentes` -> confirma deteccao
2. `POST /sincronizar/260516GU8E75MH` -> teste 1 (aguarda 30s + ship_order)
3. Validar no Shopee Seller Center: acao deve mudar de "Enviar NF-e" pra "Ver Dados da NF-e"
4. `POST /sincronizar/260516JKM2JTB0` -> teste 2
5. Cron toma conta do resto

---

## Tabela Supabase (opcional)

```sql
CREATE TABLE shopee_nf_sync (
  id BIGSERIAL PRIMARY KEY,
  loja TEXT NOT NULL,
  order_sn TEXT NOT NULL,
  pedido_bling_id BIGINT,
  nfe_id BIGINT,
  chave_acesso TEXT,
  status TEXT,
  etapa TEXT,
  erro TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_shopee_nf_sync_order_sn ON shopee_nf_sync(order_sn);
```

---

## Limitacoes conhecidas

- ⚠️ **Endpoint `upload_invoice_document`** precisa confirmacao na doc Shopee (TODO_DOC em `modules/shopee-api.js`)
- ⚠️ **Heuristica `pedidoEstaPendenteDeNf`** pode precisar ajuste apos primeiro teste real
- ⚠️ Janela de 3 dias na deteccao automatica. Pedidos antigos: use POST manual

---

## Autenticacao Bling — JWT (JWT-ready desde nascimento)

Este servico ja nasce no padrao novo do Bling. A partir de 30/06/2026, o Bling vai descontinuar tokens opacos antigos. Este codigo ja envia `enable-jwt: 1` em todas as requisicoes OAuth e API.

**Onde:**
- `modules/token-manager.js` no setup (`/oauth/token`) e refresh
- `modules/bling-api.js` em todas requisicoes `blingFetch`

**Implicacoes:**
- Tokens armazenados sao maiores (1500-3000 chars vs ~40 antes) — sem problema
- Header `Authorization: Bearer <token>` continua igual
- Refresh token tambem vira JWT

**Importante:** quando integrar este modulo no service consolidado (futuro), os outros modulos (mover-pedidos, corrigir-nfs, etc) tambem precisarao ser migrados pra JWT antes de 30/06/2026.

---

## Estrutura

```
shopee-nf-sync/
├── server.js
├── package.json
├── README.md
├── .gitignore
└── modules/
    ├── token-manager.js     # Bling auth + refresh
    ├── bling-api.js         # buscar pedido + baixar XML
    ├── shopee-api.js        # auth, listar, uploadInvoice, shipOrder
    ├── sync-engine.js       # ciclo completo + sincronizar 1
    └── supabase-log.js      # logs (loja='AMBTotal' hardcoded)
```

## Plano de consolidacao futura

Quando esse servico funcionar 100% pra AMBTotal, sera incorporado como modulo dentro do service Render `mover-pedidos-aguardando-x-atendido` (ou similar), seguindo o mesmo padrao que ja foi feito com Girassol/AMBTotal mover-pedidos. Estrutura prevista:

```
service-consolidado/
├── /girassol      <- ja existe
├── /amb           <- ja existe
└── /shopee-nf     <- novo modulo, codigo deste repo
```

Migracao envolvera:
- Mover arquivos pra subfolder `/shopee-nf/`
- Adicionar parametro `loja` aos modulos (em vez de hardcoded)
- Unificar env vars com prefixos (`AMB_SHOPEE_PARTNER_ID` etc)
- 1 cron unificado disparando 1 ciclo por loja
