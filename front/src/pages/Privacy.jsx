import { useEffect } from "react";
import { usePageTitle } from "../hooks/usePageTitle.js";
import "../styles/studio.css";

// DRAFT copy: owner to review and approve before release.
export default function Privacy() {
  usePageTitle("Privacy");
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);
  return (
    <div className="studio studio-page">
      <section className="studio-page-hero">
        <div className="page-wrap">
          <p className="studio-eyebrow">PRIVACY</p>
          <h1>How we handle your information.</h1>
          <p>Last updated: October 31, 2026</p>
        </div>
      </section>
      <section className="studio-section page-wrap">
        <div className="studio-prose">
          <h2>Who we are</h2>
          <p>
            DFW Software Consulting. You can reach us at{" "}
            <a href="mailto:mail@dfwsc.com">mail@dfwsc.com</a>.
          </p>

          <h2>What the contact form collects</h2>
          <p>When you send us a message, we receive:</p>
          <ul>
            <li>your name, email, company or project, and message;</li>
            <li>
              a little context about your visit: the website you came from (just its domain), the
              first page you opened, any campaign tags in the link you followed, the pages you
              viewed on this site during this visit, and roughly how many seconds you were on the
              site before sending.
            </li>
          </ul>
          <p>
            The visit context is held only in your browser&apos;s memory until you submit the form.
            Nothing is stored on your device for it, and it is gone if you reload or close the page.
            We never record pages that hold private links or sign-in details.
          </p>

          <h2>Why we use it</h2>
          <p>To reply to you and follow up on your inquiry.</p>

          <h2>Where it goes</h2>
          <p>
            Your message goes to our email inbox and to our own self-hosted sales system. Email is
            delivered through our email provider, Resend.
          </p>

          <h2>Analytics</h2>
          <p>
            If enabled, we use Plausible Analytics, a privacy-friendly service that does not use
            cookies.
          </p>

          <h2>Storage on your device</h2>
          <p>
            We keep only your light or dark theme preference in your browser. It stays on your
            device and is never sent to us.
          </p>

          <h2>Payments</h2>
          <p>Client payments are processed by Stripe, and we do not store card details.</p>

          <h2>What we don&apos;t do</h2>
          <p>We don&apos;t sell your data or use it for advertising.</p>

          <h2>How long we keep it</h2>
          <p>
            We keep it as long as needed for our business relationship. Email{" "}
            <a href="mailto:mail@dfwsc.com">mail@dfwsc.com</a> to see or delete your data.
          </p>
        </div>
      </section>
    </div>
  );
}
