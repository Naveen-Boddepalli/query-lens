/**
 * `src/export/` — pure, on the same rules as `src/engine/`: no DOM, no React,
 * fully unit-testable (plan.md §20.2 #1, §20.8).
 *
 * Turns the AST or plan display tree into a Mermaid `flowchart`, wrapped in a
 * fenced ```` ```mermaid ```` block ready for the clipboard — the format people
 * actually paste into a PR or Notion. Deliberately **not** the B+Tree: Mermaid
 * lays out a tree with a sibling chain badly (§20.3), and the AST and plan are
 * where the pasting happens.
 */

import type { ASTNode, PlanNode } from '../engine/index.ts';

interface TreeNode {
  id: string;
  label: string;
  detail?: string;
  children?: TreeNode[];
}

/** One line of Mermaid node text inside `["..."]`: escape the characters that
 *  end the string or are read as markup. `<br/>` between lines is added by the
 *  caller *after* this, so it survives. */
function escapePart(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ');
}

function toFlowchart(root: TreeNode): string {
  const lines: string[] = ['flowchart TD'];
  // Sequential ids sidestep every escaping and collision question the engine's
  // own ids (`select.col0`, `where.expr.l`) would raise in Mermaid.
  const idOf = new Map<TreeNode, string>();
  let n = 0;

  const walk = (node: TreeNode): void => {
    const mid = `n${String(n++)}`;
    idOf.set(node, mid);
    const text = (node.detail ? [node.label, node.detail] : [node.label])
      .map(escapePart)
      .join('<br/>');
    lines.push(`  ${mid}["${text}"]`);
    for (const child of node.children ?? []) {
      walk(child);
      lines.push(`  ${mid} --> ${idOf.get(child)!}`);
    }
  };

  walk(root);
  return lines.join('\n');
}

function fenced(diagram: string): string {
  return `\`\`\`mermaid\n${diagram}\n\`\`\`\n`;
}

/** The AST display tree as a fenced Mermaid flowchart. */
export function astToMermaid(root: ASTNode): string {
  return fenced(toFlowchart(root));
}

/** The plan (or a rewrite's before/after) display tree as a fenced Mermaid flowchart. */
export function planToMermaid(root: PlanNode): string {
  return fenced(toFlowchart(root));
}
