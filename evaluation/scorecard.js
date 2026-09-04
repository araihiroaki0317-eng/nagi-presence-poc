export const SCORE_DIMENSIONS = Object.freeze({
  naturalness: 30,
  persona: 25,
  context: 20,
  judgment: 15,
  concision: 10,
});

export function validateCases(cases) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('cases_required');
  const ids = new Set();
  for (const item of cases) {
    if (!item?.id || ids.has(item.id)) throw new Error('case_id_invalid_or_duplicate');
    ids.add(item.id);
    for (const field of ['context', 'user_turns', 'expected', 'forbidden', 'dimensions']) {
      if (!Array.isArray(item[field]) || item[field].length === 0) throw new Error(`${item.id}_${field}_required`);
    }
    for (const dimension of item.dimensions) {
      if (!(dimension in SCORE_DIMENSIONS)) throw new Error(`${item.id}_unknown_dimension`);
    }
  }
  return true;
}

export function scoreEvaluation({ cases, ratings, invariantResults = {} }) {
  validateCases(cases);
  const dimensionTotals = Object.fromEntries(Object.keys(SCORE_DIMENSIONS).map(key => [key, []]));
  const hardFailures = [];

  for (const item of cases) {
    const rating = ratings[item.id];
    if (!rating) throw new Error(`rating_missing_${item.id}`);
    for (const dimension of item.dimensions) {
      const value = Number(rating[dimension]);
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        throw new Error(`rating_invalid_${item.id}_${dimension}`);
      }
      dimensionTotals[dimension].push(value);
    }
    if (item.hard_gate && rating.hard_gate_pass !== true) hardFailures.push(item.id);
    if (item.invariants && invariantResults[item.id] !== true) hardFailures.push(`${item.id}:invariants`);
  }

  const dimensionAverages = {};
  let weightedScore = 0;
  for (const [dimension, weight] of Object.entries(SCORE_DIMENSIONS)) {
    const values = dimensionTotals[dimension];
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    dimensionAverages[dimension] = average;
    weightedScore += (average / 5) * weight;
  }

  if (dimensionAverages.naturalness < 4) hardFailures.push('naturalness_below_4');
  return Object.freeze({
    weighted_score: Math.round(weightedScore * 10) / 10,
    dimension_averages: dimensionAverages,
    hard_failures: [...new Set(hardFailures)],
    accepted: hardFailures.length === 0 && weightedScore >= 75,
  });
}

export function expensiveCandidateJustified({ baselineScore, candidateScore }) {
  return Number(candidateScore) - Number(baselineScore) >= 10;
}
