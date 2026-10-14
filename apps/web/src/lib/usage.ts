// How a task's usage figures are written. Small amounts are not given a precision they do not have.

/** "<$0.01", "$0.03", "$1.24". */
export function formatCost(usd: number): string {
  if (usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** "740", "8k", "85k", "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  const m = n / 1_000_000;
  return `${m >= 10 || Math.abs(m - Math.round(m)) < 0.05 ? Math.round(m) : m.toFixed(1)}M`;
}

/** "<1 s", "36 s", "3 min", "1 h 5 min". */
export function formatSpan(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return "<1 s";
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}
