import { describe, expect, it } from 'vitest';
import { TokenizeError, tokenize } from '../parser/tokenizer.ts';

const kinds = (sql: string) => tokenize(sql).map((t) => `${t.type}:${t.value}`);

describe('tokenize', () => {
  it('always terminates with an eof token', () => {
    const tokens = tokenize('');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.type).toBe('eof');
  });

  it('classifies keywords case-insensitively but preserves the original text', () => {
    const [select, star, from, users] = tokenize('sElEcT * FROM users');
    expect(select).toMatchObject({ type: 'keyword', value: 'sElEcT', upper: 'SELECT' });
    expect(star?.type).toBe('star');
    expect(from?.type).toBe('keyword');
    expect(users).toMatchObject({ type: 'identifier', value: 'users' });
  });

  it('records exact character spans', () => {
    const [first] = tokenize('  SELECT');
    expect(first).toMatchObject({ from: 2, to: 8 });
  });

  it('reads integers and decimals', () => {
    expect(kinds('1 2.5')).toEqual(['number:1', 'number:2.5', 'eof:']);
  });

  it('reads strings and unescapes doubled quotes', () => {
    const [str] = tokenize("'it''s'");
    expect(str).toMatchObject({ type: 'string', value: "it's" });
  });

  it('keeps two-character comparison operators whole', () => {
    expect(kinds('<= >= <> !=')).toEqual([
      'operator:<=', 'operator:>=', 'operator:<>', 'operator:!=', 'eof:',
    ]);
  });

  it('skips line and block comments', () => {
    expect(kinds('SELECT -- gone\n* /* also gone */ FROM t')).toEqual([
      'keyword:SELECT', 'star:*', 'keyword:FROM', 'identifier:t', 'eof:',
    ]);
  });

  it('reports an unterminated string with its span', () => {
    try {
      tokenize("SELECT 'oops");
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TokenizeError);
      const e = err as TokenizeError;
      expect(e.message).toMatch(/unterminated string/i);
      expect(e.from).toBe(7);
      expect(e.to).toBe(12);
    }
  });

  it('reports an unexpected character', () => {
    expect(() => tokenize('SELECT # FROM t')).toThrow(/unexpected character/i);
  });
});
