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

function readTheme() {
  const saved = localStorage.getItem("theme");
  if (saved) return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
  const theme = chosen ?? (settled ? readTheme() : "light");

  useEffect(() => {
    if (!settled) startTransition(() => setSettled(true));
  }, [settled]);

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
  }, [theme]);

  useEffect(() => {
    if (chosen) localStorage.setItem("theme", chosen);
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
