import archiver from 'archiver';
import path from 'node:path';

export type Formato = 'docx' | 'pdf';

export const TIPOS: Record<Formato | 'zip', string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

export interface CurriculoArquivos {
  id: string;
  usuarioId: string;
  rotulo: string;
  markdown: string;
  titulo: string;
  empresa: string;
  docxPath: string | null;
  pdfPath: string | null;
  pacotePath: string | null;
}

export interface Repositorio {
  listar(): Promise<CurriculoArquivos[]>;
  atualizar(id: string, dados: Partial<Pick<CurriculoArquivos, 'docxPath' | 'pdfPath' | 'pacotePath'>>): Promise<void>;
}

export interface Destino {
  gravar(chave: string, dados: Buffer, tipo: string): Promise<void>;
  ler(chave: string): Promise<Buffer>;
  existe(chave: string): Promise<boolean>;
}

export interface Origem {
  listar(): Promise<string[]>;
  ler(nome: string): Promise<Buffer | null>;
}

export interface NaoMigrado {
  curriculoId: string;
  arquivo: Formato | 'zip';
  caminho: string | null;
  motivo: string;
}

export interface Contagem {
  curriculos: number;
  docxLocal: number;
  pdfLocal: number;
  docxNoS3: number;
  pdfNoS3: number;
  pacoteNoS3: number;
  semPacote: number;
}

export interface Relatorio {
  simulacao: boolean;
  arquivosNoVolume: number;
  antes: Contagem;
  depois: Contagem;
  enviados: { docx: number; pdf: number; pacote: number };
  naoMigrados: NaoMigrado[];
  arquivosSemReferencia: string[];
}

export function chaveDoCurriculo(usuarioId: string, curriculoId: string, extensao: Formato | 'zip'): string {
  return `usuarios/${usuarioId}/curriculos/${curriculoId}.${extensao}`;
}

export function ehChave(caminho: string | null): boolean {
  return !!caminho && caminho.startsWith('usuarios/');
}

export function nomeArquivo(valor: string): string {
  return valor.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim() || 'Curriculo';
}

export function montarPacote(curriculo: Pick<CurriculoArquivos, 'rotulo' | 'markdown' | 'titulo' | 'empresa'>, docx: Buffer | null, pdf: Buffer | null): Promise<Buffer> {
  const pasta = nomeArquivo(`${curriculo.titulo} - ${curriculo.empresa}`);
  const rotulo = nomeArquivo(curriculo.rotulo);
  return new Promise<Buffer>((resolver, rejeitar) => {
    const zip = archiver('zip', { zlib: { level: 9 } });
    const partes: Buffer[] = [];
    zip.on('data', (parte: Buffer) => partes.push(parte));
    zip.on('error', rejeitar);
    zip.on('end', () => resolver(Buffer.concat(partes)));
    zip.append(curriculo.markdown, { name: `${pasta}/Curriculo_${rotulo}.md` });
    if (docx) zip.append(docx, { name: `${pasta}/Curriculo_${rotulo}.docx` });
    if (pdf) zip.append(pdf, { name: `${pasta}/Curriculo_${rotulo}.pdf` });
    void zip.finalize();
  });
}

function contar(curriculos: CurriculoArquivos[]): Contagem {
  const local = (c: string | null) => !!c && !ehChave(c);
  return {
    curriculos: curriculos.length,
    docxLocal: curriculos.filter((c) => local(c.docxPath)).length,
    pdfLocal: curriculos.filter((c) => local(c.pdfPath)).length,
    docxNoS3: curriculos.filter((c) => ehChave(c.docxPath)).length,
    pdfNoS3: curriculos.filter((c) => ehChave(c.pdfPath)).length,
    pacoteNoS3: curriculos.filter((c) => ehChave(c.pacotePath)).length,
    semPacote: curriculos.filter((c) => !ehChave(c.pacotePath)).length,
  };
}

export async function migrar(repositorio: Repositorio, origem: Origem, destino: Destino, simulacao = false): Promise<Relatorio> {
  const curriculos = await repositorio.listar();
  const arquivosNoVolume = await origem.listar();
  const antes = contar(curriculos);
  const referenciados = new Set<string>();
  const naoMigrados: NaoMigrado[] = [];
  const enviados = { docx: 0, pdf: 0, pacote: 0 };

  for (const curriculo of curriculos) {
    const conteudo: Record<Formato, Buffer | null> = { docx: null, pdf: null };
    let faltou = false;
    for (const formato of ['docx', 'pdf'] as const) {
      const campo = formato === 'docx' ? 'docxPath' : 'pdfPath';
      const caminho = curriculo[campo];
      if (!caminho) continue;
      referenciados.add(`${curriculo.id}.${formato}`);
      if (ehChave(caminho)) {
        if (await destino.existe(caminho)) conteudo[formato] = simulacao ? Buffer.alloc(0) : await destino.ler(caminho);
        else {
          faltou = true;
          naoMigrados.push({ curriculoId: curriculo.id, arquivo: formato, caminho, motivo: 'a referencia aponta para o S3, mas o objeto nao existe' });
        }
        continue;
      }
      const nome = path.posix.basename(caminho.replace(/\\/g, '/'));
      referenciados.add(nome);
      const dados = await origem.ler(nome);
      if (!dados) {
        faltou = true;
        naoMigrados.push({ curriculoId: curriculo.id, arquivo: formato, caminho, motivo: 'arquivo nao encontrado no volume local' });
        continue;
      }
      const chave = chaveDoCurriculo(curriculo.usuarioId, curriculo.id, formato);
      if (!simulacao) {
        await destino.gravar(chave, dados, TIPOS[formato]);
        await repositorio.atualizar(curriculo.id, { [campo]: chave });
        curriculo[campo] = chave;
      }
      conteudo[formato] = dados;
      enviados[formato] += 1;
    }
    if (ehChave(curriculo.pacotePath)) continue;
    if (faltou) {
      naoMigrados.push({ curriculoId: curriculo.id, arquivo: 'zip', caminho: null, motivo: 'pacote nao montado porque um dos arquivos nao migrou' });
      continue;
    }
    const chave = chaveDoCurriculo(curriculo.usuarioId, curriculo.id, 'zip');
    if (!simulacao) {
      const pacote = await montarPacote(curriculo, conteudo.docx, conteudo.pdf);
      await destino.gravar(chave, pacote, TIPOS.zip);
      await repositorio.atualizar(curriculo.id, { pacotePath: chave });
      curriculo.pacotePath = chave;
    }
    enviados.pacote += 1;
  }

  return {
    simulacao,
    arquivosNoVolume: arquivosNoVolume.length,
    antes,
    depois: simulacao ? antes : contar(curriculos),
    enviados,
    naoMigrados,
    arquivosSemReferencia: arquivosNoVolume.filter((nome) => !referenciados.has(nome)).sort(),
  };
}
