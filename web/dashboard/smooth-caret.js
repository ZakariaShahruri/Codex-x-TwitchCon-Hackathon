// Smooth caret (after skiper-ui's skiper106): single-line inputs get a caret that glides to the cursor on a spring instead of
// jumping. The native caret is hidden only once this script runs, so if it fails to load the inputs keep their normal caret.
const SPRING = { stiffness: 500, damping: 30, mass: 0.5 };
const PASSWORD_CHAR = "•";
const MEASURED_STYLES = ["fontStyle", "fontWeight", "fontSize", "fontFamily", "fontFeatureSettings", "fontVariationSettings", "fontKerning", "letterSpacing"];

const inputs = document.querySelectorAll('input:not([type]), input[type="text"], input[type="password"]');
const caret = document.createElement("div");
const measure = document.createElement("span");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
let active = null;
let lastKey = "";
let target = 0;
let x = 0;
let velocity = 0;
let visible = false;
let lastFrame = 0;
let loop = 0;

/** Where the caret belongs, in px from the input's left border edge, and whether it should show at all. */
function locate(input) {
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? 0;
  const key = `${input.value}\u0000${start}:${end}:${input.selectionDirection}:${input.scrollLeft}:${input.clientWidth}:${document.fonts.status}`;
  if (key === lastKey) return;
  lastKey = key;
  const styles = getComputedStyle(input);
  for (const name of MEASURED_STYLES) measure.style[name] = styles[name];
  const index = input.selectionDirection === "backward" ? start : end;
  measure.textContent = input.type === "password" ? PASSWORD_CHAR.repeat(index) : input.value.slice(0, index);
  const left = parseFloat(styles.paddingLeft) || 0;
  const right = input.clientWidth - (parseFloat(styles.paddingRight) || 0);
  const offset = left + measure.getBoundingClientRect().width - input.scrollLeft;
  target = Math.min(offset, right);
  visible = start === end && offset >= left - 1 && offset <= right + 1;
}

function frame(now) {
  loop = 0;
  if (!active) return;
  locate(active);
  const dt = Math.min((now - lastFrame) / 1000 || 1 / 60, 1 / 30);
  lastFrame = now;
  if (reduceMotion.matches) {
    x = target;
    velocity = 0;
  } else {
    velocity += ((-SPRING.stiffness * (x - target) - SPRING.damping * velocity) / SPRING.mass) * dt;
    x += velocity * dt;
  }
  const rect = active.getBoundingClientRect();
  const height = parseFloat(getComputedStyle(active).fontSize) * 1.15;
  caret.style.height = `${height}px`;
  caret.style.transform = `translate(${rect.left + active.clientLeft + x - 1}px, ${rect.top + (rect.height - height) / 2}px)`;
  caret.style.opacity = visible ? "1" : "0";
  loop = requestAnimationFrame(frame);
}

if (inputs.length) {
  caret.className = "smooth-caret";
  measure.className = "smooth-caret-measure";
  caret.setAttribute("aria-hidden", "true");
  measure.setAttribute("aria-hidden", "true");
  document.body.append(caret, measure);
  for (const input of inputs) {
    input.classList.add("has-smooth-caret");
    input.addEventListener("focus", () => {
      active = input;
      lastKey = "";
      locate(input);
      x = target; // Appear at the cursor; only movement within the field glides.
      velocity = 0;
      if (!loop) {
        lastFrame = performance.now();
        loop = requestAnimationFrame(frame);
      }
    });
    input.addEventListener("blur", () => {
      if (active !== input) return;
      active = null;
      caret.style.opacity = "0";
    });
  }
}
