/**
 * Turns the typed AST into the display tree the UI renders, and emits the
 * parse stage as a progressive reveal: SELECT list, then FROM, then WHERE.
 *
 * Node ids are stable across those steps so the tree animates as it grows
 * instead of remounting on every event.
 */

import type { ASTNode, Span } from '../types.ts';
import type { Emit } from '../trace.ts';
import type {
  AnalyzeStatement,
  DeleteStatement,
  Expr,
  GroupByClause,
  InsertColumnList,
  InsertStatement,
  InsertValues,
  LimitClause,
  OrderByClause,
  SelectItem,
  SelectList,
  SelectStatement,
  TableRef,
  UpdateAssignment,
  UpdateStatement,
} from './ast.ts';
import { columnKey, selectItemKey } from './ast.ts';
import { aggregateKeyOf, exprToSql } from './print.ts';

function selectItemNode(item: SelectItem, id: string): ASTNode {
  if (item.kind === 'column') return { id, kind: 'Column', label: item.name, span: item.span };
  if (item.kind === 'expression') {
    return {
      id,
      kind: 'Expression',
      label: selectItemKey(item),
      ...(item.alias === undefined ? {} : { detail: exprToSql(item.expr) }),
      span: item.span,
      children: [exprNode(item.expr, `${id}.e`)],
    };
  }
  return { id, kind: 'Aggregate', label: selectItemKey(item), span: item.span };
}

function selectListNode(select: SelectList, distinct = false): ASTNode {
  // `SELECT DISTINCT` (plan.md §25.4 B2) is a property of the whole list, so it is shown on the list's own node.
  const prefix = distinct ? 'DISTINCT · ' : '';
  if (select.kind === 'star') {
    return {
      id: 'select',
      kind: 'SelectList',
      label: distinct ? 'DISTINCT columns' : 'columns',
      detail: `${prefix}every column`,
      span: select.span,
      children: [{ id: 'select.star', kind: 'Star', label: '*', span: select.span }],
    };
  }
  return {
    id: 'select',
    kind: 'SelectList',
    label: distinct ? 'DISTINCT columns' : 'columns',
    detail: `${prefix}${select.items.length} named`,
    span: select.span,
    children: select.items.map((item, i) => selectItemNode(item, `select.col${i}`)),
  };
}

function groupByNode(groupBy: GroupByClause): ASTNode {
  return {
    id: 'groupBy',
    kind: 'GroupBy',
    label: 'GROUP BY',
    detail: groupBy.columns.map(columnKey).join(', '),
    span: groupBy.span,
    children: groupBy.columns.map((c, i) => ({
      id: `groupBy.col${i}`,
      kind: 'Column',
      label: columnKey(c),
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
    case 'or':
      return {
        id,
        kind: 'Or',
        label: 'OR',
        span: expr.span,
        children: [exprNode(expr.left, `${id}.l`), exprNode(expr.right, `${id}.r`)],
      };
    case 'not':
      return { id, kind: 'Not', label: 'NOT', span: expr.span, children: [exprNode(expr.operand, `${id}.o`)] };
    case 'isNull':
      return {
        id,
        kind: 'IsNull',
        label: expr.negated ? 'IS NOT NULL' : 'IS NULL',
        span: expr.span,
        children: [exprNode(expr.operand, `${id}.o`)],
      };
    case 'in':
      return expr.subquery
        ? {
            id,
            kind: 'In',
            label: expr.negated ? 'NOT IN' : 'IN',
            detail: `subquery — SELECT ${expr.subquery.column.name} FROM ${expr.subquery.from.name}`,
            span: expr.span,
            children: [exprNode(expr.operand, `${id}.o`)],
          }
        : {
            id,
            kind: 'In',
            label: expr.negated ? 'NOT IN' : 'IN',
            detail: `${expr.items.length} value${expr.items.length === 1 ? '' : 's'}`,
            span: expr.span,
            children: [
              exprNode(expr.operand, `${id}.o`),
              ...expr.items.map((item, i) => exprNode(item, `${id}.i${i}`)),
            ],
          };
    case 'aggregate':
      return { id, kind: 'Aggregate', label: aggregateKeyOf(expr.fn, expr.arg), span: expr.span };
    case 'arith':
      return {
        id,
        kind: 'Arith',
        label: expr.op,
        span: expr.span,
        children: [exprNode(expr.left, `${id}.l`), exprNode(expr.right, `${id}.r`)],
      };
    case 'neg':
      return { id, kind: 'Arith', label: '−', detail: 'negate', span: expr.span, children: [exprNode(expr.operand, `${id}.o`)] };
    case 'like':
      return {
        id,
        kind: 'Like',
        label: expr.negated ? 'NOT LIKE' : 'LIKE',
        span: expr.span,
        children: [exprNode(expr.operand, `${id}.o`), exprNode(expr.pattern, `${id}.p`)],
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

function havingNode(having: Expr): ASTNode {
  return {
    id: 'having',
    kind: 'Having',
    label: 'HAVING',
    span: having.span,
    children: [exprNode(having, 'having.expr')],
  };
}

function orderByNode(orderBy: OrderByClause): ASTNode {
  return {
    id: 'orderBy',
    kind: 'OrderBy',
    label: 'ORDER BY',
    detail: `${orderBy.column} ${orderBy.direction === 'asc' ? 'ASC' : 'DESC'}`,
    span: orderBy.span,
    children: [
      orderBy.aggregate
        ? exprNode(orderBy.aggregate, 'orderBy.expr')
        : { id: 'orderBy.col', kind: 'Column', label: orderBy.column, span: orderBy.span },
    ],
  };
}

function limitNode(limit: LimitClause): ASTNode {
  return {
    id: 'limit',
    kind: 'Limit',
    label: 'LIMIT',
    detail: limit.offset === undefined ? String(limit.value) : `${String(limit.value)} OFFSET ${String(limit.offset)}`,
    span: limit.span,
  };
}

function intoNode(into: TableRef): ASTNode {
  return {
    id: 'into',
    kind: 'Into',
    label: 'INTO',
    detail: into.name,
    span: into.span,
    children: [{ id: 'into.table', kind: 'Table', label: into.name, span: into.span }],
  };
}

function insertColumnsNode(columns: InsertColumnList): ASTNode {
  return {
    id: 'columns',
    kind: 'ColumnList',
    label: 'columns',
    detail: `${columns.names.length} named`,
    span: columns.span,
    children: columns.names.map((c, i) => ({
      id: `columns.col${i}`,
      kind: 'Column',
      label: c.name,
      span: c.span,
    })),
  };
}

function valuesNode(values: InsertValues): ASTNode {
  return {
    id: 'values',
    kind: 'Values',
    label: 'VALUES',
    detail: `${values.items.length} value${values.items.length === 1 ? '' : 's'}`,
    span: values.span,
    children: values.items.map((v, i) => exprNode(v, `values.v${i}`)),
  };
}

function updateTableNode(table: TableRef): ASTNode {
  return { id: 'table', kind: 'Table', label: table.name, span: table.span };
}

function assignmentNode(a: UpdateAssignment, id: string): ASTNode {
  return {
    id,
    kind: 'Assignment',
    label: a.column,
    detail: `= ${exprToSql(a.value)}`,
    span: { from: a.columnSpan.from, to: a.value.span.to },
    // A literal is fully described by the detail; a computed value gets its own subtree.
    ...(a.value.kind === 'literal' ? {} : { children: [exprNode(a.value, `${id}.v`)] }),
  };
}

function setNode(set: UpdateStatement['set']): ASTNode {
  return {
    id: 'set',
    kind: 'Set',
    label: 'SET',
    detail: `${set.assignments.length} assignment${set.assignments.length === 1 ? '' : 's'}`,
    span: set.span,
    children: set.assignments.map((a, i) => assignmentNode(a, `set.a${i}`)),
  };
}

const ROOT_KIND = {
  SELECT: 'SelectStatement',
  DELETE: 'DeleteStatement',
  INSERT: 'InsertStatement',
  UPDATE: 'UpdateStatement',
  ANALYZE: 'AnalyzeStatement',
} as const;

function root(
  children: ASTNode[],
  span: Span,
  label: keyof typeof ROOT_KIND = 'SELECT',
): ASTNode {
  return { id: 'select-stmt', kind: ROOT_KIND[label], label, span, children };
}

/** The complete display tree for a parsed statement. */
export function toDisplayTree(ast: SelectStatement): ASTNode {
  const children = [selectListNode(ast.select, ast.distinct), fromNode(ast.from)];
  if (ast.where) children.push(whereNode(ast.where));
  if (ast.groupBy) children.push(groupByNode(ast.groupBy));
  if (ast.having) children.push(havingNode(ast.having));
  if (ast.orderBy) children.push(orderByNode(ast.orderBy));
  if (ast.limit) children.push(limitNode(ast.limit));
  return root(children, ast.span);
}

function countNodes(node: ASTNode): number {
  return 1 + (node.children ?? []).reduce((n, c) => n + countNodes(c), 0);
}

/** Emit the parse stage one clause at a time, so it can be stepped through. */
export function emitParseEvents(emit: Emit, ast: SelectStatement): void {
  const children: ASTNode[] = [];

  const selectList = selectListNode(ast.select, ast.distinct);
  children.push(selectList);
  emit(
    ast.select.kind === 'star'
      ? `Read the SELECT list: ${ast.distinct ? 'DISTINCT ' : ''}\`*\`, meaning every column of the table${ast.distinct ? ' — and each whole row is returned only once' : ''}.`
      : `Read the SELECT list: ${ast.distinct ? 'DISTINCT ' : ''}${ast.select.items.map((item) => `\`${selectItemKey(item)}\``).join(', ')}${ast.distinct ? ' — each distinct combination is returned only once' : ''}.`,
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

  if (ast.groupBy) {
    children.push(groupByNode(ast.groupBy));
    emit(
      `Read the GROUP BY clause: rows are grouped by ${ast.groupBy.columns
        .map((c) => `\`${columnKey(c)}\``)
        .join(', ')}. Nothing has been computed yet — this is still only structure.`,
      { stage: 'parse', ast: root([...children], ast.span), span: ast.groupBy.span },
    );
  }

  if (ast.having) {
    children.push(havingNode(ast.having));
    emit(
      'Read the HAVING clause: a predicate over the *groups* — unlike WHERE it may test aggregates, because it runs after they are computed. Nothing has been computed yet — this is still only structure.',
      { stage: 'parse', ast: root([...children], ast.span), span: ast.having.span },
    );
  }

  if (ast.orderBy) {
    children.push(orderByNode(ast.orderBy));
    emit(
      `Read the ORDER BY clause: sort by \`${ast.orderBy.column}\`, ${
        ast.orderBy.direction === 'asc' ? 'ascending' : 'descending'
      }.`,
      { stage: 'parse', ast: root([...children], ast.span), span: ast.orderBy.span },
    );
  }

  if (ast.limit) {
    children.push(limitNode(ast.limit));
    emit(
      ast.limit.offset === undefined
        ? `Read the LIMIT clause: cap the result at ${ast.limit.value}.`
        : `Read the LIMIT clause: skip the first ${ast.limit.offset} rows, then cap the result at ${ast.limit.value}.`,
      { stage: 'parse', ast: root([...children], ast.span), span: ast.limit.span },
    );
  }

  const tree = root([...children], ast.span);
  emit(
    `Parsing is done: ${countNodes(tree)} AST nodes and no data touched. The planner turns this shape into a plan next.`,
    { stage: 'parse', ast: tree, span: ast.span },
  );
}

/** The complete display tree for a parsed `DELETE`. */
export function deleteDisplayTree(ast: DeleteStatement): ASTNode {
  const children = [fromNode(ast.from)];
  if (ast.where) children.push(whereNode(ast.where));
  return root(children, ast.span, 'DELETE');
}

/** Emit the parse stage for a `DELETE`, one clause at a time — mirrors `emitParseEvents`. */
export function emitDeleteParseEvents(emit: Emit, ast: DeleteStatement): void {
  const children: ASTNode[] = [fromNode(ast.from)];
  emit(`Read the FROM clause: DELETE removes rows from the \`${ast.from.name}\` table.`, {
    stage: 'parse',
    ast: root([...children], ast.span, 'DELETE'),
    span: ast.from.span,
  });

  if (ast.where) {
    children.push(whereNode(ast.where));
    emit(
      'Read the WHERE clause and build the predicate tree. Nothing has been removed yet — this is still only structure.',
      { stage: 'parse', ast: root([...children], ast.span, 'DELETE'), span: ast.where.span },
    );
  }

  const tree = root([...children], ast.span, 'DELETE');
  emit(
    `Parsing is done: ${countNodes(tree)} AST nodes and no data touched. The planner turns this shape into a plan next.`,
    { stage: 'parse', ast: tree, span: ast.span },
  );
}

/** The complete display tree for a parsed `INSERT`. */
export function insertDisplayTree(ast: InsertStatement): ASTNode {
  const children = [intoNode(ast.into)];
  if (ast.columns) children.push(insertColumnsNode(ast.columns));
  children.push(valuesNode(ast.values));
  return root(children, ast.span, 'INSERT');
}

/** Emit the parse stage for an `INSERT`, one clause at a time — mirrors `emitParseEvents`. */
export function emitInsertParseEvents(emit: Emit, ast: InsertStatement): void {
  const children: ASTNode[] = [intoNode(ast.into)];
  emit(`Read the INTO clause: INSERT adds a row to the \`${ast.into.name}\` table.`, {
    stage: 'parse',
    ast: root([...children], ast.span, 'INSERT'),
    span: ast.into.span,
  });

  if (ast.columns) {
    children.push(insertColumnsNode(ast.columns));
    emit(
      `Read the column list: ${ast.columns.names.map((c) => `\`${c.name}\``).join(', ')}.`,
      { stage: 'parse', ast: root([...children], ast.span, 'INSERT'), span: ast.columns.span },
    );
  }

  children.push(valuesNode(ast.values));
  emit(
    `Read the VALUES list: ${ast.values.items.length} value${
      ast.values.items.length === 1 ? '' : 's'
    }. Nothing has been written yet — this is still only structure.`,
    { stage: 'parse', ast: root([...children], ast.span, 'INSERT'), span: ast.values.span },
  );

  const tree = root([...children], ast.span, 'INSERT');
  emit(
    `Parsing is done: ${countNodes(tree)} AST nodes and no data touched. There is nothing to plan or optimize — an INSERT with only literal values goes straight to execution.`,
    { stage: 'parse', ast: tree, span: ast.span },
  );
}

/** The complete display tree for a parsed `UPDATE`. */
export function updateDisplayTree(ast: UpdateStatement): ASTNode {
  const children = [updateTableNode(ast.table), setNode(ast.set)];
  if (ast.where) children.push(whereNode(ast.where));
  return root(children, ast.span, 'UPDATE');
}

/** Emit the parse stage for an `UPDATE`, one clause at a time — mirrors `emitParseEvents`. */
export function emitUpdateParseEvents(emit: Emit, ast: UpdateStatement): void {
  const children: ASTNode[] = [updateTableNode(ast.table)];
  emit(`Read the table name: UPDATE modifies rows in \`${ast.table.name}\`.`, {
    stage: 'parse',
    ast: root([...children], ast.span, 'UPDATE'),
    span: ast.table.span,
  });

  children.push(setNode(ast.set));
  emit(
    `Read the SET clause: ${ast.set.assignments.map((a) => `\`${a.column}\` = ${exprToSql(a.value)}`).join(', ')}. Nothing has been written yet — this is still only structure.`,
    { stage: 'parse', ast: root([...children], ast.span, 'UPDATE'), span: ast.set.span },
  );

  if (ast.where) {
    children.push(whereNode(ast.where));
    emit(
      'Read the WHERE clause and build the predicate tree. Nothing has been modified yet — this is still only structure.',
      { stage: 'parse', ast: root([...children], ast.span, 'UPDATE'), span: ast.where.span },
    );
  }

  const tree = root([...children], ast.span, 'UPDATE');
  emit(
    `Parsing is done: ${countNodes(tree)} AST nodes and no data touched. The planner turns the WHERE clause into a plan next — the SET clause has nothing to plan, it only takes effect once a row is found.`,
    { stage: 'parse', ast: tree, span: ast.span },
  );
}

/** The complete display tree for a parsed `ANALYZE`. */
export function analyzeDisplayTree(ast: AnalyzeStatement): ASTNode {
  return root([updateTableNode(ast.table)], ast.span, 'ANALYZE');
}

/** Emit the parse stage for an `ANALYZE` — one clause, so one step: mirrors `emitParseEvents`'s shape all the same. */
export function emitAnalyzeParseEvents(emit: Emit, ast: AnalyzeStatement): void {
  const tree = root([updateTableNode(ast.table)], ast.span, 'ANALYZE');
  emit(`Read the table name: ANALYZE scans \`${ast.table.name}\` to build its statistics.`, {
    stage: 'parse',
    ast: tree,
    span: ast.table.span,
  });
  emit(
    `Parsing is done: ${countNodes(tree)} AST node${countNodes(tree) === 1 ? '' : 's'} and no data touched. There is nothing to plan or optimize — ANALYZE goes straight to a real scan.`,
    { stage: 'parse', ast: tree, span: ast.span },
  );
}
