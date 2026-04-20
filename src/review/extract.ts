import { type ReviewResult, type ReviewVerdict } from '../state/schemas.js';

export function extractReviewResult(raw: string, taskId: string, attempt: number): ReviewResult {
  const now = new Date().toISOString();

  const candidate = extractJsonBlock(raw) ?? tryExtractObject(raw);

  if (candidate) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      // fall through to text-based fallback
    }

    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      const normalized = normalizeRawObj(obj, taskId, attempt, raw, now);
      if (normalized) return normalized;
    }
  }

  // Text-based fallback — still produce a usable result
  const verdict = extractVerdictFromText(raw);
  return {
    task_id: taskId,
    attempt,
    verdict,
    summary: 'Review output was not structured JSON. See raw_output.',
    acceptance_checklist: [],
    issues_found: ['Codex did not return a structured review block'],
    fix_brief: verdict !== 'PASS' ? raw.slice(0, 2000) : '',
    confidence: 0.3,
    raw_output: raw,
    created_at: now,
  };
}

// ─── Normalization helpers ────────────────────────────────────────────────────

function normalizeRawObj(
  obj: Record<string, unknown>,
  taskId: string,
  attempt: number,
  raw: string,
  now: string,
): ReviewResult | null {
  const verdict = parseVerdict(obj['verdict']);
  if (!verdict) return null;

  const summary = typeof obj['summary'] === 'string' ? obj['summary'] : '';
  const issuesRaw = obj['issues_found'];
  const issues: string[] = Array.isArray(issuesRaw)
    ? issuesRaw.map(String)
    : [];

  const checklistRaw = obj['acceptance_checklist'];
  const checklist: { criterion: string; passed: boolean }[] = Array.isArray(checklistRaw)
    ? checklistRaw.map((item) => {
        if (typeof item === 'object' && item !== null) {
          const i = item as Record<string, unknown>;
          return {
            criterion: typeof i['criterion'] === 'string' ? i['criterion'] : String(i['criterion'] ?? ''),
            passed: Boolean(i['passed']),
          };
        }
        // plain string item — treat as failed criterion
        return { criterion: String(item), passed: false };
      })
    : [];

  const fixBrief = typeof obj['fix_brief'] === 'string' ? obj['fix_brief'] : '';

  let confidence = typeof obj['confidence'] === 'number' ? obj['confidence'] : 0.7;
  // Codex sometimes returns percentage (e.g. 85 instead of 0.85)
  if (confidence > 1) confidence = confidence / 100;
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    task_id: taskId,
    attempt,
    verdict,
    summary,
    acceptance_checklist: checklist,
    issues_found: issues,
    fix_brief: fixBrief,
    confidence,
    raw_output: raw,
    created_at: now,
  };
}

function parseVerdict(raw: unknown): ReviewVerdict | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  if (upper === 'PASS') return 'PASS';
  if (upper === 'REVISE') return 'REVISE';
  if (upper === 'BLOCKED') return 'BLOCKED';
  return null;
}

function extractVerdictFromText(text: string): ReviewVerdict {
  const upper = text.toUpperCase();
  if (upper.includes('BLOCKED')) return 'BLOCKED';
  if (upper.includes('REVISE')) return 'REVISE';
  if (upper.includes('PASS')) return 'PASS';
  return 'REVISE'; // conservative default
}

function extractJsonBlock(text: string): string | null {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

function tryExtractObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return null;
}
