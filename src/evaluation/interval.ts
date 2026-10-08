export type Interval = { readonly lower: number; readonly upper: number };

/** log C(n, i) summed term by term; exact enough for run counts. */
function binomialCdf(k: number, n: number, p: number): number {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let logChoose = 0;
  let total = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logChoose += Math.log((n - i + 1) / i);
    total += Math.exp(logChoose + i * Math.log(p) + (n - i) * Math.log1p(-p));
  }
  return Math.min(1, total);
}

/** Bisection on a probability that moves monotonically with p. */
function solve(target: number, decreasing: (p: number) => number): number {
  let low = 0;
  let high = 1;
  for (let step = 0; step < 100; step++) {
    const middle = (low + high) / 2;
    if (decreasing(middle) > target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** Exact two-sided Clopper-Pearson interval for k successes in n trials. */
export function clopperPearson(
  k: number,
  n: number,
  confidence = 0.95,
): Interval {
  if (
    !Number.isSafeInteger(n) ||
    n < 0 ||
    !Number.isSafeInteger(k) ||
    k < 0 ||
    k > n
  )
    throw new Error("Invalid binomial count");
  if (n === 0) return { lower: 0, upper: 1 };
  const tail = (1 - confidence) / 2;
  return {
    // P(X >= k | lower) = tail, i.e. P(X <= k - 1 | lower) = 1 - tail
    lower: k === 0 ? 0 : solve(1 - tail, (p) => binomialCdf(k - 1, n, p)),
    // P(X <= k | upper) = tail
    upper: k === n ? 1 : solve(tail, (p) => binomialCdf(k, n, p)),
  };
}
