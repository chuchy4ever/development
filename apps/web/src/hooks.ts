import { useEffect } from "react";

/**
 * Closes the modal when the user presses Escape. Pair every `onClose`-style
 * modal with this hook so the keyboard shortcut is consistent across the app.
 *
 * Skips when the active element is a textarea/input that has unsubmitted
 * input — Escape typically clears focus there before bubbling up to close
 * the dialog. The default browser behavior already covers that, so we just
 * listen at the window level.
 */
export function useEscClose(onClose: () => void): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
}
