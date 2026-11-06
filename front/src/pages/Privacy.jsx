import Disclosure from "../components/Disclosure.jsx";
import PageHero from "../components/PageHero.jsx";
import "../styles/studio.css";

export default function Privacy() {
  return (
    <div className="studio studio-page">
      <PageHero eyebrow="PRIVACY" title="How we handle your information.">
        Last updated: November 5, 2026
      </PageHero>
      <section className="studio-section page-wrap">
        <div className="studio-prose studio-privacy">
          <Disclosure summary={<h2>Who we are</h2>}>
            <p>
              DFW Software Consulting. You can reach us at{" "}
              <a href="mailto:mail@dfwsc.com">mail@dfwsc.com</a>.
            </p>
          </Disclosure>

          <Disclosure summary={<h2>What the contact form collects</h2>}>
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
              The visit context is held only in your browser&apos;s memory until you submit the
              form. Nothing is stored on your device for it, and it is gone if you reload or close
              the page. We never record pages that hold private links or sign-in details.
            </p>
          </Disclosure>

          <Disclosure summary={<h2>How we use it</h2>}>
            <p>To reply to you and follow up on your inquiry.</p>
            <p>Client payments are processed by Stripe, and we do not store card details.</p>
            <p>We don&apos;t sell your data or use it for advertising.</p>
          </Disclosure>

          <Disclosure summary={<h2>Where it goes</h2>}>
            <p>
              Your message goes to our email inbox and to our own self-hosted sales system. Email is
              delivered through our email provider, Resend.
            </p>
          </Disclosure>

          {/* Open by default: the page description promises no analytics or tracking cookies. */}
          <Disclosure summary={<h2>Analytics and cookies</h2>} open>
            <p>
              We don&apos;t use analytics, tracking scripts, or tracking cookies. The visit context
              described above (referrer, campaign tags, and the pages you viewed on this site) is
              kept only in memory in your browser, and it is attached only if you submit the contact
              form.
            </p>
          </Disclosure>

          <Disclosure summary={<h2>Storage on your device</h2>}>
            <p>
              We keep your light or dark theme preference in your browser. It stays on your device
              and is never sent to us.
            </p>
            <p>
              If a page fails to load because we released an update while you had the site open, the
              site reloads once to recover. To avoid reloading in a loop, it notes the time of that
              reload in your browser&apos;s session storage. This short-lived technical flag is just
              a timestamp with no personal data, it is never sent to us, and the browser clears it
              when you close the tab.
            </p>
          </Disclosure>

          <Disclosure summary={<h2>How long we keep it</h2>}>
            <p>
              We keep it as long as needed for our business relationship. Email{" "}
              <a href="mailto:mail@dfwsc.com">mail@dfwsc.com</a> to see or delete your data.
            </p>
          </Disclosure>
        </div>
      </section>
    </div>
  );
}
