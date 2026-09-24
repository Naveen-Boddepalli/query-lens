/**
 * plan.md §25.4 A2 — a deliberately tiny prose renderer for the study's own text.
 *
 * The control-arm reading and the questions are authored in `STUDY.md` with a
 * handful of Markdown marks: `### ` headings, blank-line-separated paragraphs,
 * `**bold**`, `*italic*` and `` `code` ``. That is all this understands, and it returns
 * plain data for React to render as *text nodes* — there is no HTML string
 * anywhere, so a pack (which is a stranger's input) cannot inject markup.
 * A general Markdown library would be a dependency, a bundle cost and a larger
 * attack surface for the sake of four marks.
 */

export type Block = { kind: 'heading' | 'paragraph'; text: string };
export type Inline = { kind: 'text' | 'strong' | 'em' | 'code'; text: string };

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of source.split(/\n\s*\n/)) {
    const text = chunk.trim();
    if (text === '') continue;
    const heading = /^###\s+(.*)$/.exec(text);
    if (heading?.[1] !== undefined && !text.includes('\n')) {
      blocks.push({ kind: 'heading', text: heading[1].trim() });
    } else {
      blocks.push({ kind: 'paragraph', text: text.replace(/\s*\n\s*/g, ' ') });
    }
  }
  return blocks;
}

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let at = 0;
  for (let m = pattern.exec(source); m !== null; m = pattern.exec(source)) {
    if (m.index > at) out.push({ kind: 'text', text: source.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'strong', text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'em', text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: 'code', text: m[3] });
    at = m.index + m[0].length;
  }
  if (at < source.length) out.push({ kind: 'text', text: source.slice(at) });
  return out;
}
