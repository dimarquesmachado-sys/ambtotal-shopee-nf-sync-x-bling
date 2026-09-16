# Shopee — mudanças nas APIs de NF do Full (FBS), válidas a partir de 30/10/2026

Aviso recebido por e-mail em 16/09/2026. Abaixo, o que **nos** afeta — conferido no código,
não suposto.

## ⏰ O que quebra se ninguém fizer nada

**O CNPJ passa a ser obrigatório** no `generate_fbs_invoices`, um por requisição, e precisa
ser de uma filial registrada do seller. Hoje chamamos **sem** esse campo.

A partir de 30/10 a importação das NF-e do Shopee Full para de funcionar — e do nosso lado
isso aparece como falha genérica na geração, não como "faltou CNPJ".

## O que NÃO nos afeta

| mudança do aviso | por que não afeta |
|---|---|
| novo `file_name` `{CNPJ}FULLInvoiceXML{n}.zip` | nós mesmos nomeamos os zips que salvamos (`<loja>-saida-atual.zip`) |
| novos `document_type` (8 a 13) | só pedimos os tipos que já usamos; nenhum vira obrigatório |
| `document_status = 3` (inutilizada) | é **opt-in**: sem informar, o padrão segue trazendo autorizadas e canceladas |
| `download_fbs_invoices` | o aviso diz explicitamente que não muda |

## O que já está pronto

`modules/fbs-nf.js` envia o CNPJ quando `FBS_ENVIAR_CNPJ=1`, lendo de `FBS_CNPJ_<LOJA>`
(aceita com ou sem pontuação). Com a chave ligada e sem CNPJ configurado, **falha alto** em
vez de mandar a requisição incompleta.

Está atrás de uma chave de propósito: não dá para testar a API da Shopee daqui, e mandar um
campo novo **antes** de a mudança valer pode ser aceito ou pode dar erro — errar aqui
derrubaria a importação de hoje para consertar um problema de outubro.

## O CNPJ o sistema descobre sozinho

O dono confirmou que **não há CNPJ separado de filial** — é o mesmo da empresa. Então não há o
que digitar: a **chave de acesso** de toda NF-e que já importamos carrega o CNPJ do emitente
nas posições 7 a 20, e nós já guardamos essas chaves por loja para deduplicar.

Usa-se o CNPJ **mais frequente** entre as notas de saída, não o da primeira: uma nota de outro
emitente no meio do pacote (já aconteceu com pedido que o token alcança e não é da empresa)
não pode decidir sozinha.

`FBS_CNPJ_<LOJA>` continua existindo e **ganha** do descoberto — se um dia a Shopee exigir um
CNPJ diferente, basta defini-la, sem mexer em código.

## O que falta, e quando

1. **Ligar `FBS_ENVIAR_CNPJ=1`** no Render e rodar uma importação. Se a Shopee ainda não
   aceitar o campo, é só desligar e religar mais perto de 30/10.
2. **Antes de 30/10**, garantir que a chave esteja ligada — depois dessa data ela deixa de ser
   opcional.

> Empresa nova com Shopee Full não precisa de configuração: assim que a primeira nota for
> importada, o CNPJ dela é descoberto pela chave.
