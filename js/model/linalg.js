// Álgebra linear densa para matrizes simétricas positivas definidas (n ~ 500).
// Matrizes em Float64Array, ordem por linhas: A[i*n + j].

// Fatoração de Cholesky A = L L^T. Retorna L (triangular inferior, zeros acima da diagonal).
export function cholesky(A, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const ri = i * n;
    for (let j = 0; j <= i; j++) {
      const rj = j * n;
      let sum = A[ri + j];
      for (let k = 0; k < j; k++) sum -= L[ri + k] * L[rj + k];
      if (i === j) {
        if (!(sum > 0)) throw new Error('Matriz não é positiva definida (Cholesky).');
        L[ri + i] = Math.sqrt(sum);
      } else {
        L[ri + j] = sum / L[rj + j];
      }
    }
  }
  return L;
}

// Inversa de uma triangular inferior: M = L^{-1} (também triangular inferior).
export function invLower(L, n) {
  const M = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const ri = i * n;
    const lii = L[ri + i];
    M[ri + i] = 1 / lii;
    for (let j = 0; j < i; j++) {
      let sum = 0;
      for (let k = j; k < i; k++) sum += L[ri + k] * M[k * n + j];
      M[ri + j] = -sum / lii;
    }
  }
  return M;
}

// Covariância Σ = (L L^T)^{-1} = M^T M, com M = L^{-1}. Retorna matriz cheia simétrica.
export function covFromInvLower(M, n) {
  const S = new Float64Array(n * n);
  for (let k = 0; k < n; k++) {
    const rk = k * n;
    for (let i = 0; i <= k; i++) {
      const mki = M[rk + i];
      if (mki === 0) continue;
      const ri = i * n;
      for (let j = 0; j <= i; j++) S[ri + j] += mki * M[rk + j];
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) S[j * n + i] = S[i * n + j];
  return S;
}

// x = M^T z, com M triangular inferior (amostra de N(0, Σ) quando z ~ N(0, I)).
export function mulLowerT(M, n, z, out) {
  const x = out || new Float64Array(n);
  x.fill(0);
  for (let k = 0; k < n; k++) {
    const zk = z[k];
    if (zk === 0) continue;
    const rk = k * n;
    for (let i = 0; i <= k; i++) x[i] += M[rk + i] * zk;
  }
  return x;
}

// Resolve A x = b dado L de Cholesky.
export function cholSolve(L, n, b) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    const ri = i * n;
    for (let k = 0; k < i; k++) s -= L[ri + k] * y[k];
    y[i] = s / L[ri + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}
