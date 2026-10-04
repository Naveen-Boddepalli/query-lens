import { describe, expect, it } from 'vitest';
import { nextFocus, treeRelations } from '../panels/treeNavigation.ts';

interface T {
  id: string;
  children?: T[];
}

const tree: T = {
  id: 'root',
  children: [
    { id: 'a', children: [{ id: 'a1' }, { id: 'a2' }] },
    { id: 'b' },
  ],
};

describe('treeRelations', () => {
  const rel = treeRelations(tree);

  it('gives the root level 1, no parent and no siblings', () => {
    expect(rel.get('root')).toEqual({ level: 1, position: 1, setSize: 1, firstChild: 'a' });
  });

  it('places a child among its siblings and links it to its parent', () => {
    expect(rel.get('a')).toEqual({
      level: 2,
      position: 1,
      setSize: 2,
      parent: 'root',
      firstChild: 'a1',
      next: 'b',
    });
    expect(rel.get('b')).toEqual({ level: 2, position: 2, setSize: 2, parent: 'root', prev: 'a' });
  });

  it('links a grandchild to its parent and its own siblings only', () => {
    expect(rel.get('a2')).toEqual({ level: 3, position: 2, setSize: 2, parent: 'a', prev: 'a1' });
  });

  it('gives a leaf no first child', () => {
    expect(rel.get('a1')?.firstChild).toBeUndefined();
  });
});

describe('nextFocus', () => {
  const rel = treeRelations(tree);

  it('moves up to the parent, down to the first child, and left and right through siblings', () => {
    expect(nextFocus(rel.get('a')!, 'ArrowUp')).toBe('root');
    expect(nextFocus(rel.get('root')!, 'ArrowDown')).toBe('a');
    expect(nextFocus(rel.get('a')!, 'ArrowRight')).toBe('b');
    expect(nextFocus(rel.get('b')!, 'ArrowLeft')).toBe('a');
  });

  it('does nothing past the edges of the tree', () => {
    expect(nextFocus(rel.get('root')!, 'ArrowUp')).toBeUndefined();
    expect(nextFocus(rel.get('root')!, 'ArrowLeft')).toBeUndefined();
    expect(nextFocus(rel.get('a1')!, 'ArrowDown')).toBeUndefined();
    expect(nextFocus(rel.get('a1')!, 'ArrowLeft')).toBeUndefined();
    expect(nextFocus(rel.get('b')!, 'ArrowRight')).toBeUndefined();
  });

  it('ignores keys that are not tree navigation', () => {
    expect(nextFocus(rel.get('a')!, 'Enter')).toBeUndefined();
    expect(nextFocus(rel.get('a')!, 'Tab')).toBeUndefined();
  });
});
