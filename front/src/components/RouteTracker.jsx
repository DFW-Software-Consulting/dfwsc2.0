import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { recordPage } from "../utils/visitContext.js";

/** Records public marketing page views in memory for the contact form. Renders nothing. */
export default function RouteTracker() {
  const { pathname } = useLocation();
  useEffect(() => {
    recordPage(pathname);
  }, [pathname]);
  return null;
}
