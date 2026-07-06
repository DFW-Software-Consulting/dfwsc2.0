import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export const AuthContext = createContext(null);

// Module-level ref so QueryCache onError can call logout outside React render
export const authLogoutRef = { current: null };

export function AuthProvider({ children, initialToken }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState(() => initialToken ?? null);
  const [bootstrapPending, setBootstrapPending] = useState(
    () => sessionStorage.getItem("adminBootstrapPending") === "1"
  );

  const isLoggedIn = !!token;

  const login = useCallback((newToken, pending = false) => {
    setToken(newToken);
    setBootstrapPending(pending);
    if (pending) {
      sessionStorage.setItem("adminBootstrapPending", "1");
    } else {
      sessionStorage.removeItem("adminBootstrapPending");
    }
  }, []);

  const clearBootstrapPending = useCallback(() => {
    setBootstrapPending(false);
    sessionStorage.removeItem("adminBootstrapPending");
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem("adminBootstrapPending");
    setToken(null);
    setBootstrapPending(false);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    authLogoutRef.current = logout;
    return () => {
      authLogoutRef.current = null;
    };
  }, [logout]);

  const value = useMemo(
    () => ({ token, isLoggedIn, login, logout, bootstrapPending, clearBootstrapPending }),
    [token, isLoggedIn, login, logout, bootstrapPending, clearBootstrapPending]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
