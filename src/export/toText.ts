/**
 * `src/export/` — pure, on the same rules as `src/engine/`: no DOM, no React,
 * fully unit-testable (plan.md §20.2 #1, §22.5).
 *
 * The plain-text twin of `toMermaid.ts`: the AST, the plan, or the B+Tree as a
 * `tree(1)`-style indented list, wrapped in a bare ``` fence so a paste into a
 * pull request, an issue or an email keeps its alignment (an unfenced tree gets
 * reflowed into a proportional font and the indent collapses).
 *
 * Where Mermaid had to leave the B+Tree out — it lays a sibling chain out badly
 * (§20.3) — text handles it fine, so all three panels are covered here.
 */

import type { ASTNode, IndexNode, PlanNode } from '../engine/index.ts';

interface TextNode {
  label: string;
  detail?: string;
  children?: TextNode[];
}

/**
 * `label`, then `detail` if present, on one line — newlines in either flattened
 * to spaces so a multi-line label cannot break the tree's alignment.
 */
function oneLine(node: TextNode): string {
  const text = node.detail ? `${node.label}  ${node.detail}` : node.label;
  return text.replace(/\r?\n/g, ' ').trimEnd();
}

/** `tree(1)` connectors: `├─`/`└─` for a node, `│ `/`  ` carried to its subtree. */
function render(root: TextNode): string {
  const lines = [oneLine(root)];

  const walk = (nodes: readonly TextNode[], prefix: string): void => {
    nodes.forEach((node, i) => {
      const last = i === nodes.length - 1;
      lines.push(`${prefix}${last ? '└─ ' : '├─ '}${oneLine(node)}`);
      if (node.children && node.children.length > 0) {
        walk(node.children, `${prefix}${last ? '   ' : '│  '}`);
      }
    });
  };

  walk(root.children ?? [], '');
  return lines.join('\n');
}

function fenced(body: string): string {
  return `\`\`\`\n${body}\n\`\`\`\n`;
}

/** The AST display tree as fenced monospace text. */
export function astToText(root: ASTNode): string {
  return fenced(render(root));
}

/** The plan (or a rewrite's before/after) display tree as fenced monospace text. */
export function planToText(root: PlanNode): string {
  return fenced(render(root));
}

/** The B+Tree as fenced monospace text — the one panel the Mermaid export skips. */
export function indexTreeToText(root: IndexNode): string {
  return fenced(render(toTextNode(root)));
}

/** `IndexNode` carries no `detail`; fold its kind and page id into one. */
function toTextNode(node: IndexNode): TextNode {
  return {
    label: node.label,
    detail: `${node.kind}, page ${String(node.pageId)}`,
    ...(node.children ? { children: node.children.map(toTextNode) } : {}),
  };
}
