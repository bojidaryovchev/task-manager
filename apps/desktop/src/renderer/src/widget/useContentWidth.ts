import { useEffect, type RefObject } from 'react';

/**
 * Report an element's natural width to the main process.
 *
 * The widget window is frameless and sized to its content, so its width has to
 * come from somewhere. For the layouts built from bars and charts that is a
 * fixed number, because those need a stable amount of room. For the minimal
 * layout it is not: its width is whatever its labels and values happen to need,
 * and no constant serves both `CPU 5%` and `DISK READ 126 KB/s` — one leaves
 * dead space inside the widget's own outline, the other clips.
 *
 * So that layout measures itself and tells main. The element must size to its
 * content (`width: max-content`) rather than stretch, otherwise it would only
 * ever measure the window it is already inside and the value would be circular.
 *
 * No feedback loop: because the element does not stretch, resizing the window
 * around it does not change what it measures, so the observer settles after one
 * report.
 */
export function useContentWidth(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const report = (): void => {
      // `offsetWidth` rounds to whole pixels, which is what a window bound is.
      const width = element.offsetWidth;
      if (width > 0) void window.taskManager.reportWidgetContentWidth(width);
    };

    report();
    // Fonts load after first paint and change text metrics, and the values
    // themselves change width as the numbers move, so one measurement at mount
    // is not enough.
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
}
