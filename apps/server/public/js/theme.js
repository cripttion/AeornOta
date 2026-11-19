// Runs before first paint: apply the viewer's saved theme ("light" | "dark"; absent = follow the system).
(function () {
  try {
    var t = localStorage.getItem("aeron.theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    /* storage blocked: follow the system */
  }
})();
