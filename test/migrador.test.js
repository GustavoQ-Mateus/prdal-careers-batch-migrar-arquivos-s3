const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrar, montarPacote } = require('../dist/migrador');
const { origemLocal } = require('../dist/main');

function cenario() {
  const linhas = [
    { id: 'cv-1', usuarioId: 'u1', rotulo: 'ACME · Dev', markdown: '# Um', titulo: 'Dev/Web', empresa: 'ACME', docxPath: '/app/storage/cv-1.docx', pdfPath: '/app/storage/cv-1.pdf', pacotePath: null },
    { id: 'cv-2', usuarioId: 'u2', rotulo: 'Beta', markdown: '# Dois', titulo: 'QA', empresa: 'Beta', docxPath: '/app/storage/cv-2.docx', pdfPath: '/app/storage/cv-2.pdf', pacotePath: null },
    { id: 'cv-3', usuarioId: 'u1', rotulo: 'Sem arquivos', markdown: '# Tres', titulo: 'PO', empresa: 'Gama', docxPath: null, pdfPath: null, pacotePath: null },
  ];
  const volume = new Map([
    ['cv-1.docx', Buffer.from('docx-1')],
    ['cv-1.pdf', Buffer.from('pdf-1')],
    ['cv-2.docx', Buffer.from('docx-2')],
    ['orfao.pdf', Buffer.from('ninguem')],
  ]);
  const s3 = new Map();
  const repositorio = {
    listar: async () => linhas.map((l) => ({ ...l })),
    atualizar: async (id, dados) => Object.assign(linhas.find((l) => l.id === id), dados),
  };
  const origem = { listar: async () => [...volume.keys()], ler: async (nome) => volume.get(nome) ?? null };
  const destino = {
    gravar: async (chave, dados, tipo) => s3.set(chave, { dados, tipo }),
    ler: async (chave) => s3.get(chave).dados,
    existe: async (chave) => s3.has(chave),
  };
  return { linhas, volume, s3, repositorio, origem, destino };
}

test('move os arquivos para chaves por usuario, monta o pacote e relata o que nao migrou', async () => {
  const { linhas, s3, repositorio, origem, destino } = cenario();
  const r = await migrar(repositorio, origem, destino);
  assert.deepEqual(r.antes, { curriculos: 3, docxLocal: 2, pdfLocal: 2, docxNoS3: 0, pdfNoS3: 0, pacoteNoS3: 0, semPacote: 3 });
  assert.deepEqual(r.depois, { curriculos: 3, docxLocal: 0, pdfLocal: 1, docxNoS3: 2, pdfNoS3: 1, pacoteNoS3: 2, semPacote: 1 });
  assert.deepEqual(r.enviados, { docx: 2, pdf: 1, pacote: 2 });
  assert.deepEqual(r.naoMigrados.map((n) => [n.curriculoId, n.arquivo]), [['cv-2', 'pdf'], ['cv-2', 'zip']]);
  assert.deepEqual(r.arquivosSemReferencia, ['orfao.pdf']);
  assert.equal(linhas[0].pdfPath, 'usuarios/u1/curriculos/cv-1.pdf');
  assert.equal(linhas[0].pacotePath, 'usuarios/u1/curriculos/cv-1.zip');
  assert.equal(linhas[1].pdfPath, '/app/storage/cv-2.pdf');
  assert.equal(s3.get('usuarios/u1/curriculos/cv-1.pdf').tipo, 'application/pdf');
  assert.equal(s3.get('usuarios/u1/curriculos/cv-1.zip').dados.subarray(0, 2).toString(), 'PK');
  assert.ok(s3.has('usuarios/u1/curriculos/cv-3.zip'));
});

test('rodar de novo nao reenvia nada e so tenta o que faltou', async () => {
  const { s3, volume, repositorio, origem, destino } = cenario();
  await migrar(repositorio, origem, destino);
  const gravacoes = s3.size;
  const segunda = await migrar(repositorio, origem, destino);
  assert.deepEqual(segunda.enviados, { docx: 0, pdf: 0, pacote: 0 });
  assert.equal(s3.size, gravacoes);
  assert.deepEqual(segunda.arquivosSemReferencia, ['orfao.pdf']);
  volume.set('cv-2.pdf', Buffer.from('pdf-2'));
  const terceira = await migrar(repositorio, origem, destino);
  assert.deepEqual(terceira.enviados, { docx: 0, pdf: 1, pacote: 1 });
  assert.deepEqual(terceira.naoMigrados, []);
  assert.equal(terceira.depois.pdfLocal, 0);
});

test('simulacao conta sem gravar nada', async () => {
  const { linhas, s3, repositorio, origem, destino } = cenario();
  const r = await migrar(repositorio, origem, destino, true);
  assert.equal(r.simulacao, true);
  assert.equal(s3.size, 0);
  assert.equal(linhas[0].docxPath, '/app/storage/cv-1.docx');
  assert.deepEqual(r.enviados, { docx: 2, pdf: 1, pacote: 2 });
});

test('pacote leva markdown e so os formatos existentes, com nomes sanitizados', async () => {
  const zip = await montarPacote({ rotulo: 'V: 1/2', markdown: '# X', titulo: 'Dev/Web', empresa: 'ACME: BR' }, Buffer.from('d'), null);
  const texto = zip.toString('latin1');
  assert.match(texto, /DevWeb - ACME BR\/Curriculo_V 12\.md/);
  assert.match(texto, /Curriculo_V 12\.docx/);
  assert.doesNotMatch(texto, /Curriculo_V 12\.pdf/);
});

test('origem local le somente arquivos e trata pasta ausente como vazia', async (t) => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'prdal-migrar-'));
  t.after(() => fs.rmSync(pasta, { recursive: true, force: true }));
  fs.writeFileSync(path.join(pasta, 'a.pdf'), 'x');
  fs.mkdirSync(path.join(pasta, 'sub'));
  const origem = origemLocal(pasta);
  assert.deepEqual(await origem.listar(), ['a.pdf']);
  assert.equal((await origem.ler('a.pdf')).toString(), 'x');
  assert.equal(await origem.ler('b.pdf'), null);
  assert.deepEqual(await origemLocal(path.join(pasta, 'nao-existe')).listar(), []);
});

test('o job nao importa codigo da api nem de outra unidade', () => {
  const pasta = path.resolve(__dirname, '..', 'src');
  for (const arquivo of fs.readdirSync(pasta)) {
    const texto = fs.readFileSync(path.join(pasta, arquivo), 'utf8');
    assert.doesNotMatch(texto, /from '\.\.\/\.\./, arquivo);
    assert.doesNotMatch(texto, /apps\/(api|worker|lambdas)/, arquivo);
  }
});
