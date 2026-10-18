import { useCallback, useState } from "react";
import { useContactForm } from "../hooks/useContact";
import { validateEmail, validateName } from "../utils/validation";
import FormInput from "./admin/shared/FormInput";

const contactMethods = [
  { label: "Phone", value: "(214) 326-0128", href: "tel:+12143260128" },
  { label: "Email", value: "mail@dfwsc.com", href: "mailto:mail@dfwsc.com" },
  { label: "Website", value: "www.dfwsc.com", href: "https://www.dfwsc.com" },
  {
    label: "LinkedIn",
    value: "DFW Software Consulting",
    href: "https://www.linkedin.com/company/dfw-software-consulting",
  },
];

const INITIAL_FORM = { name: "", email: "", company: "", message: "", _hp: "" };

function validateMessage(v) {
  return validateName(v, 1, 2000, "Message");
}

function validateCompany(v) {
  if (!v || !v.trim()) return null;
  return v.trim().length > 100 ? "Company must not exceed 100 characters" : null;
}

export default function Contact() {
  const [form, setForm] = useState(INITIAL_FORM);
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const contactMutation = useContactForm();

  const updateField = useCallback(
    (field) => (e) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
    },
    []
  );

  const validateForm = useCallback(() => {
    const nextErrors = {
      name: validateName(form.name, 1, 100, "Name"),
      email: validateEmail(form.email),
      company: validateCompany(form.company),
      message: validateMessage(form.message),
    };
    return nextErrors;
  }, [form.name, form.email, form.company, form.message]);

  const handleSubmit = useCallback(
    (e) => {
      e.preventDefault();
      const nextErrors = validateForm();
      setErrors(nextErrors);
      if (Object.values(nextErrors).some(Boolean)) return;

      setSubmitted(false);
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
              setErrors({});
              setSubmitted(true);
            }
          },
        }
      );
    },
    [form, contactMutation, validateForm]
  );

  const isPending = contactMutation.isPending;
  const isError = contactMutation.isError;

  return (
    <section
      id="contact"
      className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8 transition-colors duration-300"
    >
      <div className="mx-auto max-w-5xl">
        <div className="mx-auto max-w-3xl text-center mb-16">
          <span className="mb-6 inline-flex items-center rounded-full border border-brand-500/20 bg-brand-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-brand-700 dark:text-brand-300">
            Start a project
          </span>
          <h2 className="text-3xl font-bold tracking-tight sm:text-5xl text-gradient">
            Tell us your goal, timeline, and must-haves
          </h2>
          <p className="mt-6 text-lg text-[var(--text-muted)] leading-relaxed transition-colors">
            We&apos;ll respond within one business day with next steps and a lightweight plan you
            can review.
          </p>
        </div>

        <div className="grid gap-8 lg:grid-cols-5">
          <form
            onSubmit={handleSubmit}
            noValidate
            className="lg:col-span-3 rounded-[2.5rem] border border-slate-200 dark:border-white/5 bg-[var(--bg-surface)] dark:bg-white/[0.02] p-10 lg:p-12 transition-all duration-300 shadow-sm"
          >
            {/* Honeypot — visually hidden from real users, but present in the DOM/tab order avoidance for bots that skip display:none */}
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                width: "1px",
                height: "1px",
                overflow: "hidden",
                clip: "rect(0 0 0 0)",
                whiteSpace: "nowrap",
              }}
            >
              <label htmlFor="contactCompanyWebsite">Leave this field empty</label>
              <input
                id="contactCompanyWebsite"
                name="_hp"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={form._hp}
                onChange={updateField("_hp")}
              />
            </div>

            <div className="space-y-5">
              <FormInput
                id="contactName"
                label="Name"
                value={form.name}
                onChange={updateField("name")}
                placeholder="Your name"
                error={errors.name}
                disabled={isPending}
                maxLength={100}
                required
                autoComplete="name"
              />

              <FormInput
                id="contactEmail"
                label="Email"
                type="email"
                value={form.email}
                onChange={updateField("email")}
                placeholder="you@company.com"
                error={errors.email}
                disabled={isPending}
                required
                autoComplete="email"
              />

              <FormInput
                id="contactCompany"
                label="Company (optional, 100 characters maximum)"
                value={form.company}
                onChange={updateField("company")}
                placeholder="Your company"
                error={errors.company}
                disabled={isPending}
                maxLength={100}
                autoComplete="organization"
              />

              <div>
                <label
                  htmlFor="contactMessage"
                  className="block text-sm font-medium text-slate-700 dark:text-gray-300 mb-1 transition-colors"
                >
                  Message
                </label>
                <textarea
                  id="contactMessage"
                  value={form.message}
                  onChange={updateField("message")}
                  placeholder="Tell us your goal, timeline, and must-haves"
                  disabled={isPending}
                  maxLength={2000}
                  required
                  rows={5}
                  aria-invalid={errors.message ? true : undefined}
                  aria-describedby={errors.message ? "contactMessage-error" : undefined}
                  className={`w-full rounded-md border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-900/50 px-3 py-2 text-slate-900 dark:text-gray-100 placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500 dark:focus:ring-blue-500 focus:border-brand-500 dark:focus:border-blue-500 transition-all ${isPending ? "opacity-50 cursor-not-allowed" : ""}`}
                />
                {errors.message && (
                  <p id="contactMessage-error" role="alert" className="mt-1 text-xs text-red-400">
                    {errors.message}
                  </p>
                )}
              </div>
            </div>

            <button
              type="submit"
              disabled={isPending}
              className="mt-8 w-full rounded-full bg-brand-500 hover:bg-brand-600
                         text-white font-semibold py-2.5 px-4 shadow-glow
                         transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-brand-400
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPending ? "Sending..." : "Send message"}
            </button>

            {submitted && (
              <p
                role="alert"
                className="mt-4 text-center text-sm font-medium text-brand-600 dark:text-brand-400 transition-colors"
              >
                Thanks — we&apos;ll be in touch.
              </p>
            )}

            {isError && (
              <p
                role="alert"
                className="mt-4 text-center text-sm font-medium text-red-500 dark:text-red-400 transition-colors"
              >
                Something went wrong sending your message. Please email us directly at{" "}
                <a href="mailto:mail@dfwsc.com" className="underline">
                  mail@dfwsc.com
                </a>
                .
              </p>
            )}
          </form>

          <div className="lg:col-span-2 flex flex-col justify-between gap-8 rounded-[2.5rem] border border-slate-200 dark:border-white/5 bg-[var(--bg-surface)] dark:bg-white/[0.02] p-10 transition-all duration-300 hover:bg-slate-100 dark:hover:bg-white/[0.03] shadow-sm">
            <div>
              <h3 className="text-2xl font-bold text-[var(--text-main)] transition-colors">
                Or reach us directly
              </h3>
              <p className="mt-4 text-base text-[var(--text-muted)] leading-relaxed transition-colors">
                Share a Loom, forward requirements, or drop a quick note. We&apos;ll respond with
                next steps and a suggested plan.
              </p>

              <div className="mt-8 p-6 rounded-2xl border border-brand-500/10 bg-brand-500/5 text-sm text-brand-700 dark:text-brand-200/80 leading-relaxed transition-colors">
                <strong className="text-brand-600 dark:text-brand-200 block mb-1 uppercase text-xs tracking-widest transition-colors">
                  Pricing Note:
                </strong>
                Hosting retainers include uptime monitoring, SSL, and maintenance. Feature work is
                billed hourly at $100–$150/hr with clear estimates.
              </div>
            </div>

            <div className="w-full space-y-4">
              {contactMethods.map((method) => (
                <a
                  key={method.label}
                  href={method.href}
                  className="group flex flex-col p-5 rounded-2xl border border-slate-200 dark:border-white/5 bg-[var(--bg-main)] dark:bg-white/[0.02] transition-all duration-300 hover:bg-slate-50 dark:hover:bg-white/[0.08] hover:border-brand-500/30 shadow-sm"
                >
                  <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)] group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors font-bold">
                    {method.label}
                  </span>
                  <span className="mt-2 text-lg font-bold text-[var(--text-main)] group-hover:text-brand-500 dark:group-hover:text-brand-100 transition-colors">
                    {method.value}
                  </span>
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
