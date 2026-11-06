import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { applyHead, buildHead } from "./head.js";
import { resolveMeta } from "./meta.js";

/** Keeps the document head in step with the current route. Renders nothing. */
export default function Seo() {
  const { pathname } = useLocation();
  useEffect(() => {
    applyHead(document, buildHead(resolveMeta(pathname), pathname));
  }, [pathname]);
  return null;
}
