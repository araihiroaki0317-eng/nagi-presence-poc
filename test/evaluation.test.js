import test from 'node:test';
import assert from 'node:assert/strict';
import { JAPANESE_CONVERSATION_CASES } from '../evaluation/japanese-conversation-cases.js';
import { expensiveCandidateJustified, scoreEvaluation, validateCases } from '../evaluation/scorecard.js';

function completeRatings(value = 4, hardGatePass = true) {
  return Object.fromEntries(JAPANESE_CONVERSATION_CASES.map(item => [item.id, {
    ...Object.fromEntries(item.dimensions.map(dimension => [dimension, value])),
    hard_gate_pass: hardGatePass,
  }]));
}

test('fixed Japanese evaluation cases have valid unique structure', () => {
  assert.equal(validateCases(JAPANESE_CONVERSATION_CASES), true);
  assert.equal(new Set(JAPANESE_CONVERSATION_CASES.map(item => item.id)).size, JAPANESE_CONVERSATION_CASES.length);
});

test('a provider passes only when subjective and objective hard gates pass', () => {
  const invariantResults = { voice_text_continuity: true };
  const passing = scoreEvaluation({
    cases: JAPANESE_CONVERSATION_CASES,
    ratings: completeRatings(4),
    invariantResults,
  });
  assert.equal(passing.weighted_score, 80);
  assert.equal(passing.accepted, true);

  const failingRatings = completeRatings(4);
  failingRatings.serious_context_blocks_playfulness.hard_gate_pass = false;
  const failing = scoreEvaluation({
    cases: JAPANESE_CONVERSATION_CASES,
    ratings: failingRatings,
    invariantResults,
  });
  assert.equal(failing.accepted, false);
  assert.ok(failing.hard_failures.includes('serious_context_blocks_playfulness'));
});

test('naturalness below four fails regardless of total score', () => {
  const ratings = completeRatings(5);
  for (const item of JAPANESE_CONVERSATION_CASES) {
    if (item.dimensions.includes('naturalness')) ratings[item.id].naturalness = 3;
  }
  const result = scoreEvaluation({
    cases: JAPANESE_CONVERSATION_CASES,
    ratings,
    invariantResults: { voice_text_continuity: true },
  });
  assert.equal(result.accepted, false);
  assert.ok(result.hard_failures.includes('naturalness_below_4'));
});

test('a higher-cost candidate needs at least ten weighted points of improvement', () => {
  assert.equal(expensiveCandidateJustified({ baselineScore: 76, candidateScore: 85.9 }), false);
  assert.equal(expensiveCandidateJustified({ baselineScore: 76, candidateScore: 86 }), true);
});
