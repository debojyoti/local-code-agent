import { tmpdir } from 'os';
import { join } from 'path';
import { rm, readFile } from 'fs/promises';
import {
  artifactTimestamp,
  saveArtifact,
  readArtifact,
  appendLog,
} from '../src/artifacts/index.js';

const repoRoot = join(tmpdir(), `orch-artifacts-test-${Date.now()}`);

afterAll(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

// ─── Timestamp ───────────────────────────────────────────────────────────────

describe('artifactTimestamp', () => {
  test('format is YYYYMMDDTHHmmssSSS-NNNN', () => {
    const ts = artifactTimestamp();
    expect(ts).toMatch(/^\d{8}T\d{9}-\d{4}$/);
  });

  test('every call produces a unique value', () => {
    const a = artifactTimestamp();
    const b = artifactTimestamp();
    expect(a).not.toBe(b);
  });
});

// ─── saveArtifact ─────────────────────────────────────────────────────────────

describe('saveArtifact', () => {
  test('writes content and returns the full path', async () => {
    const path = await saveArtifact(repoRoot, 'prompts', null, 'test-prompt.md', '# Hello');
    const content = await readFile(path, 'utf8');
    expect(content).toBe('# Hello');
  });

  test('path is inside the correct category directory', async () => {
    const path = await saveArtifact(repoRoot, 'artifacts', null, 'output.txt', 'data');
    expect(path).toContain('.ai-orchestrator/artifacts/');
  });

  test('filename contains timestamp prefix', async () => {
    const path = await saveArtifact(repoRoot, 'reports', null, 'final-report.md', 'report');
    const basename = path.split('/').pop()!;
    expect(basename).toMatch(/^\d{8}T\d{9}-\d{4}-final-report\.md$/);
  });

  test('task-scoped artifact goes into a taskId subdirectory', async () => {
    const path = await saveArtifact(repoRoot, 'prompts', 'TASK-001', 'brief.md', 'brief');
    expect(path).toContain('prompts/TASK-001/');
  });

  test('global artifact (null taskId) has no task subdirectory', async () => {
    const path = await saveArtifact(repoRoot, 'prompts', null, 'plan.md', 'plan');
    expect(path).not.toMatch(/prompts\/TASK-/);
    expect(path).toContain('.ai-orchestrator/prompts/');
  });

  test('creates parent directories automatically', async () => {
    // reviews/TASK-002 does not exist yet
    const path = await saveArtifact(repoRoot, 'reviews', 'TASK-002', 'review.md', 'verdict');
    const content = await readFile(path, 'utf8');
    expect(content).toBe('verdict');
  });

  test('sequential saves within the same second produce distinct paths', async () => {
    // millisecond resolution means sequential awaited writes never collide in practice
    const p1 = await saveArtifact(repoRoot, 'artifacts', 'TASK-001', 'out.txt', 'first');
    const p2 = await saveArtifact(repoRoot, 'artifacts', 'TASK-001', 'out.txt', 'second');
    const p3 = await saveArtifact(repoRoot, 'artifacts', 'TASK-001', 'out.txt', 'third');
    expect(p1).not.toBe(p2);
    expect(p2).not.toBe(p3);
  });
});

// ─── readArtifact ─────────────────────────────────────────────────────────────

describe('readArtifact', () => {
  test('reads content written by saveArtifact', async () => {
    const path = await saveArtifact(repoRoot, 'artifacts', null, 'readable.md', 'hello world');
    const content = await readArtifact(path);
    expect(content).toBe('hello world');
  });

  test('returns null for a missing file', async () => {
    const result = await readArtifact(join(repoRoot, 'does-not-exist.md'));
    expect(result).toBeNull();
  });
});

// ─── appendLog ───────────────────────────────────────────────────────────────

describe('appendLog', () => {
  test('creates the log file and writes a timestamped line', async () => {
    await appendLog(repoRoot, 'TASK-001', 'task started');
    const logPath = join(repoRoot, '.ai-orchestrator', 'logs', 'TASK-001.log');
    const content = await readFile(logPath, 'utf8');
    expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
    expect(content).toContain('task started');
  });

  test('appends multiple lines to the same file', async () => {
    await appendLog(repoRoot, 'TASK-001', 'step one');
    await appendLog(repoRoot, 'TASK-001', 'step two');
    const logPath = join(repoRoot, '.ai-orchestrator', 'logs', 'TASK-001.log');
    const content = await readFile(logPath, 'utf8');
    expect(content).toContain('step one');
    expect(content).toContain('step two');
  });

  test('global log (null taskId) writes to orchestrator.log', async () => {
    await appendLog(repoRoot, null, 'orchestrator started');
    const logPath = join(repoRoot, '.ai-orchestrator', 'logs', 'orchestrator.log');
    const content = await readFile(logPath, 'utf8');
    expect(content).toContain('orchestrator started');
  });
});
