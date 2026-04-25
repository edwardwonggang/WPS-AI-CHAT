import ribbon from "./ribbon";

window.ribbon = ribbon;

const root = document.getElementById("ribbon-root");

if (root) {
  root.innerHTML = [
    "<div style=\"font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif; color: #444; padding: 12px 16px;\">",
    "WPS AI is loaded. Open the assistant from the ribbon.",
    "</div>"
  ].join("");
}
