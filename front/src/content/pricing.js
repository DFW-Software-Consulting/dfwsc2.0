export const hostingPlans = [
  {
    name: "Basic Hosting",
    price: "$40",
    includes: "Hosting + uptime monitoring, minor edits, payment setup",
    idealFor: "Business websites and landing pages",
    specs: [
      ["Website & file storage", "5 GB"],
      ["Monthly data transfer", "100 GB"],
      ["Database storage", "Not included"],
      ["Application backend", "Not included"],
      ["Maintenance retainer", "Included"],
      ["Support", "Standard"],
    ],
  },
  {
    name: "Pro Hosting",
    price: "$100",
    includes:
      "Multi-page site hosting, domain management, maintenance, backups, backend API hosting, and database storage — we keep it running so you don't have to",
    idealFor: "Custom applications and client portals",
    specs: [
      ["Website & file storage", "10 GB"],
      ["Monthly data transfer", "500 GB"],
      ["Database storage", "1 GB"],
      ["Application backend", "Included"],
      ["Maintenance retainer", "Included"],
      ["Support", "Standard"],
    ],
  },
  {
    name: "Business Hosting",
    price: "$200",
    includes:
      "Application hosting, maintenance, backups, monthly performance review, and priority support for businesses with more demanding storage and processing needs",
    idealFor: "Businesses with larger applications and data needs",
    specs: [
      ["Website & file storage", "25 GB"],
      ["Monthly data transfer", "1 TB"],
      ["Database storage", "5 GB"],
      ["Application backend", "Included"],
      ["Maintenance retainer", "Included"],
      ["Support", "Priority"],
    ],
  },
];

export const retainer = {
  name: "Dev Retainer",
  price: "Custom",
  includes: "Ongoing dev team, new features, priority support, and dedicated engineering hours",
};

export const faqItems = [
  {
    question: "What do storage and monthly data transfer mean?",
    answer:
      "Storage is the space used by your website and uploaded files. Database storage is listed separately for application records. Monthly data transfer is the amount of data delivered to visitors, including pages, images, and downloads. It resets each billing month and is not a visitor limit.",
  },
  {
    question: "What happens if my business needs more capacity?",
    answer:
      "Your hosting proposal will specify your included allowances and how additional usage is billed. More storage, data transfer, or application processing may require additional infrastructure charges or a different plan. Email, video delivery, third-party services, and AI usage are scoped separately.",
  },
  {
    question: "Does hosting include building my website?",
    answer:
      "A new website or application is quoted separately. The monthly hosting price includes a maintenance retainer for repairs and fixes to existing functionality, within the scope agreed in your proposal. New features and larger changes are estimated separately.",
  },
  {
    question: "How do we decide the project price?",
    answer:
      "We start with your goals, required features, and current tools. A discovery conversation helps us define the scope, estimate the work, and explain the proposed costs.",
  },
  {
    question: "Can you work with a website or application we already have?",
    answer:
      "Tell us what you’re using and where you need help. We’ll review the setup with you before recommending improvements or a migration path.",
  },
  {
    question: "Can we keep working together after launch?",
    answer:
      "Yes. Every hosting plan includes a maintenance retainer for agreed repairs and fixes. If you need ongoing new features or dedicated development hours, we can discuss a separate development retainer.",
  },
];
