const form = document.getElementById("login-form");
const input = document.getElementById("password");
const error = document.getElementById("login-error");
const button = form.querySelector("button");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  button.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: input.value }),
    });
    if (res.ok) {
      location.href = "/";
      return;
    }
    let message = res.status === 429 ? "Demasiados intentos. Espera un momento." : `Error ${res.status}`;
    try {
      message = (await res.json()).error || message;
    } catch {}
    showError(message);
  } catch {
    showError("No se pudo conectar con el servidor.");
  } finally {
    button.disabled = false;
  }
});

function showError(message) {
  error.textContent = message;
  error.hidden = false;
  input.select();
}
