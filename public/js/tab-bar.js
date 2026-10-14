// Bottom tab bar shared by every signed-in page: each includes
// <script type="module" src="js/tab-bar.js"> and this injects the bar
// (styles: .tabbar in theme.css). The active tab comes from the page's own
// path — with or without ".html", since hosting has cleanUrls on — and a
// page reached from a tab lights that tab (advice → Program, groups → Today).

// 24×24 line icons, stroked in the link's colour (see .tabbar svg).
const TABS = [
  { href: "dashboard.html", label: "Today", pages: ["dashboard", "groups"],
    icon: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z"/>' },
  { href: "program.html", label: "Program", pages: ["program", "advice"],
    icon: '<path d="M8 12h8M3 12h2M19 12h2"/><rect x="5" y="7" width="3" height="10" rx="1"/><rect x="16" y="7" width="3" height="10" rx="1"/>' },
  { href: "meals.html", label: "Meals", pages: ["meals"],
    icon: '<path d="M3 11h18a9 9 0 0 1-18 0Z"/><path d="M10 3.5c-1 1 1 2 0 4M14 3.5c-1 1 1 2 0 4"/>' },
  { href: "checkin.html", label: "Check-in", pages: ["checkin"],
    icon: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 13l2 2 4-4"/>' },
  { href: "profile.html", label: "Profile", pages: ["profile"],
    icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>' },
];

const page = location.pathname.split("/").pop().replace(/\.html$/, "");

const nav = document.createElement("nav");
nav.className = "tabbar";
nav.setAttribute("aria-label", "Main");
nav.innerHTML = TABS.map((tab) => `
  <a href="${tab.href}"${tab.pages.includes(page) ? ' aria-current="page"' : ""}>
    <svg viewBox="0 0 24 24" aria-hidden="true">${tab.icon}</svg>${tab.label}
  </a>`).join("");
document.body.append(nav);
// Reserves room for the bar at the bottom of the page (see .has-tabbar).
document.body.classList.add("has-tabbar");
