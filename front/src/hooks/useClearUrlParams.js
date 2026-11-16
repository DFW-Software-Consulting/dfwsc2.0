import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

// Replaces the current URL with its bare path once a query string or hash is present, so a
// one-time token read from the link does not stay in the address bar or browser history.
export function useClearUrlParams() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (location.search || location.hash) {
      navigate(location.pathname, { replace: true });
    }
  }, [location.hash, location.pathname, location.search, navigate]);
}
