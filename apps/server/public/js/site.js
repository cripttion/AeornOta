// Aeron website: keeps old dashboard links working, plus the mobile menu and code tabs.
(function () {
  // Before the website existed, the dashboard lived at "/" with links like /#/approvals.
  function toDashboard() {
    if (location.hash.indexOf("#/") === 0) {
      location.replace("/dashboard" + location.hash);
      return true;
    }
    return false;
  }
  if (toDashboard()) return;
  window.addEventListener("hashchange", toDashboard);

  var toggle = document.querySelector(".nav-toggle");
  var links = document.getElementById("nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    links.addEventListener("click", function (e) {
      if (e.target.closest("a")) {
        links.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  var tabs = document.querySelectorAll(".code-card [data-tab]");
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener("click", function (e) {
      var which = e.currentTarget.getAttribute("data-tab");
      for (var j = 0; j < tabs.length; j++) tabs[j].setAttribute("aria-selected", String(tabs[j] === e.currentTarget));
      var panels = document.querySelectorAll(".code-card [data-panel]");
      for (var k = 0; k < panels.length; k++) panels[k].hidden = panels[k].getAttribute("data-panel") !== which;
    });
  }
})();
