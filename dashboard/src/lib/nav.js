import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Folder-style navigation that keeps the browser's Back button sane.
 *
 * `openTo(path)` goes down a level and remembers where it came from.
 * `upTo(path)` goes up a level: when the page above is the one we came from, it steps back in history
 * (so browser Back afterwards keeps going up: sheet → Leads → project → Projects). Otherwise it replaces
 * the current entry, so the sheet doesn't stay behind the folder as a "Back" target.
 */
export function useFolderNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const openTo = useCallback((path) => navigate(path, { state: { from: location.pathname } }), [navigate, location.pathname]);
  const upTo = useCallback(
    (path) => {
      if (location.state?.from === path) navigate(-1);
      else navigate(path, { replace: true });
    },
    [navigate, location.state],
  );
  // for a <Link> that goes up (← or a breadcrumb): plain click = upTo, ctrl/middle-click still opens a new tab
  const upClick = useCallback(
    (path) => (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      if (path !== location.pathname) upTo(path);
    },
    [upTo, location.pathname],
  );
  return { openTo, upTo, upClick };
}
