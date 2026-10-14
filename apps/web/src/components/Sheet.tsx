import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * A bottom sheet on a native modal dialog: labelled, focus is trapped, Escape closes it.
 * Focus returns to the control that opened it. The parent unmounts it in onClose.
 */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const opener = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    // The parent unmounts the sheet when it closes; the dialog leaves the DOM with it. Give focus back to the opener.
    return () => opener.current?.focus();
  }, []);

  return (
    <dialog ref={ref} className="sheet low" aria-labelledby={titleId} onClose={onClose} onCancel={onClose}>
      <div className="low-in">
        <h2 className="h" id={titleId}>{title}</h2>
        {children}
      </div>
    </dialog>
  );
}
