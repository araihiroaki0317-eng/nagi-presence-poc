const TRANSCRIPT_SCHEMA_VERSION = '0.2';

function fallbackId() {
  return `turn_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function normalizeTurn(input = {}) {
  const role = input.role === 'user' ? 'user' : 'agent';
  return {
    turn_id: input.turn_id || globalThis.crypto?.randomUUID?.() || fallbackId(),
    role,
    text: String(input.text || '').trim(),
    input_channel: input.input_channel || null,
    output_channel: input.output_channel || null,
    source: input.source || 'sdk',
    ts: Number(input.ts || Date.now()),
  };
}

export class LocalTranscriptStore {
  constructor(key = 'nagi.m3a.shortContext.v1', storage = globalThis.localStorage, maxTurns = 40) {
    this.key = key;
    this.storage = storage;
    this.maxTurns = maxTurns;
  }

  read() {
    try {
      const value = JSON.parse(this.storage?.getItem(this.key) || '{"turns":[]}');
      return Array.isArray(value?.turns) ? value.turns.map(normalizeTurn).filter(turn => turn.text) : [];
    } catch {
      return [];
    }
  }

  append(input) {
    const turn = normalizeTurn(input);
    if (!turn.text) throw new Error('transcript_text_required');
    const turns = this.read();
    const last = turns[turns.length - 1];

    if (last && last.role === turn.role && last.text === turn.text && turn.ts - last.ts < 15000) {
      return { turn: last, duplicate: true, replaced: false };
    }

    const isGrowingSdkTranscript = last
      && last.role === turn.role
      && last.source === 'sdk'
      && turn.source === 'sdk'
      && turn.ts - last.ts < 15000
      && turn.text.startsWith(last.text);

    if (isGrowingSdkTranscript) {
      turns[turns.length - 1] = { ...last, ...turn, turn_id: last.turn_id };
      this.save(turns);
      return { turn: turns[turns.length - 1], duplicate: false, replaced: true };
    }

    turns.push(turn);
    this.save(turns);
    return { turn, duplicate: false, replaced: false };
  }

  save(turns) {
    const trimmed = turns.slice(-this.maxTurns);
    this.storage?.setItem(this.key, JSON.stringify({
      schema_version: TRANSCRIPT_SCHEMA_VERSION,
      turns: trimmed,
      updatedAt: Date.now(),
    }));
    return trimmed;
  }
}

export function transcriptContext(turns, limit = 8, maxCharacters = 3500) {
  const text = turns.slice(-limit).map(turn => `${turn.role === 'user' ? 'ヒロ' : '凪'}: ${turn.text}`).join('\n');
  return text.length > maxCharacters ? text.slice(-maxCharacters) : text;
}
