/**
 * Turns the typed AST into the display tree the UI renders, and emits the
 * parse stage as a progressive reveal: SELECT list, then FROM, then WHERE.
 *
 * Node ids are stable across those steps so the tree animates as it grows
 * instead of remounting on every event.
 */

import type { ASTNode } from '../types.ts';
import type { Emit } from '../trace.ts';
import type { Expr, LimitClause, SelectList, SelectStatement, TableRef } from './ast.ts';

function selectListNode(select: SelectList): ASTNode {
  if (select.kind === 'star') {
    return {
      id: 'select',
      kind: 'SelectList',
      label: 'columns',
      detail: 'every column',
      span: select.span,
      children: [{ id: 'select.star', kind: 'Star', label: '*', span: select.span }],
    };
  }
  return {
    id: 'select',
    kind: 'SelectList',
    label: 'columns',
    detail: `${select.names.length} named`,
    span: select.span,
    children: select.names.map((c, i) => ({
      id: `select.col${i}`,
      kind: 'Column',
      label: c.name,
      span: c.span,
    })),
  };
}

function fromNode(from: TableRef): ASTNode {
  return {
    id: 'from',
    kind: 'From',
    label: 'FROM',
    detail: from.name,
    span: from.span,
    children: [{ id: 'from.table', kind: 'Table', label: from.name, span: from.span }],
  };
}

function exprNode(expr: Expr, id: string): ASTNode {
  switch (expr.kind) {
    case 'column':
      return { id, kind: 'Column', label: expr.name, span: expr.span };
    case 'literal':
      return { id, kind: 'Literal', label: expr.raw, span: expr.span };
    case 'compare':
      return {
        id,
        kind: 'Compare',
        label: expr.op,
        span: expr.span,
        children: [exprNode(expr.left, `${id}.l`), exprNode(expr.right, `${id}.r`)],
      };
    case 'and':
      return {
        id,
        kind: 'And',
        label: 'AND',
        span: expr.span,
        children: [exprNode(expr.left, `${id}.l`), exprNode(expr.right, `${id}.r`)],
      };
  }
}

function whereNode(where: Expr): ASTNode {
  return {
    id: 'where',
    kind: 'Where',
    label: 'WHERE',
    span: where.span,
    children: [exprNode(where, 'where.expr')],
  };
}

function limitNode(limit: LimitClause): ASTNode {
  return {
    id: 'limit',
    kind: 'Limit',
    label: 'LIMIT',
    detail: String(limit.value),
    span: limit.span,
  };
}

function root(children: ASTNode[], span: SelectStatement['span']): ASTNode {
  return { id: 'select-stmt', kind: 'SelectStatement', label: 'SELECT', span, children };
}

/** The complete display tree for a parsed statement. */
export function toDisplayTree(ast: SelectStatement): ASTNode {
  const children = [selectListNode(ast.select), fromNode(ast.from)];
  if (ast.where) children.push(whereNode(ast.where));
  if (ast.limit) children.push(limitNode(ast.limit));
  return root(children, ast.span);
}

function countNodes(node: ASTNode): number {
  return 1 + (node.children ?? []).reduce((n, c) => n + countNodes(c), 0);
}

/** Emit the parse stage one clause at a time, so it can be stepped through. */
export function emitParseEvents(emit: Emit, ast: SelectStatement): void {
  const children: ASTNode[] = [];

  const selectList = selectListNode(ast.select);
  children.push(selectList);
  emit(
    ast.select.kind === 'star'
      ? 'Read the SELECT list: `*`, meaning every column of the table.'
      : `Read the SELECT list: ${ast.select.names.map((c) => `\`${c.name}\``).join(', ')}.`,
    { stage: 'parse', ast: root([...children], ast.span), span: ast.select.span },
  );

  children.push(fromNode(ast.from));
  emit(`Read the FROM clause: the query reads the \`${ast.from.name}\` table.`, {
    stage: 'parse',
    ast: root([...children], ast.span),
    span: ast.from.span,
  });

  if (ast.where) {
    children.push(whereNode(ast.where));
    emit(
      'Read the WHERE clause and build the predicate tree. Nothing has been executed yet — this is still only structure.',
      { stage: 'parse', ast: root([...children], ast.span), span: ast.where.span },
    );
  }

  if (ast.limit) {
    children.push(limitNode(ast.limit));
    emit(`Read the LIMIT clause: cap the result at ${ast.limit.value}.`, {
      stage: 'parse',
      ast: root([...children], ast.span),
      span: ast.limit.span,
    });
  }

  const tree = root([...children], ast.span);
  emit(
    `Parsing is done: ${countNodes(tree)} AST nodes and no data touched. The planner turns this shape into a plan next.`,
    { stage: 'parse', ast: tree, span: ast.span },
  );
}
