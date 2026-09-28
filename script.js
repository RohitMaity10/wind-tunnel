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
  obstacle.x = canvas.width * 0.38;
  obstacle.y = canvas.height * 0.5;
  initStreamlines();
}
window.addEventListener("resize", resize);

// Global Aerodynamic State
let airSpeed = 45; // m/s
let angleDeg = 6;
let angleRad = 6 * (Math.PI / 180);
let currentPreset = "airfoil"; // 'airfoil', 'cylinder', 'car', 'plate'
let currentMode = "smoke"; // 'smoke', 'vectors', 'pressure'

// Obstacle Definition
const obstacle = {
  x: window.innerWidth * 0.38,
  y: window.innerHeight * 0.5,
  isDragging: false,
  radius: 65, // for cylinder
  chord: 180, // for airfoil
  carW: 190,
  carH: 64
};

// Smoke Particle System
const NUM_STREAMS = 52;
const PARTICLES_PER_STREAM = 24;
let particles = [];
let vortexPhase = 0;

class SmokeParticle {
  constructor(laneY, initialX = 0) {
    this.laneY = laneY;
    this.x = initialX;
    this.y = laneY;
    this.vx = airSpeed * 0.12;
    this.vy = 0;
    this.history = [];
    this.maxHistory = 16;
    this.speed = 0;
    this.pressure = 0;
  }

  reset() {
    this.x = -Math.random() * 20;
    this.y = this.laneY + (Math.random() - 0.5) * 3;
    this.vx = airSpeed * 0.12;
    this.vy = 0;
    this.history = [];
    this.speed = this.vx;
    this.pressure = 0;
  }

  update() {
    // Record past positions for smooth trailing ribbons
    this.history.push({ x: this.x, y: this.y, speed: this.speed, p: this.pressure });
    if (this.history.length > this.maxHistory) this.history.shift();

    // Base uniform wind flow from left to right
    const baseVx = airSpeed * 0.12;
    let targetVx = baseVx;
    let targetVy = 0;

    // Obstacle Center Reference
    const ox = obstacle.x;
    const oy = obstacle.y;
    const dx = this.x - ox;
    const dy = this.y - oy;
    const dist = Math.hypot(dx, dy) || 1;

    // Aerodynamic Deflection Modeling
    if (currentPreset === "cylinder") {
      const R = obstacle.radius;
      if (dist < R * 3.2) {
        // Potential flow around circular cylinder: v_r = U(1 - R^2/r^2)cos(theta), v_theta = -U(1 + R^2/r^2)sin(theta)
        const factor = (R * R) / (dist * dist);
        const theta = Math.atan2(dy, dx);
        targetVx = baseVx * (1 - factor * Math.cos(2 * theta));
        targetVy = -baseVx * factor * Math.sin(2 * theta);

        // von Kármán Vortex Shedding in the wake behind the cylinder
        if (dx > R * 0.5) {
          const wakeFactor = Math.min(1.0, (dx - R * 0.5) / 180);
          const swirl = Math.sin(vortexPhase * 2 - dx * 0.035) * (R * 0.35) * wakeFactor;
          targetVy += swirl;
          targetVx *= 0.72; // Wake velocity deficit
        }
      }

      // Hard Boundary Separation: Push outside surface if encroaching
      if (dist < R + 3) {
        const nx = dx / dist;
        const ny = dy / dist;
        this.x = ox + nx * (R + 4);
        this.y = oy + ny * (R + 4);
        // Slide tangentially along circle
        const tx = -ny;
        const ty = nx;
        const dot = targetVx * tx + targetVy * ty;
        targetVx = tx * Math.abs(dot);
        targetVy = ty * (dy > 0 ? Math.abs(dot) : -Math.abs(dot));
      }
    }
    else if (currentPreset === "airfoil") {
      const chord = obstacle.chord;
      // Coordinate transform to airfoil body frame
      const cosA = Math.cos(-angleRad);
      const sinA = Math.sin(-angleRad);
      const bx = dx * cosA - dy * sinA;
      const by = dx * sinA + dy * cosA;

      // Airfoil thickness profile approximation (NACA 0015 modified)
      const xNorm = (bx + chord * 0.45) / chord;
      let halfThick = 0;
      if (xNorm >= 0 && xNorm <= 1) {
        halfThick = 18 * Math.sin(xNorm * Math.PI) * (1.1 - 0.5 * xNorm);
      }

      // Circulation / Lift: Fluid flows faster over upper surface (Bernoulli suction)
      if (Math.abs(dx) < chord * 1.4 && Math.abs(dy) < chord * 0.9) {
        const upwashDist = Math.hypot(bx + chord * 0.5, by);
        const deflection = Math.exp(-upwashDist / 120);

        // Leading edge upwash & downwash trail
        targetVy -= Math.sin(angleRad) * baseVx * 0.85 * deflection;

        if (by < 0) {
          // Top surface acceleration (Low pressure / Lift zone)
          targetVx *= 1.0 + 0.55 * Math.sin(Math.max(0, Math.min(1, xNorm)) * Math.PI) * Math.cos(angleRad);
        } else {
          // Bottom surface deceleration (High pressure)
          targetVx *= 1.0 - 0.25 * deflection;
        }

        // Wake deflection angle
        if (bx > chord * 0.45) {
          targetVy += Math.sin(angleRad) * baseVx * 0.45;
        }
      }

      // Airfoil Solid Body Collision Envelope
      if (xNorm >= 0 && xNorm <= 1 && Math.abs(by) < halfThick + 4) {
        const pushY = by > 0 ? (halfThick + 5) : -(halfThick + 5);
        // Transform pushed body position back to world
        const wdx = bx * cosA + pushY * (-sinA);
        const wdy = bx * sinA + pushY * cosA;
        this.x = ox + wdx;
        this.y = oy + wdy;

        // Tangent flow along wing profile
        targetVx = Math.cos(angleRad) * baseVx * (by < 0 ? 1.35 : 0.85);
        targetVy = Math.sin(angleRad) * baseVx * (by < 0 ? 1.35 : 0.85);
      }
    }
    else if (currentPreset === "car") {
      // Sports car silhouette
      const hw = obstacle.carW * 0.5;
      const hh = obstacle.carH * 0.5;

      if (dx > -hw - 40 && dx < hw + 180 && dy > -hh - 40 && dy < hh + 20) {
        // Windshield and roof flow deflection
        if (dx < 0 && dy < 0) {
          targetVy -= baseVx * 0.45;
          targetVx *= 1.1;
        }
        // Rear diffuser / spoiler suction wake
        if (dx > hw) {
          const wakeFactor = Math.min(1.0, (dx - hw) / 140);
          targetVy += Math.sin(vortexPhase * 2.5 + dx * 0.05) * 8 * wakeFactor;
          targetVx *= 0.65;
        }
      }

      // Car Solid Collision Box
      if (dx > -hw && dx < hw && dy > -hh && dy < hh) {
        if (Math.abs(dx / hw) > Math.abs(dy / hh)) {
          this.x = ox + (dx > 0 ? hw + 4 : -hw - 4);
        } else {
          this.y = oy + (dy > 0 ? hh + 4 : -hh - 4);
        }
        targetVx = baseVx * 0.8;
      }
    }
    else if (currentPreset === "plate") {
      // Flat Plate (Bluff body high drag)
      const pHalfH = 65;
      if (Math.abs(dx) < 60 && Math.abs(dy) < pHalfH + 40) {
        if (dx < 0) {
          // Stagnation pushing out up and down
          targetVx *= 0.25;
          targetVy += (dy > 0 ? 1 : -1) * baseVx * 0.75;
        } else {
          // Massive turbulent separated recirculation zone
          targetVx *= 0.35;
          targetVy += Math.cos(vortexPhase * 1.8 + dx * 0.05) * 16;
        }
      }

      // Solid Collision for Plate
      if (Math.abs(dx) < 8 && Math.abs(dy) < pHalfH + 4) {
        this.x = ox + (dx > 0 ? 10 : -10);
        targetVy = (dy > 0 ? 1 : -1) * baseVx * 0.9;
        targetVx = baseVx * 0.1;
      }
    }

    // Velocity update with smooth acceleration
    this.vx += (targetVx - this.vx) * 0.28;
    this.vy += (targetVy - this.vy) * 0.28;

    this.x += this.vx;
    this.y += this.vy;

    // Relative Bernoulli Pressure Calculation: P ~ 1 - (V / V0)^2
    this.speed = Math.hypot(this.vx, this.vy);
    this.pressure = (1.0 - Math.pow(this.speed / baseVx, 2)) * 0.5;

    // Reset when exiting right edge or boundary
    if (this.x > canvas.width + 30 || this.y < -40 || this.y > canvas.height + 40) {
      this.reset();
    }
  }

  draw() {
    if (this.history.length < 2) return;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.beginPath();
    ctx.moveTo(this.history[0].x, this.history[0].y);
    for (let i = 1; i < this.history.length; i++) {
      ctx.lineTo(this.history[i].x, this.history[i].y);
    }

    if (currentMode === "smoke") {
      // Clean, bright neon cyan filaments with soft glow
      const normalizedSpeed = Math.min(2.0, this.speed / (airSpeed * 0.12));
      const alpha = 0.35 + normalizedSpeed * 0.3;
      ctx.strokeStyle = `rgba(56, 189, 248, ${Math.min(0.9, alpha)})`;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = "#38bdf8";
      ctx.shadowBlur = 4;
      ctx.stroke();
    } else if (currentMode === "pressure") {
      // Red = High pressure / Stagnation, Blue/Cyan = Suction / Lift
      let pColor = "#38bdf8";
      if (this.pressure > 0.2) pColor = "#f43f5e";
      else if (this.pressure > 0.05) pColor = "#fbbf24";
      else if (this.pressure < -0.2) pColor = "#a855f7";

      ctx.strokeStyle = pColor;
      ctx.lineWidth = 2.0;
      ctx.stroke();
    }

    ctx.restore();
  }
}

function initStreamlines() {
  particles = [];
  const spacing = canvas.height / NUM_STREAMS;
  for (let i = 0; i < NUM_STREAMS; i++) {
    const laneY = i * spacing + spacing * 0.5;
    for (let j = 0; j < PARTICLES_PER_STREAM; j++) {
      const p = new SmokeParticle(laneY, (j / PARTICLES_PER_STREAM) * canvas.width);
      particles.push(p);
    }
  }
  particleReadout.textContent = particles.length.toLocaleString();
}
initStreamlines();

// Draw Obstacle Solid Meshes
function renderObstacle() {
  ctx.save();
  ctx.translate(obstacle.x, obstacle.y);

  ctx.fillStyle = "#090d16";
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 2.5;
  ctx.shadowColor = "#38bdf8";
  ctx.shadowBlur = 12;

  if (currentPreset === "cylinder") {
    ctx.beginPath();
    ctx.arc(0, 0, obstacle.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Center pivot indicator
    ctx.fillStyle = "#38bdf8";
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  else if (currentPreset === "airfoil") {
    ctx.rotate(angleRad);
    const chord = obstacle.chord;

    ctx.beginPath();
    // Aerodynamic Teardrop / NACA profile
    ctx.moveTo(-chord * 0.45, 0);
    ctx.bezierCurveTo(-chord * 0.35, -28, chord * 0.15, -20, chord * 0.55, 0);
    ctx.bezierCurveTo(chord * 0.2, 14, -chord * 0.25, 16, -chord * 0.45, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Chord line & Quarter-chord aerodynamic center
    ctx.strokeStyle = "rgba(56, 189, 248, 0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-chord * 0.45, 0);
    ctx.lineTo(chord * 0.55, 0);
    ctx.stroke();

    ctx.fillStyle = "#f43f5e";
    ctx.beginPath();
    ctx.arc(-chord * 0.2, 0, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  else if (currentPreset === "car") {
    const hw = obstacle.carW * 0.5;
    const hh = obstacle.carH * 0.5;

    ctx.beginPath();
    // Sports Car body silhouette
    ctx.moveTo(-hw, hh);
    ctx.lineTo(-hw + 20, -hh + 14);
    ctx.lineTo(-hw + 70, -hh);
    ctx.lineTo(hw - 30, -hh);
    ctx.lineTo(hw, -hh + 18);
    ctx.lineTo(hw, hh);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Wheel arches
    ctx.fillStyle = "#030712";
    ctx.beginPath();
    ctx.arc(-hw + 45, hh, 16, Math.PI, 0);
    ctx.arc(hw - 45, hh, 16, Math.PI, 0);
    ctx.fill();
  }
  else if (currentPreset === "plate") {
    ctx.beginPath();
    ctx.roundRect(-6, -65, 12, 130, 4);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

// Vector Grid Mode Visualizer
function renderVectorField() {
  ctx.save();
  ctx.strokeStyle = "rgba(56, 189, 248, 0.22)";
  ctx.lineWidth = 1.2;
  const step = 44;

  for (let x = 40; x < canvas.width; x += step) {
    for (let y = 40; y < canvas.height; y += step) {
      const dummy = new SmokeParticle(y, x);
      dummy.update();

      const mag = Math.hypot(dummy.vx, dummy.vy) || 1;
      const len = Math.min(22, mag * 2.8);

      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (dummy.vx / mag) * len, y + (dummy.vy / mag) * len);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Main 60 FPS Render Loop
function animate() {
  vortexPhase += 0.04 * (airSpeed / 45);

  // Soft motion-blur background clear
  ctx.fillStyle = "rgba(3, 7, 18, 0.28)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (currentMode === "vectors") {
    renderVectorField();
  }

  // Update & Draw Clean Smoke Filaments
  for (let p of particles) {
    p.update();
    p.draw();
  }

  // Draw Physical Obstacle Geometry
  renderObstacle();

  requestAnimationFrame(animate);
}
animate();

// Obstacle Drag & Drop Handler
canvas.addEventListener("mousedown", (e) => {
  if (e.target.closest(".control-deck, .hud-top")) return;
  const d = Math.hypot(e.clientX - obstacle.x, e.clientY - obstacle.y);
  if (d < 110) {
    obstacle.isDragging = true;
  }
});

window.addEventListener("mousemove", (e) => {
  if (obstacle.isDragging) {
    obstacle.x = Math.max(120, Math.min(canvas.width - 120, e.clientX));
    obstacle.y = Math.max(80, Math.min(canvas.height - 80, e.clientY));
  }
});

window.addEventListener("mouseup", () => {
  obstacle.isDragging = false;
});

// Touch Device Support
canvas.addEventListener("touchstart", (e) => {
  if (e.touches.length === 1) {
    const t = e.touches[0];
    const d = Math.hypot(t.clientX - obstacle.x, t.clientY - obstacle.y);
    if (d < 110) obstacle.isDragging = true;
  }
});

window.addEventListener("touchmove", (e) => {
  if (obstacle.isDragging && e.touches.length === 1) {
    obstacle.x = e.touches[0].clientX;
    obstacle.y = e.touches[0].clientY;
  }
});

window.addEventListener("touchend", () => obstacle.isDragging = false);

// UI Controls
speedSlider.addEventListener("input", (e) => {
  airSpeed = parseInt(e.target.value);
  speedBadge.textContent = `${airSpeed} m/s`;
  speedReadout.textContent = `${airSpeed} m/s`;
  const reynolds = Math.floor(airSpeed * 275);
  reReadout.textContent = `Re ${reynolds.toLocaleString()}`;
});

aoaSlider.addEventListener("input", (e) => {
  angleDeg = parseInt(e.target.value);
  angleRad = angleDeg * (Math.PI / 180);
  aoaBadge.textContent = `${angleDeg}°`;
});

presetButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    presetButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentPreset = btn.dataset.preset;
  });
});

modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    modeButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentMode = btn.dataset.mode;
  });
});

clearBtn.addEventListener("click", () => {
  obstacle.x = canvas.width * 0.38;
  obstacle.y = canvas.height * 0.5;
  angleDeg = 6;
  angleRad = 6 * (Math.PI / 180);
  aoaSlider.value = 6;
  aoaBadge.textContent = "6°";
});