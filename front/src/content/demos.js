import barber from "../assets/demos/barber.webp";
import barberTall from "../assets/demos/barber-tall.webp";
import burger from "../assets/demos/burger.webp";
import burgerTall from "../assets/demos/burger-tall.webp";
import landscaping from "../assets/demos/landscaping.webp";
import landscapingTall from "../assets/demos/landscaping-tall.webp";

// Sample sites shown on the unlisted /demos page. Add an entry to add a card.
// `image` is optional: when set (an imported asset URL), the card shows it instead of the icon.
// `scrollImage` is an optional taller capture of the same page; the card scrolls it on hover.
// Previews are 1440x900 screenshots (1200x750 WebP) and the first 3600px of the full page (900x2250).
// `icon` picks the placeholder glyph in pages/Demos.jsx.
export const demos = [
  {
    name: "The Barber Spot",
    industry: "Barbershop",
    description: "Services, barbers and an easy way to book a chair.",
    url: "https://dfw-software-consulting.github.io/barberShop/",
    icon: "scissors",
    image: barber,
    scrollImage: barberTall,
  },
  {
    name: "The Burger Spot",
    industry: "Restaurant",
    description: "A mouth-watering menu, hours and location in one place.",
    url: "https://dfw-software-consulting.github.io/burgerSpot/",
    icon: "utensils",
    image: burger,
    scrollImage: burgerTall,
  },
  {
    name: "DFW Landscaping Co.",
    industry: "Landscaping",
    description: "Lawn and yard services, past projects and a quote request.",
    url: "https://dfw-software-consulting.github.io/landscaping-dfw/",
    icon: "leaf",
    image: landscaping,
    scrollImage: landscapingTall,
  },
];
