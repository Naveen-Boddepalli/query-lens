import type { ASTNode, PlanNode } from '../../engine/index.ts';

type AnyNode = { label: string; detail?: string; children?: AnyNode[] };

function toAny(node: ASTNode | PlanNode): AnyNode {
  const detail = 'detail' in node ? node.detail : undefined;
  return {
    label: node.label,
    ...(detail === undefined ? {} : { detail }),
    ...(node.children ? { children: node.children.map(toAny) } : {}),
  };
}

function Branch({ node, depth = 0 }: { node: AnyNode; depth?: number }) {
  return (
    <li className="relative">
      <div
        className="inline-flex items-baseline gap-2 rounded-md border border-edge bg-surface-3 px-2.5 py-1 font-mono text-xs"
        style={{ marginLeft: depth === 0 ? 0 : 0 }}
      >
        <span>{node.label}</span>
        {node.detail && <span className="text-[10px] text-ink-dim">{node.detail}</span>}
      </div>
      {node.children && node.children.length > 0 && (
        <ul className="mt-1.5 ml-4 space-y-1.5 border-l border-edge pl-4">
          {node.children.map((child, i) => (
            <Branch key={`${child.label}-${i}`} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * M0 renders trees as a nested list. React Flow + d3-hierarchy take over in
 * M1/M2, once there is a real AST worth laying out.
 */
export function TreePanel({ root, empty }: { root: ASTNode | PlanNode | null; empty: string }) {
  if (!root) return <p className="text-sm text-ink-dim">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      <Branch node={toAny(root)} />
    </ul>
  );
}
