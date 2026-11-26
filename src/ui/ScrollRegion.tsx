import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A table that is wider than its column scrolls, and a box that scrolls has to be reachable from the keyboard
 * (WCAG 2.1.1; axe's `scrollable-region-focusable`): a table of plain text has nothing focusable inside it, so
 * without a tab stop on the box its overflow cannot be reached without a pointer. This is that tab stop, with a name
 * so the region is announced as what it holds.
 *
 * On a phone a table that scrolls sideways looked cut off: nothing said there was more to the right. So the box
 * marks which of its edges has more behind it (`data-more-start`, `data-more-end`) and `.ql-scroll-cue` fades that
 * edge. `stickyFirst` pins the first column (the row's name) while the rest scrolls under it.
 *
 * `className` is the whole of the box's classes, overflow included: some of these scroll on both axes, some on one.
 */
export function ScrollRegion({
  label,
  className,
  stickyFirst = false,
  cue = true,
  children,
}: {
  label: string;
  className: string;
  stickyFirst?: boolean;
  /** Fade the edge with more behind it. Off for a region that is itself a bordered card: the fade would clip it. */
  cue?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      // Under `dir="rtl"` scrollLeft runs negative; its magnitude is still the distance from the start.
      const left = Math.abs(el.scrollLeft);
      const more = el.scrollWidth - el.clientWidth;
      el.toggleAttribute('data-more-start', left > 1);
      el.toggleAttribute('data-more-end', more - left > 1);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      role="region"
      aria-label={label}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className={`${cue ? 'ql-scroll-cue' : ''}${stickyFirst ? ' ql-sticky-first' : ''} ${className}`}
    >
      {children}
    </div>
  );
}
