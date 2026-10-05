# migrar-arquivos-s3

Job de migração dos arquivos locais de currículos para S3. Implementa a `spec-v1.11.0`.

## Instalação, testes e execução

Execute na raiz desta unidade. Não são necessários arquivos do monorepo. Requer Node.js 22 e Git para instalar os contratos quando aplicável.

```text
npm ci
npm test
npm run build
npm start
```

Defina DATABASE_URL, ARQUIVOS_LOCAIS_DIR, S3_BUCKET e as credenciais do destino. Use S3_ENDPOINT para armazenamento local compatível com S3. A execução altera arquivos e registros; use um banco e destino próprios de teste antes de executar com dados de produção.

## Imagem

```text
docker build -t prdal-migrar-arquivos-s3 .
```

O contexto é somente esta pasta. A imagem final executa sem root e não inclui dependências de desenvolvimento nem configurações de agentes. Injete as variáveis com --env-file em um arquivo local fora do controle de versão.

## Variáveis de ambiente

As variáveis opcionais usam os padrões definidos no código; configure explicitamente os destinos de banco e serviços no seu ambiente.

`ARQUIVOS_LOCAIS_DIR`, `AWS_ACCESS_KEY_ID`, `AWS_REGION`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `DATABASE_URL`, `RELATORIO_ARQUIVO`, `S3_BUCKET`, `S3_ENDPOINT`.
