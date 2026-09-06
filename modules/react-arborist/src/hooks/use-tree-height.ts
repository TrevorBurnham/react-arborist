import { MutableRefObject, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
/* Type-only: tree-api imports DEFAULT_HEIGHT from here, so keep this module
   free of a runtime dependency back on it. */
import type { TreeApi } from "../interfaces/tree-api";

/** The height a tree falls back to when nothing else determines one. */
export const DEFAULT_HEIGHT = 500;

export type HeightPlan = {
  /** CSS height for the tree element. */
  cssHeight: number | string;
  /** CSS max-height for the tree element, when the maxHeight prop is set. */
  cssMaxHeight: number | string | undefined;
  /** Pixel height handed to the virtualized list. */
  listHeight: number;
  /** Whether the element has to be measured to know its pixel height. */
  needsMeasure: boolean;
  /** Whether the element's height comes from the rows, so changing row heights
      changes it. */
  sizedByContent: boolean;
};

type Args = {
  height: number | string | undefined;
  maxHeight: number | string | undefined;
  contentHeight: number;
  measured: number | null;
};

/**
 * Work out what the tree element's CSS should be and how many pixels tall the
 * virtualized list inside it is.
 *
 * react-window needs a real pixel height, but the height prop may be a CSS
 * value only the browser can resolve ("100%", "50vh"). Those cases go on the
 * element and come back through a ResizeObserver; everything else is computed
 * here so the common numeric-height tree never measures anything.
 */
export function resolveTreeHeight({
  height,
  maxHeight,
  contentHeight,
  measured,
}: Args): HeightPlan {
  /* "auto" means "as tall as the rows"; a bare maxHeight implies it, since a
     tree that is always DEFAULT_HEIGHT tall would ignore the cap. Null counts
     as absent, the way the height prop has always treated it. */
  const isAuto = height === "auto" || (height == null && maxHeight != null);
  /* The height the tree asks for, before any cap. Null when only the browser
     can resolve it. */
  const requested = isAuto
    ? contentHeight
    : typeof height === "number"
      ? height
      : height == null
        ? DEFAULT_HEIGHT
        : null;
  const needsMeasure = requested === null || typeof maxHeight === "string";
  const cap = typeof maxHeight === "number" ? maxHeight : Infinity;
  return {
    cssHeight: requested === null ? (height as string) : requested,
    cssMaxHeight: maxHeight ?? undefined,
    /* Before the first measurement the list has no height to fill, so it
       mounts nothing beyond react-window's minimum row. That lasts one
       pre-paint render, and beats guessing a height and mounting every row of
       a large tree. The element's own height comes from CSS, never from the
       list, so measuring it is never circular. */
    listHeight: needsMeasure ? (measured ?? 0) : Math.min(requested as number, cap),
    needsMeasure,
    sizedByContent: isAuto,
  };
}

/* Layout effects don't run on the server, where React warns about them. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Resolve the tree's height, measuring the element when the height prop is a
 * CSS value. Returns the ref to attach to the tree element along with the plan
 * for rendering it.
 */
export function useTreeHeight<T>(tree: TreeApi<T>): {
  ref: MutableRefObject<HTMLDivElement | null>;
  plan: HeightPlan;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  const warned = useRef(false);
  const [, redrawn] = useReducer((count: number) => count + 1, 0);
  const plan = resolveTreeHeight({
    height: tree.props.height,
    maxHeight: tree.props.maxHeight,
    contentHeight: tree.contentHeight,
    measured,
  });
  /* The list and the tree api read the resolved height further down this same
     render, so hand it over before returning. */
  tree.setPixelHeight(plan.listHeight);

  const { needsMeasure, cssHeight, cssMaxHeight } = plan;
  useIsomorphicLayoutEffect(() => {
    if (!needsMeasure) {
      setMeasured(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const height = el.clientHeight;
      setMeasured((prev) => (prev === height ? prev : height));
    };
    /* Measure in a layout effect so the corrected height paints in the same
       frame the tree mounts in; the observer only reports later changes. */
    read();
    if (!warned.current && isMisconfigured(el, tree.contentHeight)) {
      warned.current = true;
      warnAboutZeroHeight();
    }
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [needsMeasure, cssHeight, cssMaxHeight]);

  /* A tree sized by its rows has to re-render when the row heights change out
     from under it, which is what redrawList() announces. Nothing else does:
     redrawList only force-updates the list itself. */
  useEffect(() => {
    if (!plan.sizedByContent) return;
    return tree.onRedraw(redrawn);
  }, [tree, plan.sizedByContent]);

  return { ref, plan };
}

/**
 * Whether a tree that measured zero has a real problem to report. A tree with
 * no rows is legitimately empty, and one that isn't laid out at all
 * (display: none, an unopened tab) has no client rects and no height yet.
 * What's left is a tree with rows, on the page, that still has nowhere to draw
 * them.
 */
function isMisconfigured(el: HTMLElement, contentHeight: number) {
  if (contentHeight === 0) return false;
  return el.clientHeight === 0 && el.getClientRects().length > 0;
}

/**
 * A percentage height resolves to zero unless the parent has a definite
 * height, which is the usual reason a self-sizing tree renders nothing. Say so
 * rather than leaving an empty box. Warned at most once per tree, so one
 * misconfigured tree never silences the diagnostic for another.
 */
function warnAboutZeroHeight() {
  console.warn(
    `React Arborist Tree => The tree measured 0px tall, so no rows will render. ` +
      `A percentage height needs a parent with a definite height: give the parent a ` +
      `fixed height, or "flex: 1; min-height: 0" inside a flex column. Pass a number ` +
      `to the height prop to skip measuring.`,
  );
}
