import { useEffect } from "react";
import { Link } from "react-router-dom";
import DiegoImage from "../assets/diego.jpg";
import HectorImage from "../assets/hector.webp";
import JcImage from "../assets/jc.jpg";
import "./StudioHome.css";
import "./StudioPages.css";

const teamMembers = [
  {
    name: "Jeremy Ashley",
    role: "Founder & CTO",
    bio: "Drives technical strategy and architecture across the organization. Oversees full-stack product delivery, DevOps automation, and scalable cloud infrastructure design.",
    image: JcImage,
  },
  {
    name: "Diego Espino",
    role: "Full Stack & DevOps Engineer",
    bio: "Bridges front-end experience with backend reliability. Focused on TypeScript & Python ecosystems, CI/CD pipelines, and performance-driven web applications that scale.",
    image: DiegoImage,
  },
  {
    name: "Hector Oropesa",
    role: "Full Stack Developer • DevOps & Network Engineer",
    bio: "Combines full-stack development with deep IT and network engineering experience. Bridges software, systems, and networking by managing cloud environments, hardening systems, and supporting scalable, reliable deployments across DevOps workflows.",
    image: HectorImage,
  },
];

export default function Team() {
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);
  return (
    <div className="studio studio-page">
      <section className="studio-page-hero studio-team-hero">
        <div className="studio-wrap">
          <p className="studio-eyebrow">SMALL TEAM. DIRECT CONNECTION.</p>
          <h1>
            Good software.
            <br />
            <em>Real people.</em>
          </h1>
          <p>
            We’re the people who turn your business challenges into a plan, a working application,
            and the support to keep improving.
          </p>
          <div className="studio-actions">
            <a className="studio-button" href="#people">
              Meet your team <span aria-hidden="true">↓</span>
            </a>
            <Link className="studio-text-link" to="/" state={{ scrollTo: "contact" }}>
              Tell us about your business <span aria-hidden="true">↗</span>
            </Link>
          </div>
          <div className="studio-team-hero-note">
            Dallas–Fort Worth based · Working remotely with businesses across the US
          </div>
        </div>
      </section>
      <section id="people" className="studio-section studio-wrap">
        <div className="studio-section-heading">
          <div>
            <p className="studio-eyebrow">THE PEOPLE BEHIND THE WORK</p>
            <h2>
              Meet your
              <br />
              <em>development team.</em>
            </h2>
          </div>
          <p>
            Business understanding, application development, and the systems behind it—all part of
            the same conversation.
          </p>
        </div>
        <div className="studio-member-list">
          {teamMembers.map((member, index) => (
            <article className="studio-member" key={member.name}>
              <div className="studio-member-photo">
                <img src={member.image} alt={member.name} loading="lazy" />
                <span>0{index + 1} / DFWSC</span>
              </div>
              <div className="studio-member-copy">
                <p className="studio-mini-label">{member.role}</p>
                <h3>{member.name}</h3>
                <p className="studio-member-intro">
                  {
                    [
                      "Your partner in figuring out what to build—and why.",
                      "Turning the plan into software your team can use.",
                      "Bringing your software, systems, and infrastructure together.",
                    ][index]
                  }
                </p>
                <p>{member.bio}</p>
                <div className="studio-member-focus">
                  <span>FOCUS</span>
                  <p>
                    {
                      [
                        "Discovery · Technical direction · Full-stack delivery",
                        "Application development · Deployment · Performance",
                        "Application development · Cloud systems · Networking",
                      ][index]
                    }
                  </p>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="studio-process">
        <div className="studio-wrap">
          <div className="studio-section-heading">
            <div>
              <p className="studio-eyebrow">HOW WE WORK WITH YOU</p>
              <h2>
                A shared goal.
                <br />
                <em>A clear way forward.</em>
              </h2>
            </div>
            <p>
              You bring the knowledge of your business. We bring the technical perspective and
              explain the choices along the way.
            </p>
          </div>
          <div className="studio-process-grid">
            {[
              [
                "01",
                "A conversation first.",
                "We learn how your team works, what’s getting in the way, and what a useful outcome looks like.",
              ],
              [
                "02",
                "Progress you can see.",
                "Early previews and regular check-ins let you give feedback while the solution is taking shape.",
              ],
              [
                "03",
                "A plan for what’s next.",
                "We discuss ongoing support and handoff options so you know how the work will be maintained.",
              ],
            ].map(([number, title, copy]) => (
              <article key={number}>
                <span>{number}</span>
                <h3>{title}</h3>
                <p>{copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
      <section className="studio-contact">
        <div className="studio-wrap">
          <p className="studio-eyebrow">YOUR NEXT PROJECT STARTS WITH A CONVERSATION</p>
          <h2>
            Let’s put a team
            <br />
            <em>behind your idea.</em>
          </h2>
          <p>
            Whether you have a detailed plan or a problem you’re still sorting out, tell us where
            you’d like to go.
          </p>
          <div className="studio-actions">
            <Link className="studio-button" to="/" state={{ scrollTo: "contact" }}>
              Talk about your project <span aria-hidden="true">↗</span>
            </Link>
            <Link className="studio-text-link" to="/pricing">
              Explore ways to work together <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
