import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const ThemeContext = createContext();

// Same rule as public/theme-init.js, which applies it before first paint.
function readTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem("theme");
  } catch {
    // Storage blocked: use the OS preference.
  }
  if (saved) return saved;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/**
 * `hydrating` is true when the first render must match prerendered HTML (the server render
 * and a hydrating browser render), which is always light. The stored/system theme is then
 * applied in a transition: that is lower priority than hydrating the page's Suspense
 * boundaries, which a context change would otherwise hit while they are still dehydrated,
 * forcing them to client-render.
 */
export function ThemeProvider({ children, hydrating = false }) {
  const [settled, setSettled] = useState(!hydrating);
  const [chosen, setChosen] = useState(null);
  const initial = useMemo(() => (settled ? readTheme() : "light"), [settled]);
  const theme = chosen ?? initial;

  useEffect(() => {
    if (!settled) startTransition(() => setSettled(true));
  }, [settled]);

  useEffect(() => {
    // While hydrating, theme-init.js has already set the real class; "light" is only the
    // placeholder that matches the prerendered markup, so it must not overwrite it.
    if (!settled && !chosen) return;
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
  }, [theme, settled, chosen]);

  useEffect(() => {
    if (!chosen) return;
    try {
      localStorage.setItem("theme", chosen);
    } catch {
      // Storage blocked: the choice lasts for this page view only.
    }
  }, [chosen]);

  const toggleTheme = useCallback(() => {
    setChosen(theme === "dark" ? "light" : "dark");
  }, [theme]);

  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
