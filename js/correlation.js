function averageRanks(rows, scoreKey) {
  const ordered = rows.map(row => ({ row, score: Math.round(row[scoreKey] * 1e6) })).sort((a,b) => b.score - a.score);
  const result = new Map();
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].score === ordered[start].score) end++;
    const rank = (start + 1 + end) / 2;
    for (let i = start; i < end; i++) result.set(ordered[i].row.pid, rank);
    start = end;
  }
  return result;
}

export function spearman(left, right) {
  if (left.length !== right.length || left.length < 3) return null;
  const n = left.length, a = left.reduce((s,x) => s + x, 0) / n, b = right.reduce((s,x) => s + x, 0) / n;
  let cross = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const x = left[i] - a, y = right[i] - b; cross += x * y; va += x * x; vb += y * y; }
  return va && vb ? Math.max(-1, Math.min(1, cross / Math.sqrt(va * vb))) : null;
}

export function pairAgreement(leftVotes, rightVotes) {
  const latest = votes => {
    const map = new Map();
    for (const v of votes.slice().sort((a,b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.at).localeCompare(String(b.at)))) {
      if (!v.pa || !v.pb || !v.winner) continue;
      const key = [[v.a,v.pa], [v.b,v.pb]].sort((a,b) => a[0].localeCompare(b[0])).map(x => x.join(':')).join('|');
      map.set(key,v.winner);
    }
    return map;
  };
  const a = latest(leftVotes), b = latest(rightVotes);
  let total = 0, agreed = 0;
  for (const [key,winner] of a) if (b.has(key)) { total++; if (b.get(key) === winner) agreed++; }
  return { total, agreed, rate: total ? agreed / total : null };
}

export function compareRankings(leftRows, rightRows, leftVotes = [], rightVotes = []) {
  const right = new Map(rightRows.map(row => [row.pid,row]));
  const common = leftRows.filter(row => row.comps > 0 && right.get(row.pid)?.comps > 0)
    .map(row => ({ pid: row.pid, name: row.name, leftScore: row.score, rightScore: right.get(row.pid).score,
      leftComps: row.comps, rightComps: right.get(row.pid).comps }));
  const a = averageRanks(common,'leftScore'), b = averageRanks(common,'rightScore');
  const rows = common.map(row => ({ ...row, leftRank: a.get(row.pid), rightRank: b.get(row.pid), delta: b.get(row.pid) - a.get(row.pid) }));
  return { n: rows.length, rho: spearman(rows.map(row => row.leftRank),rows.map(row => row.rightRank)),
    rows, agreement: pairAgreement(leftVotes,rightVotes) };
}
