// Configurações padrão. As da avaliação ficam guardadas na própria avaliação (sincronizadas);
// as preferências de exibição ficam no evento `prefs` (sincronizadas) e as do aparelho no localStorage.

export const DEFAULT_EVAL_SETTINGS = {
  sigmaMode: 'auto', // 'auto': σ estimado pelos votos (Bayes empírico) a partir de 300 votos | 'fixo'
  sigma: 1.5, // σ fixo, e valor usado no modo automático antes de 300 votos (unidades de log-chance)
  budget: 4000, // orçamento de escolhas válidas
  coverageMin: 6, // comparações mínimas por participante na fase de cobertura
  coverageMode: 'aleatorio', // 'aleatorio' | 'suico'
  photoPolicy: 'descartar', // ao trocar a foto principal: 'descartar' votos da foto anterior | 'manter'
  countAudits: false, // votos de auditoria entram no cálculo?
  includePendingPhotos: false, // fotos ainda não confirmadas entram nos confrontos?
  freezeEnabled: true, // congela quem acumula derrotas: sai dos novos confrontos e continua no cálculo
  freezeMargin: 6, // derrotas a mais que vitórias para congelar
  freezeMaxWins: 4, // a regra só vale para quem tem até esta quantidade de vitórias
  // decisões manuais por avaliação: { evalId: { pid: { mode: 'congelada' | 'liberada', from } } }. A chave da avaliação
  // impede que valham em outra avaliação, já que a aprovação de um convidado copia estas configurações.
  freezeOverrides: {},
  wTop: 6, // peso da disputa pelo 1º lugar (escolhido nas simulações)
  wUnder: 1.5, // peso de participantes pouco avaliadas
  wCross: 0.3, // peso de confrontos entre faixas
  window: 10, // vizinhas consideradas na ordem atual
  groups: [10, 25, 50, 100, 200, 350], // limites das faixas (posições)
  stageSize: 250, // escolhas por etapa no chaveamento
  mcSamples: 1000, // amostras de Monte Carlo
  level: 0.9, // nível da faixa provável
  topK: 10,
  closeThreshold: 0.75, // abaixo desta chance de ordem correta, posições são marcadas como próximas
  reviewMinP1: 0.01, // chance mínima de 1º lugar para entrar na revisão
  reviewAuto: true, // etapa de revisão do 1º lugar começa sozinha perto do fim do orçamento
  reviewFrom: 0.75, // fração do orçamento em que a etapa de revisão começa
  reviewShare: 0.5, // fração dos pares que vêm da revisão durante a etapa (escolhida nas simulações)
  auditGap: 25, // confrontos mínimos entre o voto original e a auditoria
};

export const DEFAULT_PREFS = {
  showNames: false,
  showScores: false,
  showReason: true,
  layout: 'auto', // 'auto' | 'lado' | 'pilha'
};

export const SETTINGS_HELP = {
  sigmaMode: 'Automático: o app escolhe o σ que melhor explica os seus votos (máxima evidência), recalculado conforme os votos chegam. Fixo: usa o valor informado.',
  sigma: 'Desvio padrão do prior gaussiano. Valores menores puxam as estimativas para o centro quando há poucos votos. No modo automático vale até a 300ª escolha.',
  budget: 'Quantidade planejada de escolhas válidas. Serve para acompanhar o progresso; você pode continuar depois.',
  coverageMin: 'Comparações válidas que cada participante recebe antes da fase adaptativa.',
  coverageMode: 'Aleatório sorteia adversárias variadas; suíço aproxima participantes de pontuação parecida a partir da 3ª rodada.',
  photoPolicy: 'Quando a foto principal muda, os votos feitos com a foto anterior podem sair do cálculo ou continuar valendo.',
  countAudits: 'Votos de auditoria repetem pares já vistos. Por padrão servem só para medir consistência.',
  includePendingPhotos: 'Fotos trocadas automaticamente na importação ficam fora dos confrontos até você confirmar.',
  freezeEnabled: 'Quem chega à diferença de derrotas abaixo (com até o limite de vitórias) sai dos novos confrontos e continua no ranking e no cálculo. Uma vez congelada, fica assim até a foto principal mudar ou até você descongelar na ficha da participante.',
  freezeMargin: 'Derrotas a mais que vitórias. Com 6, congelam os placares 0-6, 1-7, 2-8, 3-9 e 4-10, e também os piores, como 0-8.',
  freezeMaxWins: 'A regra só vale para quem tem até esta quantidade de vitórias.',
  wTop: 'Prioridade para pares que podem mudar o 1º lugar.',
  reviewAuto: 'Perto do fim do orçamento, os pares passam a vir das candidatas ao 1º lugar e das pouco avaliadas que ainda podem alcançar a líder.',
  reviewFrom: 'Fração do orçamento em que a etapa de revisão começa (0,75 = 3.000 de 4.000).',
  reviewShare: 'Fração dos pares da etapa que vem da revisão; o restante segue a fase adaptativa.',
  wUnder: 'Prioridade para participantes com menos comparações que a mediana.',
  wCross: 'Prioridade para confrontos entre faixas vizinhas.',
};
