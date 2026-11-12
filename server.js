const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORTA = process.env.PORT || 3000;
const ARQUIVO_PLACARES = path.join(__dirname, 'placares.json');

// ---------- Placar guardado (por dupla de nomes) ----------
let placares = {};
try {
  placares = JSON.parse(fs.readFileSync(ARQUIVO_PLACARES, 'utf8'));
} catch (e) {
  placares = {};
}

function salvarPlacares() {
  try {
    fs.writeFileSync(ARQUIVO_PLACARES, JSON.stringify(placares));
  } catch (e) {
    // Se não conseguir gravar, o jogo continua normalmente
  }
}

function normalizar(nome) {
  return String(nome || '').trim().toLowerCase();
}

function chaveDupla(nomeA, nomeB) {
  return [normalizar(nomeA), normalizar(nomeB)].sort().join('|');
}

// Devolve os pontos de cada nome, na dupla guardada
function pontosDaDupla(sala) {
  const chave = chaveDupla(sala.jogadores.X.nome, sala.jogadores.O.nome);
  const guardado = placares[chave] || {};
  return {
    X: guardado[normalizar(sala.jogadores.X.nome)] || 0,
    O: guardado[normalizar(sala.jogadores.O.nome)] || 0
  };
}

function guardarPontos(sala) {
  const chave = chaveDupla(sala.jogadores.X.nome, sala.jogadores.O.nome);
  const obj = {};
  obj[normalizar(sala.jogadores.X.nome)] = sala.pontos.X;
  obj[normalizar(sala.jogadores.O.nome)] = sala.pontos.O;
  placares[chave] = obj;
  salvarPlacares();
}

// ---------- Servidor web: entrega a página ----------
const servidor = http.createServer((req, res) => {
  const arquivo = path.join(__dirname, 'public', 'index.html');
  fs.readFile(arquivo, (erro, dados) => {
    if (erro) {
      res.writeHead(500);
      res.end('Erro ao carregar o jogo');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(dados);
  });
});

const wss = new WebSocket.Server({ server: servidor });
const salas = {};

const LINHAS = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6]
];

const EMOJIS_PERMITIDOS = ['😂', '👍', '😮', '😎', '😭', '🔥'];

function gerarCodigo() {
  const letras = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let codigo = '';
  do {
    codigo = '';
    for (let i = 0; i < 4; i++) {
      codigo += letras[Math.floor(Math.random() * letras.length)];
    }
  } while (salas[codigo]);
  return codigo;
}

function novaSala(codigo) {
  return {
    codigo: codigo,
    jogadores: { X: null, O: null },
    casas: ['', '', '', '', '', '', '', '', ''],
    vez: 'X',
    inicio: 'X',
    fim: false,
    linhaVencedora: null,
    mensagem: '',
    pontos: { X: 0, O: 0 }
  };
}

function vencedor(casas) {
  for (const linha of LINHAS) {
    const [a, b, c] = linha;
    if (casas[a] && casas[a] === casas[b] && casas[a] === casas[c]) {
      return linha;
    }
  }
  return null;
}

function estadoPublico(sala) {
  return {
    tipo: 'estado',
    codigo: sala.codigo,
    nomes: {
      X: sala.jogadores.X ? sala.jogadores.X.nome : '',
      O: sala.jogadores.O ? sala.jogadores.O.nome : ''
    },
    casas: sala.casas,
    vez: sala.vez,
    fim: sala.fim,
    linhaVencedora: sala.linhaVencedora,
    mensagem: sala.mensagem,
    pontos: sala.pontos,
    completa: !!(sala.jogadores.X && sala.jogadores.O)
  };
}

function enviar(ws, dados) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(dados));
  }
}

function avisarSala(sala) {
  const estado = estadoPublico(sala);
  for (const simbolo of ['X', 'O']) {
    const j = sala.jogadores[simbolo];
    if (j) {
      enviar(j.ws, Object.assign({ voce: simbolo }, estado));
    }
  }
}

function limparNome(nome) {
  return String(nome || '').trim().slice(0, 24);
}

wss.on('connection', (ws) => {
  ws.sala = null;
  ws.simbolo = null;

  ws.on('message', (texto) => {
    let msg;
    try { msg = JSON.parse(texto); } catch (e) { return; }

    // Criar uma sala nova
    if (msg.tipo === 'criar') {
      const codigo = gerarCodigo();
      const sala = novaSala(codigo);
      sala.jogadores.X = { ws: ws, nome: limparNome(msg.nome) || 'Jogador X' };
      sala.mensagem = 'Aguardando o outro jogador entrar...';
      salas[codigo] = sala;
      ws.sala = codigo;
      ws.simbolo = 'X';
      avisarSala(sala);
      return;
    }

    // Entrar numa sala que já existe
    if (msg.tipo === 'entrar') {
      const codigo = String(msg.codigo || '').trim().toUpperCase();
      const sala = salas[codigo];
      if (!sala) {
        enviar(ws, { tipo: 'erro', texto: 'Sala não encontrada. Confira o código.' });
        return;
      }
      if (sala.jogadores.O) {
        enviar(ws, { tipo: 'erro', texto: 'Essa sala já está cheia.' });
        return;
      }
      sala.jogadores.O = { ws: ws, nome: limparNome(msg.nome) || 'Jogador O' };
      ws.sala = codigo;
      ws.simbolo = 'O';
      sala.mensagem = '';
      // Recupera o placar guardado dessa dupla
      sala.pontos = pontosDaDupla(sala);
      avisarSala(sala);
      return;
    }

    const sala = salas[ws.sala];
    if (!sala) return;

    // Fazer uma jogada
    if (msg.tipo === 'jogar') {
      const i = Number(msg.casa);
      if (!sala.jogadores.X || !sala.jogadores.O) return;
      if (sala.fim) return;
      if (sala.vez !== ws.simbolo) return;
      if (!(i >= 0 && i <= 8)) return;
      if (sala.casas[i] !== '') return;

      sala.casas[i] = ws.simbolo;
      const linha = vencedor(sala.casas);
      if (linha) {
        sala.fim = true;
        sala.linhaVencedora = linha;
        sala.pontos[ws.simbolo]++;
        sala.mensagem = '🏆 ' + sala.jogadores[ws.simbolo].nome + ' ganhou!';
        guardarPontos(sala);
      } else if (sala.casas.indexOf('') === -1) {
        sala.fim = true;
        sala.mensagem = '🤝 Deu velha! Empate!';
      } else {
        sala.vez = sala.vez === 'X' ? 'O' : 'X';
      }
      avisarSala(sala);
      return;
    }

    // Nova partida (mantém o placar e alterna quem começa)
    if (msg.tipo === 'nova') {
      if (!sala.fim) return;
      sala.casas = ['', '', '', '', '', '', '', '', ''];
      sala.inicio = sala.inicio === 'X' ? 'O' : 'X';
      sala.vez = sala.inicio;
      sala.fim = false;
      sala.linhaVencedora = null;
      sala.mensagem = '';
      avisarSala(sala);
      return;
    }

    // Emoji rápido: repassa para o outro jogador
    if (msg.tipo === 'emoji') {
      if (EMOJIS_PERMITIDOS.indexOf(msg.emoji) === -1) return;
      const outro = ws.simbolo === 'X' ? 'O' : 'X';
      const j = sala.jogadores[outro];
      if (j) {
        enviar(j.ws, {
          tipo: 'emoji',
          emoji: msg.emoji,
          de: sala.jogadores[ws.simbolo].nome
        });
      }
      return;
    }
  });

  ws.on('close', () => {
    const sala = salas[ws.sala];
    if (!sala) return;
    const outro = ws.simbolo === 'X' ? 'O' : 'X';
    if (sala.jogadores[outro]) {
      enviar(sala.jogadores[outro].ws, {
        tipo: 'saiu',
        texto: 'O outro jogador saiu da sala.'
      });
    }
    delete salas[ws.sala];
  });
});

servidor.listen(PORTA, () => {
  console.log('Jogo da Velha rodando na porta ' + PORTA);
});
