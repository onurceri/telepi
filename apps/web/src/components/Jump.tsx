import { useEffect, useState } from "react";

/**
 * A floating shortcut to one end of a long scrolling screen. It appears only once the reader
 * is most of a screen away from that end, and sits above the content without taking space.
 * Mount it as the last child of the scrolling element.
 */
export function JumpButton({ scrollEl, to }: { scrollEl: HTMLElement | null; to: "top" | "bottom" }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!scrollEl) return;
    const update = () => {
      const away = to === "top" ? scrollEl.scrollTop : scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
      setShow(away > scrollEl.clientHeight * 0.75);
    };
    update();
    scrollEl.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(scrollEl);
    return () => {
      scrollEl.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, [scrollEl, to]);

  if (!show) return null;

  const jump = () => {
    if (!scrollEl) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollEl.scrollTo({ top: to === "top" ? 0 : scrollEl.scrollHeight, behavior: calm ? "auto" : "smooth" });
  };

  return (
    <div className="jump-anchor">
      <button type="button" className="jump" onClick={jump}>
        {to === "top" ? "↑ Top" : "↓ Latest"}
      </button>
    </div>
  );
}
