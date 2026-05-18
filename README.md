# AMBTotal Shopee NF Sync

Servico que automatiza o envio de NF-e do Bling pra Shopee para a loja AMBTotal.

## Problema que resolve

Quando uma NF eh emitida no Bling, normalmente o Bling envia os dados fiscais pra Shopee automaticamente. Em ~5-10% dos casos isso falha silenciosamente e o pedido fica travado em "A Enviar" na Shopee, mostrando o botao "Enviar NF-e" em vez de "Ver Dados da NF-e".

Esse servico:
1. Lista pedidos Shopee em status `READY_TO_SHIP`
2. Detecta quais nao tem NF-e enviada (campo `invoice_data` vazio)
3. Busca a NF autorizada correspondente no Bling (via `numeroLoja = order_sn`)
4. Baixa o XML autorizado do Bling
5. Envia o XML pra Shopee via API oficial
6. Dispara "Organizar Envio" automaticamente

Roda a cada 10 minutos, das 06h as 22h (horario de Sao Paulo).

---

## Pre-requisitos antes do deploy

### 1. Criar APP Bling AMBTotal "NF-Shopee-Sync"

No painel Bling > Aplicativos > Criar:
- Nome: **NF Shopee Sync AMBTotal**
- Escopos OBRIGATORIOS:
  - **Pedidos de Venda > Leitura**
  - **Notas Fiscais Eletronicas > Leitura**  (CRITICO: pra baixar XML autorizado)

Anote: `client_id`, `client_secret`, `redirect_uri`

### 2. Criar / confirmar APP Shopee AMBTotal

No Shopee Open Platform > seu app:
- Confirmar que tem permissao pras seguintes APIs:
  - `order.get_order_list`
  - `order.get_order_detail`
  - `order.upload_invoice_document` ← **CONFIRMAR NOME EXATO** (ver TODO_DOC em shopee-api.js)
  - `logistics.get_shipping_parameter`
  - `logistics.ship_order`
- Adicionar IP do Render no IP Whitelist (ver passo 5)

Anote: `partner_id`, `partner_key`, `shop_id`

### 3. Criar tabela Supabase

```sql
CREATE TABLE shopee_nf_sync (
  id BIGSERIAL PRIMARY KEY,
  loja TEXT NOT NULL,
  order_sn TEXT NOT NULL,
  pedido_bling_id BIGINT,
  nfe_id BIGINT,
  chave_acesso TEXT,
  status TEXT,         -- 'sucesso' | 'erro' | 'sem_nf_bling' | 'ja_sincronizado'
  etapa TEXT,          -- 'detect' | 'upload_invoice' | 'ship_order' | 'manual_sync'
  erro TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_shopee_nf_sync_order_sn ON shopee_nf_sync(order_sn);
CREATE INDEX idx_shopee_nf_sync_criado_em ON shopee_nf_sync(criado_em);
```

---

## Deploy no Render

### Passo 1: criar repo no GitHub

1. Crie repo publico chamado `ambtotal-shopee-nf-sync-x-bling` em `dimarquesmachado-sys`
2. Suba todos os arquivos desse projeto

### Passo 2: criar Web Service no Render

1. Render Dashboard > New > Web Service
2. Connect repo `ambtotal-shopee-nf-sync-x-bling`
3. Configuracao:
   - **Name**: `ambtotal-shopee-nf-sync`
   - **Region**: Oregon (mesmo dos outros)
   - **Branch**: main
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free

### Passo 3: configurar Environment Variables

Adicione no Render > Environment:

```
TZ=America/Sao_Paulo

# Bling AMBTotal NF-Shopee
BLING_CLIENT_ID=...
BLING_CLIENT_SECRET=...

# Shopee AMBTotal
SHOPEE_PARTNER_ID=...
SHOPEE_PARTNER_KEY=...

# Supabase (mesmo que voce ja usa nos outros servicos)
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
```

**Nao precisa colocar BLING_ACCESS_TOKEN, BLING_REFRESH_TOKEN, SHOPEE_ACCESS_TOKEN, SHOPEE_REFRESH_TOKEN, SHOPEE_SHOP_ID agora — vamos gerar via OAuth no proximo passo.**

### Passo 4: deploy e pegar IP estatico

1. Deploy automatico iniciara apos save
2. Aguarde build e deploy completo
3. Va em Settings > Network > **Enable outbound IPs** (Render Static Outbound IP)
4. Anote os 2-3 IPs que aparecem

### Passo 5: IP Whitelist Shopee

1. Volte no Shopee Open Platform > seu app
2. Va em Security/IP Whitelist
3. Adicione os IPs do Render anotados no passo 4
4. Salve

### Passo 6: OAuth inicial Bling

Numa aba do navegador logado no Bling AMBTotal, cole:
```
https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=SEU_CLIENT_ID&state=oauth_ambtotal_nf_shopee
```

Trocar `SEU_CLIENT_ID` pelo client_id do app criado no passo 1.

Voce vai ser redirecionado pra `redirect_uri` com `?code=XXXX` na URL.
Copie esse `code` rapido (vale 1 min).

Faca POST imediato (use Postman ou curl):
```bash
curl -X POST https://ambtotal-shopee-nf-sync.onrender.com/setup-bling \
  -H "Content-Type: application/json" \
  -d '{"code": "COLE_O_CODE_AQUI"}'
```

Resposta esperada: `{ "ok": true, "message": "Tokens Bling salvos", ... }`

### Passo 7: OAuth inicial Shopee

1. No Shopee Open Platform > seu app, clique em "Test Authorization" ou monte a URL:
```
https://partner.shopeemobile.com/api/v2/shop/auth_partner?partner_id=SEU_PARTNER_ID&timestamp=TS&sign=SIGN&redirect=URL_REDIRECT
```

(o link de auth a Shopee gera direto no console do app — eh mais facil ir por la)

2. Autoriza a loja AMBTotal
3. Voce vai ser redirecionado pra URL_REDIRECT com `?code=XXXX&shop_id=YYYY`
4. POST imediato:
```bash
curl -X POST https://ambtotal-shopee-nf-sync.onrender.com/setup-shopee \
  -H "Content-Type: application/json" \
  -d '{"code": "COLE_O_CODE", "shop_id": "COLE_O_SHOP_ID"}'
```

### Passo 8: validar

```bash
curl https://ambtotal-shopee-nf-sync.onrender.com/status
```

Deve mostrar `tem_access_token: true` pros dois.

```bash
curl https://ambtotal-shopee-nf-sync.onrender.com/pendentes
```

Deve listar os pedidos pendentes detectados (dry run).

---

## Como usar (apos deploy)

### Ver pedidos pendentes (sem sincronizar)
```bash
GET https://ambtotal-shopee-nf-sync.onrender.com/pendentes
```

### Sincronizar UM pedido manualmente (pra teste)
```bash
POST https://ambtotal-shopee-nf-sync.onrender.com/sincronizar/260516GU8E75MH
```

### Forcar ciclo completo agora
```bash
POST https://ambtotal-shopee-nf-sync.onrender.com/sincronizar-ciclo
Content-Type: application/json
{}
```

### Ver logs das ultimas execucoes
```bash
GET https://ambtotal-shopee-nf-sync.onrender.com/logs?limit=20
```

### Cron automatico
Ja roda a cada 10 min entre 06h-22h, sem intervencao.

---

## Plano de teste com os 2 pedidos travados

Pedidos identificados como travados:
- **260516GU8E75MH** (Bling pedido 793)
- **260516JKM2JTB0** (Bling pedido 816)

### Sequencia de teste

1. **Confirmar deteccao** (sem agir):
   ```
   GET /pendentes
   ```
   Esperado: lista contem os 2 order_sn acima.

2. **Sincronizar 1 pedido de teste**:
   ```
   POST /sincronizar/260516GU8E75MH
   ```
   Aguardar resposta. Esperado: `status: "sucesso"`.

3. **Validar no Shopee Seller Center**:
   Abrir o pedido na Shopee. As acoes devem mudar de "Enviar NF-e" pra "Ver Dados da NF-e" e o status pra "Pronto pra coleta".

4. **Sincronizar o outro**:
   ```
   POST /sincronizar/260516JKM2JTB0
   ```

5. **Conferir log Supabase**:
   ```
   GET /logs?limit=10
   ```

Se tudo OK, o cron toma conta do resto.

---

## Limitacoes conhecidas

- ⚠️ **Endpoint upload_invoice_document precisa confirmacao** (ver TODO_DOC em `modules/shopee-api.js`)
- ⚠️ **Heuristica de detecção** (`pedidoEstaPendenteDeNf`) pode precisar ajuste após primeiro teste real — depende dos campos exatos retornados em `invoice_data`
- ⚠️ Apenas pedidos dos ultimos 3 dias sao verificados. Pra reprocessar pedidos antigos, use POST /sincronizar/:orderSn manual.

---

## Troubleshooting

### Token Bling expirado
GET /status mostra `expirou: true`?
- Refresh automatico em todo request, mas se refresh_token expirou (30 dias sem uso), refaca passo 6 do deploy.

### Token Shopee expirado
Mesma logica. Refaca passo 7.

### Pedido nao aparece em /pendentes mas eu sei que ta travado
- Pode estar fora da janela de 3 dias. Use POST /sincronizar/:orderSn direto.

### Erro "uploadInvoice erro" no log
- Endpoint provavelmente nao confirmado (TODO_DOC). Confira nome na doc Shopee Open Platform.

---

## Arquitetura

```
ambtotal-shopee-nf-sync/
├── server.js                  # entrypoint + cron + rotas HTTP
├── package.json
├── README.md
├── .gitignore
└── modules/
    ├── token-manager.js       # rotacao auto tokens Bling
    ├── bling-api.js           # buscarPedido, baixarXmlAutorizado
    ├── shopee-api.js          # auth, listar, uploadInvoice, shipOrder
    ├── sync-engine.js         # ciclo completo, sincronizar 1 pedido
    └── supabase-log.js        # log de cada execucao
```
