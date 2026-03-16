import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

export const AuthContext = createContext(null);

// Module-level ref so QueryCache onError can call logout outside React render
export const authLogoutRef = { current: null };

export function AuthProvider({ children, initialToken }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState(() => initialToken ?? sessionStorage.getItem("adminToken"));

  const isLoggedIn = !!token;

  const login = useCallback((newToken) => {
    sessionStorage.setItem("adminToken", newToken);
    setToken(newToken);
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem("adminToken");
    setToken(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    authLogoutRef.current = logout;
    return () => {
      authLogoutRef.current = null;
    };
  }, [logout]);

  return (
    <AuthContext.Provider value={{ token, isLoggedIn, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
