import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Destino, migrar, Origem, Repositorio } from './migrador';

type Env = Record<string, string | undefined>;

export function destinoS3(env: Env = process.env): Destino {
  const bucket = env.S3_BUCKET?.trim();
  if (!bucket) throw new Error('S3_BUCKET ausente; defina o bucket de destino');
  const endpoint = env.S3_ENDPOINT?.trim() || undefined;
  const cliente = new S3Client({ region: env.AWS_REGION?.trim() || 'us-east-1', ...(endpoint ? { endpoint, forcePathStyle: true } : {}) });
  return {
    async gravar(chave, dados, tipo) {
      await cliente.send(new PutObjectCommand({ Bucket: bucket, Key: chave, Body: dados, ContentType: tipo }));
    },
    async ler(chave) {
      const resposta = await cliente.send(new GetObjectCommand({ Bucket: bucket, Key: chave }));
      return Buffer.from(await resposta.Body!.transformToByteArray());
    },
    async existe(chave) {
      try {
        await cliente.send(new HeadObjectCommand({ Bucket: bucket, Key: chave }));
        return true;
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404) return false;
        throw err;
      }
    },
  };
}

export function origemLocal(pasta: string): Origem {
  return {
    async listar() {
      try {
        const itens = await readdir(pasta, { withFileTypes: true });
        return itens.filter((item) => item.isFile()).map((item) => item.name);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    },
    async ler(nome) {
      try {
        return await readFile(path.join(pasta, nome));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}

export function repositorioPrisma(prisma: PrismaClient): Repositorio {
  return {
    async listar() {
      const linhas = await prisma.curriculo.findMany({
        include: { vaga: { select: { usuarioId: true, titulo: true, empresa: true } } },
        orderBy: { geradoEm: 'asc' },
      });
      return linhas.map((c) => ({
        id: c.id,
        usuarioId: c.vaga.usuarioId,
        rotulo: c.rotulo,
        markdown: c.markdown,
        titulo: c.vaga.titulo,
        empresa: c.vaga.empresa,
        docxPath: c.docxPath,
        pdfPath: c.pdfPath,
        pacotePath: c.pacotePath,
      }));
    },
    async atualizar(id, dados) {
      await prisma.curriculo.update({ where: { id }, data: dados });
    },
  };
}

async function executar() {
  const simulacao = process.argv.includes('--simular');
  const pasta = process.env.ARQUIVOS_LOCAIS_DIR?.trim() || '/app/storage';
  const prisma = new PrismaClient();
  try {
    const relatorio = await migrar(repositorioPrisma(prisma), origemLocal(pasta), destinoS3(), simulacao);
    const texto = JSON.stringify(relatorio, null, 2);
    process.stdout.write(`${texto}\n`);
    const arquivo = process.env.RELATORIO_ARQUIVO?.trim();
    if (arquivo) await writeFile(arquivo, texto);
    process.exitCode = relatorio.naoMigrados.length ? 2 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  executar().catch((err) => {
    process.stderr.write(`${JSON.stringify({ nivel: 'error', servico: 'migrar-arquivos-s3', mensagem: (err as Error).message })}\n`);
    process.exit(1);
  });
}
