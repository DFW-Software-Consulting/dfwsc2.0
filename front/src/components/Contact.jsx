import { useCallback, useEffect, useRef, useState } from "react";
import { useContactForm } from "../hooks/useContact";
import { validateEmail, validateName } from "../utils/validation";

const INITIAL_FORM = { name: "", email: "", company: "", message: "", _hp: "" };

const validateCompany = (v) => {
  if (!v?.trim()) return "Company or project is required";
  return v.trim().length > 100 ? "Company or project must not exceed 100 characters" : null;
};

const HONEYPOT_STYLE = {
  position: "absolute",
  left: "-10000px",
  width: "1px",
  height: "1px",
  overflow: "hidden",
};

function Field({ id, label, error, children }) {
  return (
    <div className="studio-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error && (
        <p id={`${id}-error`} className="studio-field-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Contact form for the Home contact band (POST /api/v1/contact). */
export default function Contact() {
  const [form, setForm] = useState(INITIAL_FORM);
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const confirmRef = useRef(null);
  const contactMutation = useContactForm();

  useEffect(() => {
    if (submitted) confirmRef.current?.focus();
  }, [submitted]);

  const updateField = useCallback(
    (field) => (e) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
    },
    []
  );

  const handleSubmit = useCallback(
    (e) => {
      e.preventDefault();
      const nextErrors = {
        name: validateName(form.name, 1, 100, "Name"),
        email: validateEmail(form.email),
        company: validateCompany(form.company),
        message: validateName(form.message, 1, 2000, "Message"),
      };
      setErrors(nextErrors);
      const firstInvalid = ["name", "email", "company", "message"].find((k) => nextErrors[k]);
      if (firstInvalid) {
        document.getElementById(`contact-${firstInvalid}`)?.focus();
        return;
      }

      contactMutation.mutate(
        {
          name: form.name.trim(),
          email: form.email.trim(),
          company: form.company.trim(),
          message: form.message.trim(),
          _hp: form._hp,
        },
        {
          onSuccess: (data) => {
            if (data?.ok) {
              setForm(INITIAL_FORM);
              setSubmitted(true);
            }
          },
        }
      );
    },
    [form, contactMutation]
  );

  const isPending = contactMutation.isPending;
  const isError = contactMutation.isError;

  if (submitted) {
    return (
      <div
        ref={confirmRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className="studio-contact-form studio-contact-done"
      >
        Thanks — we&apos;ll be in touch.
      </div>
    );
  }

  const fieldProps = (key) => ({
    id: `contact-${key}`,
    value: form[key],
    onChange: updateField(key),
    disabled: isPending,
    "aria-invalid": errors[key] ? true : undefined,
    "aria-describedby": errors[key] ? `contact-${key}-error` : undefined,
  });

  return (
    <form onSubmit={handleSubmit} noValidate className="studio-contact-form">
      <div aria-hidden="true" style={HONEYPOT_STYLE}>
        <label htmlFor="contact-hp">Leave this field empty</label>
        <input
          id="contact-hp"
          name="_hp"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={form._hp}
          onChange={updateField("_hp")}
        />
      </div>

      <Field id="contact-name" label="Name" error={errors.name}>
        <input
          {...fieldProps("name")}
          type="text"
          placeholder="Your name"
          maxLength={100}
          required
          autoComplete="name"
        />
      </Field>
      <Field id="contact-email" label="Email" error={errors.email}>
        <input
          {...fieldProps("email")}
          type="email"
          placeholder="you@company.com"
          required
          autoComplete="email"
        />
      </Field>
      <Field id="contact-company" label="Company or project" error={errors.company}>
        <input
          {...fieldProps("company")}
          type="text"
          placeholder="Your company or project name"
          maxLength={100}
          required
          autoComplete="organization"
        />
      </Field>
      <Field id="contact-message" label="Message" error={errors.message}>
        <textarea
          {...fieldProps("message")}
          placeholder="Tell us your goal, timeline, and must-haves"
          maxLength={2000}
          required
          rows={5}
        />
      </Field>

      <button type="submit" className="studio-button" disabled={isPending}>
        {isPending ? "Sending..." : "Send message"}
      </button>

      {isError && (
        <p role="alert" className="studio-form-alert">
          Something went wrong sending your message. Please email us directly at{" "}
          <a href="mailto:mail@dfwsc.com">mail@dfwsc.com</a>.
        </p>
      )}
    </form>
  );
}
