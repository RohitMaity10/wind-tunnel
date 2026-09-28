const canvas = document.getElementById("tunnel-canvas");
const ctx = canvas.getContext("2d");

const speedSlider = document.getElementById("speed-slider");
const speedBadge = document.getElementById("speed-badge");
const speedReadout = document.getElementById("speed-readout");
const reReadout = document.getElementById("re-readout");
const particleReadout = document.getElementById("particle-readout");
const aoaSlider = document.getElementById("aoa-slider");
const aoaBadge = document.getElementById("aoa-badge");
const presetButtons = document.querySelectorAll(".preset-btn");
const modeButtons = document.querySelectorAll(".mode-btn");
const clearBtn = document.getElementById("clear-custom-btn");

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  initSmokeStreamers();
}
window.addEventListener("resize", resize);

// Simulation State
let airSpeed = 45; // m/s
let angleOfAttack = 6 * (Math.PI / 180); // Radians
let currentPreset = "airfoil";
let currentMode = "smoke"; // 'smoke', 'vectors', 'pressure'
let obstaclePos = { x: window.innerWidth * 0.38, y: window.innerHeight * 0.5 };
let isDraggingObstacle = false;
let customDrawnPoints = [];
let isDrawing = false;

// Smoke Ribbon Streamer System
const NUM_STREAMS = 65;
const PARTICLES_PER_STREAM = 38;
let particles = [];

class StreamParticle {
  constructor(laneY, offsetX = 0) {
    this.laneY = laneY;
    this.x = offsetX;
    this.y = laneY;
    this.vx = airSpeed * 0.15;
    this.vy = 0;
    this.history = [];
    this.maxHistory = 14;
    this.pressure = 0;
  }

  reset() {
    this.x = 0;
    this.y = this.laneY + (Math.random() - 0.5) * 4;
    this.vx = airSpeed * 0.15;
    this.vy = 0;
    this.history = [];
    this.pressure = 0;
  }

  update(field) {
    this.history.push({ x: this.x, y: this.y, p: this.pressure });
    if (this.history.length > this.maxHistory) this.history.shift();

    // Query aerodynamic flow field velocity at current coordinates
    const flow = getFlowVelocity(this.x, this.y);
    this.vx = flow.u;
    this.vy = flow.v;
    this.pressure = flow.p;

    this.x += this.vx;
    this.y += this.vy;

    // Boundary Wrap / Reset
    if (this.x > canvas.width + 20 || this.y < -30 || this.y > canvas.height + 30) {
      this.reset();
    }
  }

  draw() {
    if (this.history.length < 2) return;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(this.history[0].x, this.history[0].y);
    for (let i = 1; i < this.history.length; i++) {
      ctx.lineTo(this.history[i].x, this.history[i].y);
    }

    if (currentMode === "smoke") {
      // Neon cyan streamers with blue turbulent dissipation
      const speedMag = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
      const intensity = Math.min(1.0, speedMag / 12);
      ctx.strokeStyle = `rgba(56, 189, 248, ${0.35 + intensity * 0.45})`;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = "#38bdf8";
      ctx.shadowBlur = 6;
      ctx.stroke();
    } else if (currentMode === "pressure") {
      // High pressure = Amber/Red, Low pressure (suction) = Violet/Cyan
      const pColor = this.pressure > 0.4 ? "#f43f5e" : this.pressure < -0.3 ? "#38bdf8" : "#10b981";
      ctx.strokeStyle = pColor;
      ctx.lineWidth = 2.0;
      ctx.stroke();
    }
    ctx.restore();
  }
}

function initSmokeStreamers() {
  particles = [];
  const spacing = canvas.height / NUM_STREAMS;
  for (let i = 0; i < NUM_STREAMS; i++) {
    const laneY = i * spacing + spacing * 0.5;
    for (let j = 0; j < PARTICLES_PER_STREAM; j++) {
      const p = new StreamParticle(laneY, (j / PARTICLES_PER_STREAM) * canvas.width);
      particles.push(p);
    }
  }
  particleReadout.textContent = particles.length.toLocaleString();
}
initSmokeStreamers();

// Potential Flow & Navier-Stokes Vortex Street Analytical Approximation
let vortexTime = 0;

function getFlowVelocity(x, y) {
  const baseU = airSpeed * 0.15;
  let u = baseU;
  let v = 0;
  let p = 0; // Relative pressure

  const ox = obstaclePos.x;
  const oy = obstaclePos.y;
  const dx = x - ox;
  const dy = y - oy;

  // Custom User-Drawn Obstacles
  if (customDrawnPoints.length > 2) {
    for (let pt of customDrawnPoints) {
      const d = Math.hypot(x - pt.x, y - pt.y);
      if (d < 30) {
        const nx = (x - pt.x) / (d || 1);
        const ny = (y - pt.y) / (d || 1);
        u += nx * baseU * 1.5;
        v += ny * baseU * 1.5;
        p = 1.0 - (d / 30);
      }
    }
    return { u, v, p };
  }

  // Presets Flow Solutions
  if (currentPreset === "cylinder") {
    const R = 55; // Cylinder radius
    const rSq = dx * dx + dy * dy;
    const r = Math.sqrt(rSq);

    if (r < R) {
      // Inside obstacle
      return { u: 0.1, v: 0, p: 1.0 };
    }

    // Dipole Potential Flow around Cylinder
    const theta = Math.atan2(dy, dx);
    const R_r = (R * R) / (rSq);
    u = baseU * (1.0 - R_r * Math.cos(2 * theta));
    v = -baseU * R_r * Math.sin(2 * theta);

    // von Kármán Vortex Shedding in the wake (x > ox)
    if (dx > R && Math.abs(dy) < R * 2.8) {
      const wakeX = (dx - R) * 0.035;
      const strouhal = 0.22; // Strouhal frequency
      const freq = vortexTime * strouhal;
      const vortexY = Math.sin(freq - wakeX * 2.5) * 16 * Math.exp(-wakeX * 0.1);
      v += vortexY * (dx / 140);
      u *= 0.65; // Wake deficit
    }
    p = 1.0 - (u * u + v * v) / (baseU * baseU);
  }
  else if (currentPreset === "airfoil") {
    // NACA Joukowsky Airfoil Transformation Model
    const chord = 160;
    // Rotate relative to Angle of Attack
    const rx = dx * Math.cos(-angleOfAttack) - dy * Math.sin(-angleOfAttack);
    const ry = dx * Math.sin(-angleOfAttack) + dy * Math.cos(-angleOfAttack);

    const distChord = rx / chord;
    if (distChord >= -0.5 && distChord <= 0.5) {
      const thickness = 0.2 * 5 * chord * (0.2969 * Math.sqrt(distChord + 0.5) - 0.126 * (distChord + 0.5));
      if (Math.abs(ry) < Math.max(8, thickness)) {
        return { u: 0.1, v: 0, p: 0.9 };
      }
    }

    const dist = Math.hypot(dx, dy) || 1;
    // Lift Circulation (Kutta Condition Vortex)
    const gamma = baseU * chord * Math.sin(angleOfAttack) * 4.2;
    const circU = (gamma / (2 * Math.PI * dist)) * (dy / dist);
    const circV = -(gamma / (2 * Math.PI * dist)) * (dx / dist);

    // Deflection around body
    const defl = Math.exp(-dist / 85);
    u += circU * defl;
    v += circV * defl - Math.sin(angleOfAttack) * baseU * defl * 0.8;

    p = -circU * 0.15;
  }
  else if (currentPreset === "car") {
    // High drag blunt body aerodynamics
    if (dx > -90 && dx < 90 && dy > -35 && dy < 35) {
      return { u: 0.1, v: 0, p: 0.9 };
    }
    const dist = Math.hypot(dx, dy) || 1;
    const defl = Math.exp(-dist / 80);
    if (dx < -60) p = 0.8 * defl; // Stagnation zone
    if (dx > 70 && Math.abs(dy) < 55) {
      // Turbulent suction wake
      v += Math.sin(vortexTime * 3 + dx * 0.1) * 8;
      u *= 0.5;
      p = -0.6;
    }
  }
  else if (currentPreset === "plate") {
    // Perpendicular flat plate
    if (Math.abs(dx) < 10 && Math.abs(dy) < 70) {
      return { u: 0.05, v: 0, p: 1.0 };
    }
    const dist = Math.hypot(dx, dy) || 1;
    const defl = Math.exp(-dist / 90);
    if (dx < 0) {
      u += (dx / dist) * baseU * defl;
      v += (dy / dist) * baseU * defl * 1.5;
    } else {
      // Violent detachment vortex street
      v += Math.cos(vortexTime * 2.2 + dx * 0.05) * 14 * defl;
      u *= 0.4;
      p = -0.7;
    }
  }

  return { u, v, p };
}

// Render Physical Obstacles
function renderObstacle() {
  ctx.save();
  ctx.translate(obstaclePos.x, obstaclePos.y);

  if (customDrawnPoints.length > 2) {
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = "#38bdf8";
    ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(customDrawnPoints[0].x, customDrawnPoints[0].y);
    for (let p of customDrawnPoints) ctx.lineTo(p.x, p.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    return;
  }

  ctx.fillStyle = "#0f172a";
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 3;
  ctx.shadowColor = "#38bdf8";
  ctx.shadowBlur = 14;

  if (currentPreset === "cylinder") {
    ctx.beginPath();
    ctx.arc(0, 0, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  else if (currentPreset === "airfoil") {
    ctx.rotate(angleOfAttack);
    ctx.beginPath();
    ctx.moveTo(-80, 0);
    ctx.bezierCurveTo(-50, -42, 30, -32, 80, 0);
    ctx.bezierCurveTo(30, 14, -40, 18, -80, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Center of pressure marker
    ctx.fillStyle = "#f43f5e";
    ctx.beginPath();
    ctx.arc(-20, 0, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  else if (currentPreset === "car") {
    ctx.beginPath();
    ctx.roundRect(-85, -28, 170, 56, [14, 28, 4, 4]);
    ctx.fill();
    ctx.stroke();
  }
  else if (currentPreset === "plate") {
    ctx.beginPath();
    ctx.roundRect(-8, -65, 16, 130, 4);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

// Render Flow Field Vector Arrows
function renderVectorField() {
  ctx.save();
  ctx.strokeStyle = "rgba(56, 189, 248, 0.28)";
  ctx.lineWidth = 1.2;
  const step = 42;

  for (let x = 40; x < canvas.width; x += step) {
    for (let y = 40; y < canvas.height; y += step) {
      const flow = getFlowVelocity(x, y);
      const mag = Math.hypot(flow.u, flow.v) || 1;
      const len = Math.min(24, mag * 2.6);

      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (flow.u / mag) * len, y + (flow.v / mag) * len);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Main Animation Loop
function animate() {
  vortexTime += 0.05 * (airSpeed / 45);

  ctx.fillStyle = "rgba(3, 7, 18, 0.32)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (currentMode === "vectors") {
    renderVectorField();
  }

  // Update & Draw Smoke Streamers
  for (let p of particles) {
    p.update();
    p.draw();
  }

  renderObstacle();

  requestAnimationFrame(animate);
}
animate();

// Pointer Interaction: Drag Obstacle or Draw Custom Shapes
canvas.addEventListener("mousedown", (e) => {
  if (e.target.closest(".control-deck, .hud-top")) return;
  const d = Math.hypot(e.clientX - obstaclePos.x, e.clientY - obstaclePos.y);

  if (d < 75 && customDrawnPoints.length === 0) {
    isDraggingObstacle = true;
  } else {
    isDrawing = true;
    customDrawnPoints = [{ x: e.clientX, y: e.clientY }];
  }
});

window.addEventListener("mousemove", (e) => {
  if (isDraggingObstacle) {
    obstaclePos.x = e.clientX;
    obstaclePos.y = e.clientY;
  } else if (isDrawing) {
    customDrawnPoints.push({ x: e.clientX, y: e.clientY });
  }
});

window.addEventListener("mouseup", () => {
  isDraggingObstacle = false;
  isDrawing = false;
});

// Touch Support for Mobile
canvas.addEventListener("touchstart", (e) => {
  if (e.touches.length === 1) {
    const t = e.touches[0];
    const d = Math.hypot(t.clientX - obstaclePos.x, t.clientY - obstaclePos.y);
    if (d < 75 && customDrawnPoints.length === 0) {
      isDraggingObstacle = true;
    }
  }
});

window.addEventListener("touchmove", (e) => {
  if (isDraggingObstacle && e.touches.length === 1) {
    obstaclePos.x = e.touches[0].clientX;
    obstaclePos.y = e.touches[0].clientY;
  }
});

window.addEventListener("touchend", () => isDraggingObstacle = false);

// UI Listeners
speedSlider.addEventListener("input", (e) => {
  airSpeed = parseInt(e.target.value);
  speedBadge.textContent = `${airSpeed} m/s`;
  speedReadout.textContent = `${airSpeed} m/s`;
  const reynolds = Math.floor(airSpeed * 275);
  reReadout.textContent = `Re ${reynolds.toLocaleString()}`;
});

aoaSlider.addEventListener("input", (e) => {
  const deg = parseInt(e.target.value);
  angleOfAttack = deg * (Math.PI / 180);
  aoaBadge.textContent = `${deg}°`;
});

presetButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    presetButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentPreset = btn.dataset.preset;
    customDrawnPoints = [];
  });
});

modeButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    modeButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentMode = btn.dataset.mode;
  });
});

clearBtn.addEventListener("click", () => {
  customDrawnPoints = [];
  obstaclePos = { x: canvas.width * 0.38, y: canvas.height * 0.5 };
});