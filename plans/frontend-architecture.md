# Plan: Frontend Architecture & Quality

## Goal
Add TypeScript to critical paths, implement code splitting, refactor mega-components, fix context re-renders, and improve accessibility.

## Current State
- Entire frontend is `.jsx` with zero type safety
- All pages eagerly imported — admin bundle loads for marketing visitors (`App.jsx:2-12`)
- Mega-components: `CreateClientForm.jsx` (428 lines), `EditClientModal.jsx` (426 lines), `GroupPanel.jsx` (418 lines)
- `AuthContext` value object recreated every render (`AuthContext.jsx:34`)
- `ThemeContext` `toggleTheme` not wrapped in `useCallback` (`ThemeContext.jsx:19`)
- `BaseModal` lacks focus trap (`BaseModal.jsx`)
- JWT stored in `sessionStorage` — vulnerable to XSS extraction
- `apiFetch` swallows non-JSON errors (`api/client.js:11`)
- Query key invalidation too broad — misses parameterized queries (`hooks/useClients.js:37`)

---

## Step 1: Add code splitting with React.lazy

**File:** `front/src/App.jsx`

```jsx
// BEFORE
import AdminPage from "./pages/AdminPage";
import Docs from "./pages/Docs.jsx";
// ... all eagerly imported

// AFTER
import { lazy, Suspense } from "react";

const Home = lazy(() => import("./pages/Home.jsx"));
const Pricing = lazy(() => import("./pages/Pricing.jsx"));
const Team = lazy(() => import("./pages/Team.jsx"));
const Docs = lazy(() => import("./pages/Docs.jsx"));
const OnboardClient = lazy(() => import("./pages/OnboardClient"));
const AdminPage = lazy(() => import("./pages/AdminPage"));
const PaymentSuccess = lazy(() => import("./pages/PaymentSuccess"));
const PaymentCancel = lazy(() => import("./pages/PaymentCancel"));
const OnboardingSuccess = lazy(() => import("./pages/OnboardingSuccess"));

// Wrap Routes in Suspense
<main className="relative z-10">
  <Suspense fallback={
    <div className="flex items-center justify-center min-h-[50vh]">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-500" />
    </div>
  }>
    <Routes>
      {/* ... routes unchanged ... */}
    </Routes>
  </Suspense>
</main>
```

**Verification:** `npm run build` → check chunk sizes. Marketing pages should not include admin code. Admin page loads its own chunk.

---

## Step 2: Memoize context values

### 2a: ThemeContext

**File:** `front/src/contexts/ThemeContext.jsx`

```jsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

const ThemeContext = createContext();

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("theme");
    if (saved) return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
```

### 2b: AuthContext

**File:** `front/src/contexts/AuthContext.jsx`

```jsx
const value = useMemo(() => ({ token, isLoggedIn, login, logout }), [token, isLoggedIn, login, logout]);

return (
  <AuthContext.Provider value={value}>
    {children}
  </AuthContext.Provider>
);
```

**Verification:** Add `console.log` to a child component using `useTheme()` → should not re-render when unrelated state changes.

---

## Step 3: Fix apiFetch error handling

**File:** `front/src/api/client.js`

```javascript
export async function apiFetch(path, { token, method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${import.meta.env.VITE_API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const contentType = res.headers.get("content-type") || "";
  let data;

  if (contentType.includes("application/json")) {
    data = await res.json();
  } else {
    // Non-JSON response (e.g., HTML error page from proxy)
    const text = await res.text();
    data = { error: text.slice(0, 200) || `HTTP ${res.status}` };
  }

  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}
```

**Verification:** Proxy returns HTML 502 → error message includes first 200 chars of HTML instead of empty `{}`.

---

## Step 4: Fix query key invalidation

**File:** `front/src/hooks/useClients.js`

```javascript
// BEFORE
export function useCreateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createClient,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
    },
  });
}

// AFTER
export function useCreateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createClient,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      // Also invalidate all parameterized client queries
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === "clients",
      });
    },
  });
}
```

Apply the same pattern to `usePatchClient`, `useCreateGroup`, `usePatchGroup`.

**Verification:** Create a client while viewing a filtered list → the filtered list refreshes.

---

## Step 5: Add focus trap to BaseModal

**File:** `front/src/components/admin/shared/BaseModal.jsx`

```jsx
import { useEffect, useRef } from "react";

export default function BaseModal({ isOpen, onClose, title, children }) {
  const modalRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement;
      // Focus the modal when it opens
      modalRef.current?.focus();
    } else {
      // Return focus to the trigger element
      previousFocusRef.current?.focus();
    }
  }, [isOpen]);

  // Focus trap
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }

      if (e.key === "Tab") {
        const modal = modalRef.current;
        if (!modal) return;

        const focusable = modal.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true" aria-label={title}>
      <div
        ref={modalRef}
        tabIndex={-1}
        className="bg-[var(--bg-surface)] rounded-lg p-6 max-w-lg w-full mx-4 outline-none"
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--text-muted)] hover:text-[var(--text-main)] text-xl leading-none"
          >
            &times;
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
```

**Verification:** Open modal → Tab cycles within modal only. Press Escape → modal closes. Focus returns to trigger button.

---

## Step 6: Refactor mega-components (incremental)

This is a multi-sprint effort. Start with the highest-impact component:

### 6a: Extract `EditGroupModal` from `GroupPanel`

**File:** `front/src/components/admin/GroupPanel.jsx`

Move the inner `EditGroupModal` component (lines 23-162) to its own file:

```javascript
// front/src/components/admin/EditGroupModal.jsx
export default function EditGroupModal({ isOpen, onClose, group, onSave }) {
  // ... move all the state and logic from GroupPanel's inner component
}
```

Then in `GroupPanel.jsx`:

```jsx
import EditGroupModal from "./EditGroupModal";

// Remove the inner component definition (lines 23-162)
// Use it as:
{editingGroup && (
  <EditGroupModal
    isOpen={!!editingGroup}
    onClose={() => setEditingGroup(null)}
    group={editingGroup}
    onSave={handleSave}
  />
)}
```

### 6b: Extract form logic from `CreateClientForm`

Split into `CreateClientForm.jsx` (UI) and `useCreateClientForm.js` (state/logic hook):

```javascript
// front/src/hooks/useCreateClientForm.js
export function useCreateClientForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  // ... all 11 state variables

  const canSubmit = useMemo(() => name.trim() && email.trim(), [name, email]);
  const handleSubmit = useCallback(async () => { ... }, [name, email, ...]);

  return { name, setName, email, setEmail, canSubmit, handleSubmit, ... };
}
```

**Verification:** Each extracted component works identically to before. Component file sizes drop below 200 lines.

---

## Step 7: Move JWT to httpOnly cookie (optional, high effort)

**File:** `front/src/contexts/AuthContext.jsx`, `backend/src/routes/auth.ts`

This is the most secure approach but requires backend changes:

1. Backend sets `Set-Cookie: token=...; HttpOnly; Secure; SameSite=Strict` on login
2. Frontend removes `sessionStorage` usage
3. API calls include cookies automatically

**Verification:** `document.cookie` does not contain the JWT. XSS cannot extract it.

---

## Verification Plan
1. `npm run build` → check chunk splitting (admin not in marketing bundle)
2. Toggle theme → only theme-consuming components re-render
3. Proxy returns HTML error → `apiFetch` throws with meaningful message
4. Create client while filtered list is open → filtered list refreshes
5. Open/close modal → Tab is trapped, focus returns to trigger
6. `GroupPanel.jsx` < 200 lines after refactor
7. Admin bundle size reduced by > 30%

## Risks
- Code splitting adds loading states — must be graceful
- Focus trap must work with all existing modals
- Context memoization must not break any existing consumers
- Component refactoring is incremental — each step should be tested independently
