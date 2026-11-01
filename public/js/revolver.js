'use strict';
/* The revolver — a player may end their character's life.

   Stowed at the bottom-left of the world map: the real 3D model, live, in
   a small canvas of its own (it leans toward the cursor). Picking it up
   hands over to a full-screen canvas at the very same spot. The flow:

     pick up  → the gun rises to the middle of the screen, cylinder swung out
                toward the player; six cartridges pop up where it lay
     load     → click a chamber to drop a round in (again to take it out);
                click the cylinder anywhere else to close it
     close    → the cylinder swings in and spins (the SERVER spins it:
                POST /api/revolver/close), then the gun turns to face you
     fire     → click the gun: the hammer falls (POST /api/revolver/fire).
                An empty chamber clicks and the cylinder turns; a live one
                and the screen goes black — the record of the run follows
     stow     → click anywhere off the gun, at any stage

   Rendering is a small hand-written WebGL1 renderer (no libraries): the
   model built by tools/build-revolver.js (quantised parts, chamber layout,
   pivots), shaded with a physically-based model lit by a procedural studio
   (softbox, strip light, warm floor bounce) so the steel and brass read as
   real metal. Picking renders part ids to an offscreen buffer.

   Sounds are recordings (not synthesised), played from
   /assets/sfx/revolver/<slot>.mp3 — see SOUNDS; a missing file is simply
   silent.

   The server decides everything (server/mortality.js); this only animates
   what it answers. The GM never sees the gun; a dead account sees only the
   record of its run (Revolver.showDead). */
const Revolver = (() => {
  const MODEL = '/assets/models/revolver';
  const SOUNDS = ['pickup', 'open', 'load', 'unload', 'close', 'spin', 'turn', 'cock', 'dry', 'shot', 'stow'];
  const FOV = 32 * Math.PI / 180;
  const DEG = Math.PI / 180;

  /* ---------------- math (column-major 4×4) ---------------- */
  const I = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  const T = (x, y, z) => { const m = I(); m[12] = x; m[13] = y; m[14] = z; return m; };
  const Sc = (s) => { const m = I(); m[0] = m[5] = m[10] = s; return m; };
  const Rx = (a) => { const m = I(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; };
  const Ry = (a) => { const m = I(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; };
  const Rz = (a) => { const m = I(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; };
  const chain = (...ms) => ms.reduce((a, b) => mul(a, b));
  const apply = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  function persp(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
    m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = 2 * far * near / (near - far);
    return m;
  }
  const nmat = (m) => {
    // the model matrices are rotation × uniform scale: the normal matrix is
    // the upper 3×3 (normalised in the shader)
    return new Float32Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]);
  };
  // quaternions for the cartridges' flight (tray → chamber)
  function quatOf(m) {
    const sx = Math.hypot(m[0], m[1], m[2]);
    const a = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sx, m[5] / sx, m[6] / sx, m[8] / sx, m[9] / sx, m[10] / sx];
    const tr = a[0] + a[4] + a[8];
    let x, y, z, w;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (a[5] - a[7]) / s; y = (a[6] - a[2]) / s; z = (a[1] - a[3]) / s; }
    else if (a[0] > a[4] && a[0] > a[8]) { const s = Math.sqrt(1 + a[0] - a[4] - a[8]) * 2; w = (a[5] - a[7]) / s; x = s / 4; y = (a[3] + a[1]) / s; z = (a[6] + a[2]) / s; }
    else if (a[4] > a[8]) { const s = Math.sqrt(1 + a[4] - a[0] - a[8]) * 2; w = (a[6] - a[2]) / s; x = (a[3] + a[1]) / s; y = s / 4; z = (a[7] + a[5]) / s; }
    else { const s = Math.sqrt(1 + a[8] - a[0] - a[4]) * 2; w = (a[1] - a[3]) / s; x = (a[6] + a[2]) / s; y = (a[7] + a[5]) / s; z = s / 4; }
    return [x, y, z, w];
  }
  function slerp(a, b, t) {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    if (d < 0) { b = b.map(v => -v); d = -d; }
    if (d > 0.9995) { const r = a.map((v, i) => v + (b[i] - v) * t); const l = Math.hypot(...r); return r.map(v => v / l); }
    const th = Math.acos(d), s = Math.sin(th);
    return a.map((v, i) => (Math.sin((1 - t) * th) * v + Math.sin(t * th) * b[i]) / s);
  }
  function matOf(q, p, s) {
    const [x, y, z, w] = q, m = new Float32Array(16);
    m[0] = (1 - 2 * (y * y + z * z)) * s; m[1] = 2 * (x * y + z * w) * s; m[2] = 2 * (x * z - y * w) * s;
    m[4] = 2 * (x * y - z * w) * s; m[5] = (1 - 2 * (x * x + z * z)) * s; m[6] = 2 * (y * z + x * w) * s;
    m[8] = 2 * (x * z + y * w) * s; m[9] = 2 * (y * z - x * w) * s; m[10] = (1 - 2 * (x * x + y * y)) * s;
    m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; m[15] = 1;
    return m;
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = {
    out: (t) => 1 - Math.pow(1 - t, 3),
    inOut: (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
    back: (t) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    lin: (t) => t
  };

  /* ---------------- shaders ---------------- */
  const VS = `
attribute vec3 aPos; attribute vec3 aNrm;
uniform mat4 uModel; uniform mat4 uVP; uniform mat3 uNM; uniform float uQ;
varying vec3 vW; varying vec3 vN; varying vec3 vL;
void main(){
  vec4 w = uModel * vec4(aPos / uQ, 1.0);
  vW = w.xyz; vN = uNM * aNrm; vL = aPos / uQ;
  gl_Position = uVP * w;
}`;
  const FS = `
precision highp float;
varying vec3 vW; varying vec3 vN; varying vec3 vL;
uniform vec3 uCam; uniform vec3 uColor; uniform float uMetal; uniform float uRough;
uniform float uFlash; uniform vec3 uFlashPos; uniform float uAlpha; uniform float uGrain;
uniform vec4 uBore; uniform float uBoreOn;            // barrel: y, z, radius, muzzle x
uniform vec2 uCham[6]; uniform vec3 uChamB;           // chambers: centres; radius, front x, rear x
uniform float uChamOn;
const float PI = 3.14159265;
float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i), hash(i+vec3(1,0,0)), f.x), mix(hash(i+vec3(0,1,0)), hash(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i+vec3(0,0,1)), hash(i+vec3(1,0,1)), f.x), mix(hash(i+vec3(0,1,1)), hash(i+vec3(1,1,1)), f.x), f.y), f.z); }
// a dark studio: a big warm softbox above-left, a cool strip light on the
// right, a low warm bounce off the table, and a faint horizon. Roughness
// widens and dims the light sources (a cheap stand-in for prefiltering).
vec3 env(vec3 d, float r){
  float up = d.y;
  vec3 c = mix(vec3(0.006,0.006,0.006), vec3(0.030,0.029,0.028), smoothstep(-0.3, 0.9, up));
  float w = 0.06 + r * 0.55;
  float sb = smoothstep(0.93 - w, 0.95, dot(d, normalize(vec3(-0.45, 0.78, 0.45))));
  c += vec3(3.4, 3.3, 3.1) * sb * (1.0 - 0.55 * r);
  float sx = smoothstep(0.10 + w * 0.6, 0.02, abs(d.x - 0.82)) * smoothstep(-0.45, 0.05, d.y) * smoothstep(0.95, 0.45, d.y);
  c += vec3(1.25, 1.4, 1.6) * sx * (1.0 - 0.5 * r);
  float bk = smoothstep(0.86 - w, 0.95, dot(d, normalize(vec3(0.15, 0.25, -0.95))));
  c += vec3(0.9, 0.8, 0.7) * bk * 0.6;
  c += vec3(0.07, 0.055, 0.04) * smoothstep(0.0, -0.7, up);
  c += vec3(0.30) * exp(-abs(up + 0.04) * (40.0 - 30.0 * r)) * 0.35;
  return c;
}
float D_GGX(float NH, float a){ float a2 = a*a; float d = NH*NH*(a2-1.0)+1.0; return a2 / (PI*d*d); }
float G_S(float NV, float NL, float a){ float k = (a+1.0)*(a+1.0)/8.0; return (NV/(NV*(1.0-k)+k)) * (NL/(NL*(1.0-k)+k)); }
vec3 light(vec3 N, vec3 V, vec3 L, vec3 col, vec3 base, float metal, float r, vec3 F0){
  vec3 H = normalize(V + L);
  float NL = max(dot(N, L), 0.0), NV = max(dot(N, V), 1e-3), NH = max(dot(N, H), 0.0), VH = max(dot(V, H), 0.0);
  float a = max(r * r, 0.02);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VH, 5.0);
  vec3 spec = D_GGX(NH, a) * G_S(NV, NL, a) * F / (4.0 * NV * max(NL, 1e-3) + 1e-4);
  vec3 kd = (1.0 - F) * (1.0 - metal);
  return (kd * base / PI + spec) * col * NL;
}
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
void main(){
  if (uGrain < -0.5) { gl_FragColor = vec4(0.008, 0.007, 0.006, uAlpha); return; }   // the bore: a hole
  vec3 N = normalize(vN);
  vec3 V = normalize(uCam - vW);
  if (dot(N, V) < 0.0) N = -N;               // double-sided source materials
  // machining marks and wear: a little noise in the roughness and the normal
  float n1 = vnoise(vL * 38.0), n2 = vnoise(vL * vec3(4.0, 90.0, 90.0));
  float r = clamp(uRough + (n1 - 0.5) * 0.06 * uGrain + (n2 - 0.5) * 0.05 * uGrain, 0.04, 1.0);
  N = normalize(N + (vec3(vnoise(vL*23.0), vnoise(vL*23.0+7.0), vnoise(vL*23.0+13.0)) - 0.5) * 0.012 * uGrain);
  vec3 base = uColor * (0.96 + 0.06 * n1 * uGrain);
  vec3 F0 = mix(vec3(0.04), base, uMetal);
  float NV = max(dot(N, V), 1e-3);
  vec3 F = F0 + (max(vec3(1.0 - r), F0) - F0) * pow(1.0 - NV, 5.0);
  vec3 R = reflect(-V, N);
  vec3 col = env(R, r) * F;                                   // reflections
  col += base * (1.0 - uMetal) * env(N, 1.0) * 0.55;          // diffuse ambient
  col += light(N, V, normalize(vec3(-0.45, 0.78, 0.45)), vec3(3.4, 3.1, 2.7), base, uMetal, r, F0);
  col += light(N, V, normalize(vec3(0.85, 0.15, -0.35)), vec3(1.4, 1.55, 1.8), base, uMetal, r, F0);
  col += light(N, V, normalize(vec3(0.1, -0.6, 0.8)), vec3(0.25, 0.18, 0.12), base, uMetal, r, F0);
  col += light(N, V, V, vec3(0.35, 0.33, 0.31), base, uMetal, max(r, 0.35), F0);   // a dim light by the camera
  // the muzzle flash lights the gun from the front
  if (uFlash > 0.0) {
    vec3 Lf = uFlashPos - vW; float dist = length(Lf);
    col += light(N, V, Lf / dist, vec3(9.0, 5.5, 2.2) * uFlash / (1.0 + dist * dist * 0.08), base, uMetal, r, F0);
  }
  // cavity darkening: faces turned from the light read deeper
  col *= 0.78 + 0.22 * smoothstep(-0.6, 0.6, N.y);
  // the inside of the bore and of the chambers: dark holes, the light
  // falling off with depth
  float hole = 0.0;
  if (uBoreOn > 0.5 && vL.x > uBore.w - 0.02) hole = 1.0 - smoothstep(uBore.z * 0.82, uBore.z * 0.98, length(vL.yz - uBore.xy));
  if (uChamOn > 0.5) {
    float depth = min(vL.x - uChamB.y, uChamB.z - vL.x);
    for (int i = 0; i < 6; i++) if (length(vL.yz - uCham[i]) < uChamB.x) hole = max(hole, smoothstep(0.0, 0.35, depth));
  }
  col *= 1.0 - 0.94 * hole;
  col = aces(col * 1.05);
  gl_FragColor = vec4(pow(col, vec3(1.0/2.2)), uAlpha);
}`;
  const PICK_FS = `precision mediump float; uniform vec3 uId; void main(){ gl_FragColor = vec4(uId, 1.0); }`;

  /* ---------------- state ---------------- */
  const R = {
    data: null, loading: null, gl: null, canvas: null, prog: null, pick: null, parts: {}, fbo: null,
    sounds: {}, stage: null, raf: 0, tweens: [], t0: 0, busy: false
  };
  // the pose of everything on screen
  const P = {
    gun: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1 },
    crane: 0, spin: 0, hammer: 0, trigger: 0, flash: 0, sway: 0, alpha: 1,
    tray: { x: 0, y: 0, z: 0, up: 0 }, rounds: [] // per round: { at: 'tray'|'chamber'|'fly', chamber, k, from, toChamber }
  };
  const loaded = () => P.rounds.filter(r => r.at === 'chamber').map(r => r.chamber);

  /* ---------------- loading ---------------- */
  function load() {
    if (R.data) return Promise.resolve(R.data);
    if (R.loading) return R.loading;
    R.loading = Promise.all([
      fetch(MODEL + '.json').then(r => r.json()),
      fetch(MODEL + '.bin').then(r => r.arrayBuffer())
    ]).then(([meta, bin]) => { R.data = { meta, bin }; return R.data; });
    return R.loading;
  }
  function loadSounds() {
    for (const name of SOUNDS) {
      if (R.sounds[name] !== undefined) continue;
      const a = new Audio();
      a.preload = 'auto';
      a.addEventListener('error', () => { R.sounds[name] = null; });
      a.src = `/assets/sfx/revolver/${name}.mp3`;
      R.sounds[name] = a;
    }
  }
  function sound(name, vol) {
    const a = R.sounds[name];
    if (!a) return;
    try {
      const c = a.cloneNode();
      const base = (window.SFX && SFX.vol) ? SFX.vol() : 0.8;
      c.volume = Math.max(0, Math.min(1, base * (vol === undefined ? 1 : vol)));
      const p = c.play(); if (p && p.catch) p.catch(() => { });
    } catch (e) { /* no audio */ }
  }

  /* ---------------- GL ---------------- */
  function compile(gl, vs, fs) {
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos'); gl.bindAttribLocation(p, 1, 'aNrm');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }
  // One GL context per canvas (the small one on the map, the full-screen
  // stage); `use` makes one current for draw()/pickAt().
  function initGL(canvas) {
    const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('This device cannot draw the revolver (no WebGL).');
    const ctx = { gl, canvas, prog: compile(gl, VS, FS), pick: compile(gl, VS, PICK_FS), parts: {}, fbo: null };
    use(ctx);
    const { meta, bin } = R.data;
    for (const p of meta.parts) {
      const vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(bin, p.vertexOffset, p.vertexCount * meta.vertexStride), gl.STATIC_DRAW);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(bin, p.indexOffset, p.indexCount), gl.STATIC_DRAW);
      ctx.parts[p.name] = { vb, ib, count: p.indexCount, mat: meta.materials[p.material] };
    }
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    return ctx;
  }
  function use(ctx) {
    if (R.ctx) R.ctx.fbo = R.fbo;
    R.ctx = ctx;
    Object.assign(R, ctx ? { gl: ctx.gl, canvas: ctx.canvas, prog: ctx.prog, pick: ctx.pick, parts: ctx.parts, fbo: ctx.fbo }
      : { gl: null, canvas: null, prog: null, pick: null, parts: {}, fbo: null });
  }
  // free a context for good (browsers cap how many may live at once)
  function release(ctx) {
    if (!ctx) return;
    if (R.ctx === ctx) use(null);
    try { const ext = ctx.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (e) { /* gone already */ }
  }
  // material looks (the source's flat PBR factors, tuned for the studio)
  const LOOK = {
    frame: { color: [0.70, 0.71, 0.73], metal: 1, rough: 0.2, grain: 1 }, cylinder: { color: [0.70, 0.71, 0.73], metal: 1, rough: 0.22, grain: 1 },
    trigger: { color: [0.62, 0.63, 0.65], metal: 1, rough: 0.28, grain: 0.6 }, hammer: { color: [0.62, 0.63, 0.65], metal: 1, rough: 0.28, grain: 0.6 },
    grip: { color: [0.035, 0.028, 0.024], metal: 0, rough: 0.48, grain: 1.6 },
    bore: { color: [0.004, 0.004, 0.004], metal: 0, rough: 1, grain: -1 },
    bullet_case: { color: [0.80, 0.62, 0.30], metal: 1, rough: 0.24, grain: 0.7 },
    bullet_head: { color: [0.78, 0.60, 0.30], metal: 1, rough: 0.30, grain: 0.6 },
    bullet_tip: { color: [0.62, 0.30, 0.17], metal: 1, rough: 0.34, grain: 0.8 },
    bullet_primer: { color: [0.80, 0.74, 0.60], metal: 1, rough: 0.36, grain: 0.5 }
  };
  const ROUND_PARTS = ['bullet_case', 'bullet_head', 'bullet_tip', 'bullet_primer'];

  /* ---------------- the scene graph ---------------- */
  function view() {
    const c = R.canvas, w = c.clientWidth || 1, h = c.clientHeight || 1;
    const aspect = w / h;
    // the camera backs off on narrow (portrait) screens so the gun fits
    const D = Math.max(24, 7.5 / (Math.tan(FOV / 2) * aspect));
    return { w, h, aspect, D, VP: mul(persp(FOV, aspect, 0.5, 200), T(0, 0, -D)), cam: [0, 0, D] };
  }
  // CSS-pixel point on the screen → world point on the plane z = zp
  function unproject(v, sx, sy, zp) {
    const nx = sx / v.w * 2 - 1, ny = 1 - sy / v.h * 2, d = v.D - zp, t = Math.tan(FOV / 2);
    return [nx * d * t * v.aspect, ny * d * t, zp];
  }
  function project(v, p) {
    const m = v.VP;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [(x / w + 1) / 2 * v.w, (1 - y / w) / 2 * v.h];
  }
  function gunM() {
    const g = P.gun, sw = P.sway;
    const t = performance.now() / 1000;
    const bx = sw * (Math.sin(t * 0.9) * 0.6 + Math.sin(t * 2.3) * 0.25) * DEG, by = sw * (Math.sin(t * 0.7 + 1) * 0.8) * DEG;
    return chain(T(g.x, g.y + sw * Math.sin(t * 1.1) * 0.04, g.z), Rx(g.rx + bx), Ry(g.ry + by), Rz(g.rz), Sc(g.s));
  }
  function craneM() {
    const meta = R.data.meta, k = P.crane, py = meta.pivots.crane[1];
    return chain(T(0, 0, 0.62 * k), T(0, py, 0), Rx(k * 86 * DEG), T(0, -py, 0));
  }
  const cylM = (G) => chain(G, craneM(), Rx(P.spin));
  function hammerM(G) {
    const pv = R.data.meta.pivots.hammer;
    return chain(G, T(pv[0], pv[1], 0), Rz(-P.hammer * 34 * DEG), T(-pv[0], -pv[1], 0));
  }
  function triggerM(G) {
    const pv = R.data.meta.pivots.trigger;
    return chain(G, T(pv[0], pv[1], 0), Rz(-P.trigger * 16 * DEG), T(-pv[0], -pv[1], 0));
  }
  // a round seated in chamber i (in cylinder space): base flush with the rear
  function chamberLocal(i) {
    const meta = R.data.meta, c = meta.chambers[i], a = c.angle * DEG;
    return T(meta.cylinder.rearX + 0.012, c.radius * Math.cos(a), c.radius * Math.sin(a));
  }
  // the k-th tray slot: upright, tip up, in a row where the gun lay
  function trayM(k, v) {
    const tr = P.tray, s = P.gun.s;
    const up = tr.up;
    return chain(T(tr.x + k * 0.62 * s, tr.y - (1 - up) * 1.8 * s, tr.z), Rx(-14 * DEG), Rz(-90 * DEG), Sc(s * Math.max(0.001, up)));
  }
  function roundM(r, G, v) {
    const cyl = cylM(G);
    if (r.at === 'chamber') return mul(cyl, chamberLocal(r.chamber));
    if (r.at === 'tray') return trayM(r.slot, v);
    // in flight: from its start pose to the chamber (or back to the tray)
    const a = r.from, b = r.to === 'tray' ? trayM(r.slot, v) : mul(cyl, chamberLocal(r.chamber));
    // approach along the chamber axis for the last stretch
    const bOut = r.to === 'tray' ? b : mul(cyl, mul(chamberLocal(r.chamber), T(1.7, 0, 0)));
    const k = r.k;
    const qa = quatOf(a), qb = quatOf(b);
    const sa = Math.hypot(a[0], a[1], a[2]), sb = Math.hypot(b[0], b[1], b[2]);
    const pa = [a[12], a[13], a[14]], pb = [b[12], b[13], b[14]], po = [bOut[12], bOut[13], bOut[14]];
    let p;
    if (r.to === 'tray' || k < 0.72) {
      const t = r.to === 'tray' ? k : k / 0.72;
      const target = r.to === 'tray' ? pb : po;
      p = pa.map((v0, i) => lerp(v0, target[i], ease.inOut(t)));
      p[1] += Math.sin(Math.PI * t) * 1.6 * P.gun.s; // an arc
      p[2] += Math.sin(Math.PI * t) * 1.2 * P.gun.s;
    } else {
      const t = (k - 0.72) / 0.28;
      p = po.map((v0, i) => lerp(v0, pb[i], ease.out(t)));
    }
    const q = slerp(qa, qb, ease.inOut(Math.min(1, k / 0.75)));
    return matOf(q, p, lerp(sa, sb, k));
  }

  function drawPart(prog, name, M, extra) {
    const gl = R.gl, part = R.parts[name];
    if (!part) return;
    gl.uniformMatrix4fv(prog.u.uModel, false, M);
    if (prog.u.uNM) gl.uniformMatrix3fv(prog.u.uNM, false, nmat(M));
    if (prog === R.prog) {
      const look = LOOK[name] || {};
      gl.uniform3fv(prog.u.uColor, look.color || part.mat.color);
      gl.uniform1f(prog.u.uMetal, look.metal !== undefined ? look.metal : part.mat.metallic);
      gl.uniform1f(prog.u.uRough, look.rough !== undefined ? look.rough : Math.max(0.22, part.mat.roughness));
      gl.uniform1f(prog.u.uGrain, look.grain === undefined ? 1 : look.grain);
      gl.uniform1f(prog.u.uBoreOn, name === 'frame' ? 1 : 0);
      gl.uniform1f(prog.u.uChamOn, name === 'cylinder' ? 1 : 0);
    } else if (extra) gl.uniform3fv(prog.u.uId, extra);
    gl.bindBuffer(gl.ARRAY_BUFFER, part.vb);
    gl.vertexAttribPointer(0, 3, gl.SHORT, false, 10, 0);
    gl.vertexAttribPointer(1, 3, gl.BYTE, true, 10, 6);
    gl.enableVertexAttribArray(0); gl.enableVertexAttribArray(1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, part.ib);
    gl.drawElements(gl.TRIANGLES, part.count, gl.UNSIGNED_SHORT, 0);
  }
  // Everything this frame, as [partName, matrix, pickId]
  function scene(v) {
    const G = gunM(), out = [];
    out.push(['frame', G, 1], ['grip', G, 1], ['bore', G, 1], ['cylinder', cylM(G), 2], ['hammer', hammerM(G), 1], ['trigger', triggerM(G), 1]);
    for (const r of P.rounds) {
      const M = roundM(r, G, v);
      for (const n of ROUND_PARTS) out.push([n, M, r.at === 'chamber' ? 2 : 3]);
    }
    return out;
  }
  function resize() {
    const c = R.canvas, dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; R.fbo = null; }
  }
  function draw() {
    const gl = R.gl; if (!gl) return;
    resize();
    const v = view();
    gl.viewport(0, 0, R.canvas.width, R.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const pr = R.prog;
    gl.useProgram(pr.p);
    gl.uniformMatrix4fv(pr.u.uVP, false, v.VP);
    gl.uniform3fv(pr.u.uCam, v.cam);
    gl.uniform1f(pr.u.uQ, R.data.meta.posQuant);
    gl.uniform1f(pr.u.uFlash, P.flash);
    gl.uniform1f(pr.u.uAlpha, P.alpha);
    const G = gunM();
    const meta = R.data.meta, br = meta.barrel;
    gl.uniform3fv(pr.u.uFlashPos, apply(G, [br.muzzleX - 0.6, br.y, br.z]));
    gl.uniform4f(pr.u.uBore, br.y, br.z, br.bore, br.muzzleX);
    const ch = [];
    for (const c of meta.chambers) ch.push(c.radius * Math.cos(c.angle * DEG), c.radius * Math.sin(c.angle * DEG));
    gl.uniform2fv(pr.u['uCham[0]'], ch);
    gl.uniform3f(pr.u.uChamB, meta.chamberHole || meta.bullet.radius, meta.cylinder.frontX, meta.cylinder.rearX);
    for (const [n, M] of scene(v)) if (!R.only || R.only.includes(n)) drawPart(pr, n, M);
  }
  // what is under a screen point: 0 nothing · 1 the gun · 2 the cylinder
  // (or a seated round) · 3 a round in the tray
  function pickAt(sx, sy) {
    const gl = R.gl, c = R.canvas;
    const v = view();
    if (!R.fbo) {
      const fb = gl.createFramebuffer(), tex = gl.createTexture(), rb = gl.createRenderbuffer();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, c.width, c.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, c.width, c.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
      R.fbo = fb;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, R.fbo);
    gl.viewport(0, 0, c.width, c.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const pr = R.pick;
    gl.useProgram(pr.p);
    gl.uniformMatrix4fv(pr.u.uVP, false, v.VP);
    gl.uniform1f(pr.u.uQ, R.data.meta.posQuant);
    for (const [n, M, id] of scene(v)) drawPart(pr, n, M, [id / 10, 0, 0]);
    const px = new Uint8Array(4);
    const dpr = c.width / c.clientWidth;
    gl.readPixels(Math.round(sx * dpr), Math.round(c.height - sy * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    return Math.round(px[0] / 25.5);
  }
  // the chamber (rear face) under a screen point, if any
  function chamberAt(sx, sy) {
    const v = view(), cyl = cylM(gunM()), meta = R.data.meta;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < meta.chambers.length; i++) {
      const c = mul(cyl, chamberLocal(i));
      const p0 = project(v, [c[12], c[13], c[14]]);
      const rim = apply(c, [0, meta.bullet.radius * 1.35, 0]);
      const rad = Math.hypot(project(v, rim)[0] - p0[0], project(v, rim)[1] - p0[1]);
      const d = Math.hypot(sx - p0[0], sy - p0[1]);
      if (d < Math.max(rad, 16) && d < bestD) { best = i; bestD = d; }
    }
    return best;
  }

  /* ---------------- animation ---------------- */
  function tween(obj, to, ms, ez) {
    return new Promise(res => {
      const from = {};
      for (const k in to) from[k] = obj[k];
      R.tweens.push({ obj, from, to, ms: Math.max(1, ms), t0: performance.now(), ez: ease[ez || 'inOut'], res });
      loop();
    });
  }
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  function loop() {
    if (R.raf) return;
    const step = () => {
      R.raf = 0;
      const now = performance.now();
      for (const tw of R.tweens.slice()) {
        const k = Math.min(1, (now - tw.t0) / tw.ms), e = tw.ez(k);
        for (const key in tw.to) tw.obj[key] = lerp(tw.from[key], tw.to[key], e);
        if (k >= 1) { R.tweens.splice(R.tweens.indexOf(tw), 1); tw.res(); }
      }
      for (const r of P.rounds) if (r.at === 'fly') {
        r.k = Math.min(1, (now - r.t0) / r.ms);
        if (r.k >= 1) {
          r.at = r.to === 'tray' ? 'tray' : 'chamber';
          if (r.done) r.done();
        }
      }
      draw();
      if (R.stage && (R.tweens.length || P.sway || P.rounds.some(r => r.at === 'fly'))) R.raf = requestAnimationFrame(step);
    };
    R.raf = requestAnimationFrame(step);
  }

  /* ---------------- poses ---------------- */
  // where the gun lies when stowed: a side view, slightly from above
  const STOW_POSE = { rx: 16 * DEG, ry: 0, rz: -6 * DEG };
  // the middle of the screen, leaving room for the hint (and on a phone
  // the tray below)
  const centre = (v, frac) => ({ left: v.w * (1 - frac) / 2, top: v.h * (v.aspect < 0.9 ? 0.16 : 0.12), width: v.w * frac, height: v.h * (v.aspect < 0.9 ? 0.5 : 0.66) });
  function loadPose(v) {
    // three-quarters from behind, closed in on the swung-out cylinder so the
    // chambers are big targets (on a phone too); the grip may run off-screen
    const narrow = v.aspect < 0.9;
    const pose = fitPose(v, centre(v, narrow ? 0.94 : 0.72), { rx: 20 * DEG, ry: -56 * DEG, rz: -4 * DEG, z: 0 }, 0.95);
    pose.s *= narrow ? 1.9 : 1.75;
    // put the swung-out cylinder's middle a little above the screen centre
    const py = R.data.meta.pivots.crane[1], a = 86 * DEG;
    const C = [0, py - py * Math.cos(a), -py * Math.sin(a) + 0.62];
    const M = chain(T(0, 0, pose.z), Rx(pose.rx), Ry(pose.ry), Rz(pose.rz), Sc(pose.s));
    const w = apply(M, C);
    const t = unproject(v, v.w * (narrow ? 0.5 : 0.52), v.h * (narrow ? 0.4 : 0.44), w[2]);
    pose.x = t[0] - w[0]; pose.y = t[1] - w[1];
    return pose;
  }
  function aimPose(v) {
    // turned round: the muzzle looks straight out of the screen
    return fitPose(v, centre(v, v.aspect < 0.9 ? 0.86 : 0.5), { rx: 7 * DEG, ry: 74 * DEG, rz: -5 * DEG, z: 1.5 }, 0.95);
  }
  // the pose matching the still on the map (screen rect → world)
  // Fit a pose into a screen rect (contain): project the model's box at a
  // trial scale, then scale and shift so it fills the rect — twice, since
  // perspective makes the first answer a little off.
  function fitPose(v, rect, rot, fill) {
    const b = R.data.meta.bounds;
    const corners = [];
    for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) corners.push([x, y, z]);
    const pose = Object.assign({ x: 0, y: 0, z: 0, s: 1 }, rot);
    for (let it = 0; it < 3; it++) {
      const M = chain(T(pose.x, pose.y, pose.z), Rx(pose.rx), Ry(pose.ry), Rz(pose.rz), Sc(pose.s));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const c of corners) { const q = project(v, apply(M, c)); x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
      const k = Math.min(rect.width * (fill || 0.92) / (x1 - x0), rect.height * (fill || 0.92) / (y1 - y0));
      pose.s *= k;
      // shift so the box centre lands on the rect centre (on the z=pose.z plane)
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const a = unproject(v, cx, cy, pose.z), t = unproject(v, rect.left + rect.width / 2, rect.top + rect.height / 2, pose.z);
      pose.x = t[0] + (pose.x - a[0]) * k; pose.y = t[1] + (pose.y - a[1]) * k;
    }
    return pose;
  }
  function stowPose(v, rect) { return fitPose(v, rect, STOW_POSE, 0.96); }

  /* ---------------- the stowed revolver on the map ---------------- */
  function available() {
    return !!(W.me && !isGM() && W.me.roleId !== 'dead' && S());
  }
  // The stowed gun is the real model, live: a small canvas of its own at the
  // map's bottom-left (one canvas and context for the session, moved into
  // each new map), lying on its side; it leans toward the cursor.
  const ST = { el: null, canvas: null, ctx: null, tilt: [0, 0], want: [0, 0], raf: 0 };
  function mountStow(wrap) {
    if (!wrap) return;
    if (!available()) { if (ST.el) ST.el.remove(); wrap.classList.remove('has-revolver'); return; }
    wrap.classList.add('has-revolver');
    if (!ST.el) {
      ST.canvas = el('canvas.rv-stow-canvas');
      ST.el = el('button#revolver-stow', { type: 'button', title: 'A revolver', 'aria-label': 'Pick up the revolver' }, ST.canvas);
      ST.el.addEventListener('click', (e) => { e.stopPropagation(); pickUp(ST.el); });
      ST.el.addEventListener('pointermove', (e) => {
        const r = ST.el.getBoundingClientRect();
        ST.want = [((e.clientY - r.top) / r.height - 0.5) * 0.35, ((e.clientX - r.left) / r.width - 0.5) * 0.5];
        stowAnim();
      });
      ST.el.addEventListener('pointerleave', () => { ST.want = [0, 0]; stowAnim(); });
      window.addEventListener('resize', () => drawStow());
    }
    if (ST.el.parentNode !== wrap) wrap.appendChild(ST.el);
    ST.el.classList.toggle('lifted', !!R.stage);
    load().then(() => drawStow()).catch(() => { ST.el.classList.add('failed'); });
  }
  function stowAnim() {
    if (ST.raf) return;
    const step = () => {
      ST.raf = 0;
      ST.tilt = ST.tilt.map((v, i) => v + (ST.want[i] - v) * 0.18);
      drawStow();
      if (Math.abs(ST.tilt[0] - ST.want[0]) + Math.abs(ST.tilt[1] - ST.want[1]) > 0.002) ST.raf = requestAnimationFrame(step);
    };
    ST.raf = requestAnimationFrame(step);
  }
  // draw the stowed gun into its own canvas (the shared pose is borrowed and
  // put back — nothing else is on screen while the gun lies there)
  function drawStow() {
    if (!R.data || !ST.canvas || !ST.canvas.isConnected || R.stage) return;
    const w = ST.canvas.clientWidth, h = ST.canvas.clientHeight;
    if (!w || !h) return;
    const prev = R.ctx;
    try {
      if (!ST.ctx || ST.ctx.gl.isContextLost()) ST.ctx = initGL(ST.canvas); else use(ST.ctx);
      const saved = JSON.stringify(P);
      const v = view();
      Object.assign(P.gun, fitPose(v, { left: 0, top: 0, width: w, height: h },
        { rx: STOW_POSE.rx + ST.tilt[0], ry: STOW_POSE.ry + ST.tilt[1], rz: STOW_POSE.rz }, 0.96));
      P.crane = 0; P.spin = restSpin(); P.hammer = 0; P.trigger = 0; P.flash = 0; P.sway = 0; P.alpha = 1; P.rounds = [];
      draw();
      Object.assign(P, JSON.parse(saved));
    } catch (e) { ST.el && ST.el.classList.add('failed'); }
    finally { use(prev && prev !== ST.ctx ? prev : null); }
  }
  // the cylinder at rest: a chamber lined up under the hammer
  const restSpin = () => -R.data.meta.chambers[0].angle * DEG;

  /* ---------------- the stage ---------------- */
  // touch screens are told to tap, and get the short version
  const TOUCH = () => window.matchMedia && matchMedia('(pointer:coarse)').matches;
  const HINTS = {
    load: ['Click a chamber to load a round · click the cylinder to close it · click away to put the gun down', 'Tap a chamber to load · tap the cylinder to close · tap away to put it down'],
    loadOnly: ['Click a chamber to load a round', 'Tap a chamber to load a round'],
    close: ['Click the cylinder to close it', 'Tap the cylinder to close it'],
    aim: ['Click the gun to pull the trigger · click away to put it down', 'Tap the gun to pull the trigger · tap away to put it down'],
    again: ['Click the gun to pull the trigger again · click away to put it down', 'Tap the gun to pull again · tap away to put it down']
  };
  const say = (k) => hint(HINTS[k][TOUCH() ? 1 : 0]);
  function hint(text) {
    const h = R.stage && R.stage.querySelector('.rv-hint');
    if (h) { h.textContent = text || ''; h.classList.toggle('on', !!text); }
  }
  async function pickUp(stowEl) {
    if (R.stage || R.busy) return;
    R.busy = true;
    loadSounds();
    const rect = stowEl.getBoundingClientRect();
    const stage = el('div#revolver-stage', el('div.rv-dim'), el('canvas.rv-canvas'), el('div.rv-hint'));
    document.body.appendChild(stage);
    R.stage = stage;
    try {
      await load();
      R.stageCtx = initGL(stage.querySelector('canvas'));
    } catch (e) {
      stage.remove(); R.stage = null; R.busy = false;
      toast(e.message || 'The revolver could not be drawn.', true);
      return;
    }
    const v = view();
    R.stowRect = rect;
    Object.assign(P.gun, stowPose(v, rect));
    P.crane = 0; P.spin = restSpin(); P.hammer = 0; P.trigger = 0; P.flash = 0; P.sway = 0; P.alpha = 1;
    P.rounds = [];
    // the tray: where the gun lay
    const tp = unproject(v, rect.left + rect.width * 0.18, rect.top + rect.height * 0.62, 1.5);
    Object.assign(P.tray, { x: tp[0], y: tp[1], z: tp[2], up: 0 });
    draw();
    stowEl.classList.add('lifted');
    stage.classList.add('on');
    stage.addEventListener('pointerdown', onPointer);
    sound('pickup');
    const lp = loadPose(v);
    await tween(P.gun, lp, 900, 'inOut');
    P.sway = 1; loop();
    sound('open');
    await tween(P, { crane: 1 }, 380, 'back');
    // six cartridges rise where the gun lay
    for (let i = 0; i < 6; i++) P.rounds.push({ at: 'tray', slot: i, chamber: -1 });
    P.tray.up = 0;
    await tween(P.tray, { up: 1 }, 420, 'back');
    R.stage.dataset.step = 'load';
    say('load');
    R.busy = false;
  }
  function loadRound(i) {
    const round = P.rounds.filter(r => r.at === 'tray').sort((a, b) => a.slot - b.slot)[0];
    if (!round) return;
    const v = view();
    round.from = trayM(round.slot, v);
    Object.assign(round, { at: 'fly', to: 'chamber', chamber: i, k: 0, t0: performance.now(), ms: 520, done: () => sound('load') });
    loop();
  }
  function unloadRound(i) {
    const round = P.rounds.find(r => r.at === 'chamber' && r.chamber === i);
    if (!round) return;
    round.from = mul(cylM(gunM()), chamberLocal(i));
    sound('unload');
    Object.assign(round, { at: 'fly', to: 'tray', k: 0, t0: performance.now(), ms: 460, done: null });
    loop();
  }
  async function closeGun() {
    R.busy = true;
    R.stage.dataset.step = 'closing';
    hint('');
    // stray rounds go back in the box
    await tween(P.tray, { up: 0 }, 260, 'inOut');
    P.rounds = P.rounds.filter(r => r.at === 'chamber');
    sound('close');
    await tween(P, { crane: 0 }, 260, 'inOut');
    let res;
    try { res = await POST('/api/revolver/close', { loaded: loaded() }); }
    catch (e) { toast(e.message, true); R.busy = false; return stow(); }
    // the server's spin: land chamber `pos` under the hammer
    const a = R.data.meta.chambers[res.pos].angle * DEG;
    let target = -a;
    while (target > P.spin - 5 * Math.PI * 2) target -= Math.PI * 2;
    sound('spin');
    await tween(P, { spin: target }, 1500, 'out');
    sound('turn');
    await tween(P.gun, aimPose(view()), 1100, 'inOut');
    R.stage.dataset.step = 'aim';
    say('aim');
    R.busy = false;
  }
  async function fire() {
    R.busy = true;
    hint('');
    const req = POST('/api/revolver/fire').catch(e => ({ error: e }));
    sound('cock');
    await Promise.all([tween(P, { hammer: 1, trigger: 0.7 }, 260, 'inOut'), wait(380)]);
    const res = await req;
    if (res.error) { toast(res.error.message, true); await tween(P, { hammer: 0, trigger: 0 }, 160); R.busy = false; return; }
    if (res.fired) return death(res);
    await tween(P, { hammer: 0, trigger: 1 }, 45, 'lin');
    sound('dry');
    await tween(P, { trigger: 0 }, 180, 'out');
    // the cylinder turns to the next chamber
    const a = R.data.meta.chambers[res.pos].angle * DEG;
    let target = -a;
    while (target > P.spin + 0.01) target -= Math.PI * 2;
    await tween(P, { spin: target }, 200, 'out');
    say('again');
    R.busy = false;
  }
  async function death(res) {
    // the hammer falls; the world ends
    P.hammer = 0; P.trigger = 1; P.flash = 1;
    draw();
    sound('shot');
    const black = el('div#revolver-black');
    document.body.appendChild(black);
    requestAnimationFrame(() => black.classList.add('on'));
    if (R.stage) { R.stage.remove(); R.stage = null; }
    release(R.stageCtx); R.stageCtx = null;
    P.sway = 0; R.tweens = [];
    W.me.roleId = 'dead';
    await wait(2200);
    showDead(res.obituary, black);
  }
  async function stow() {
    if (!R.stage) return;
    R.busy = true;
    hint('');
    const step = R.stage.dataset.step;
    if (step === 'aim' || step === 'closing') POST('/api/revolver/stow').catch(() => { });
    const v = view();
    if (P.crane > 0.01) { sound('close'); await tween(P, { crane: 0 }, 220); }
    await tween(P.tray, { up: 0 }, 200);
    P.rounds = [];
    P.sway = 0;
    sound('stow');
    const sp = stowPose(v, R.stowRect);
    await tween(P.gun, sp, 800, 'inOut');
    const st = document.getElementById('revolver-stow');
    if (st) st.classList.remove('lifted');
    R.stage.classList.remove('on');
    await wait(120);
    if (R.stage) R.stage.remove();
    R.stage = null; R.busy = false;
    release(R.stageCtx); R.stageCtx = null;
    drawStow();
  }
  function onPointer(e) {
    if (!R.stage || R.busy) return;
    e.preventDefault();
    const rect = R.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const step = R.stage.dataset.step;
    const hit = pickAt(sx, sy);
    if (step === 'load') {
      if (hit === 2 || hit === 3 || hit === 1) {
        const ch = hit !== 3 ? chamberAt(sx, sy) : -1;
        if (ch >= 0) {
          if (P.rounds.some(r => r.chamber === ch && r.at !== 'tray' && !(r.at === 'fly' && r.to === 'tray'))) unloadRound(ch);
          else if (!P.rounds.some(r => r.at === 'fly')) loadRound(ch);
          return;
        }
        if (hit === 2) return closeGun();
        if (hit === 3) return say('loadOnly');
        return say('close');
      }
      return stow();
    }
    if (step === 'aim') {
      if (hit === 1 || hit === 2) return fire();
      return stow();
    }
  }

  /* ---------------- the record of the run ---------------- */
  async function showDead(record, black) {
    if (!record) {
      try { record = (await GET('/api/me/obituary')).obituary; } catch (e) { /* nothing on file */ }
    }
    let page = document.getElementById('revolver-black');
    if (!page) { page = black || el('div#revolver-black.on'); document.body.appendChild(page); }
    page.classList.add('on');
    clear(page);
    const r = record || { name: (W.me && W.me.displayName) || '', summary: 'Your character is dead.', roles: [], positions: [], worth: {}, ownWorth: {}, money: {}, actions: { total: 0, byType: {}, recent: [] }, trades: {}, deaths: { conflicts: [], accidentList: [] } };
    const cur = (S() && S().settings && S().settings.currency) || '';
    const m = (n) => cur + Math.round(n || 0).toLocaleString('en-US');
    const longDate = (s) => { const x = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return x ? new Date(Date.UTC(+x[1], +x[2] - 1, +x[3])).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : (s || ''); };
    const stat = (k, v, sub) => el('div.ob-stat', el('div.ob-k', k), el('div.ob-v', v), sub ? el('div.ob-d', sub) : null);
    const sec = (t, ...kids) => el('section.ob-sec', el('h3', t), ...kids);
    const TYPE = { economy: 'Money', inventory: 'Goods', market: 'Shares', ownership: 'Ownership', politics: 'Politics', election: 'Elections', roster: 'Delegation', event: 'Events', system: 'Administration', war: 'War', accident: 'Accidents', news: 'Press', death: 'Death' };
    const doc = el('div.ob-doc',
      el('div.ob-over', 'The record of'),
      el('h1.ob-name', r.name || '—'),
      r.title ? el('div.ob-title', r.title) : null,
      el('div.ob-dates', [r.firstTurn !== null && r.firstTurn !== undefined ? 'In public life from turn ' + r.firstTurn : '',
        r.diedDate ? 'died ' + longDate(r.diedDate) + (r.diedTurn !== undefined ? ' · turn ' + r.diedTurn : '') : ''].filter(Boolean).join(' — ').replace(/^died/, 'Died')),
      el('p.ob-summary', r.summary || ''),
      el('div.ob-stats',
        stat('Fortune at death', m((r.ownWorth || {}).total), 'in their own name'),
        stat('Concerns they ran', m((r.controlledWorth || {}).total), (r.companies || []).length + ' compan' + ((r.companies || []).length === 1 ? 'y' : 'ies') + ' · ' + (r.sites || 0) + ' sites'),
        stat('Money in', m((r.money || {}).inflow), (r.money || {}).transfers ? r.money.transfers + ' transfers' : ''),
        stat('Money out', m((r.money || {}).outflow)),
        stat('Acts on record', ((r.actions || {}).total || 0).toLocaleString('en-US')),
        stat('Trade offers', ((r.trades || {}).total || 0).toLocaleString('en-US'), (r.trades || {}).accepted ? r.trades.accepted + ' accepted' : ''),
        stat('Deaths on their watch', ((r.deaths || {}).total || 0).toLocaleString('en-US'),
          [(r.deaths || {}).accidents ? r.deaths.accidents + ' in accidents' : '', (r.deaths || {}).combat ? r.deaths.combat + ' in combat' : ''].filter(Boolean).join(' · ')),
        stat('Civilians killed in their wars', ((r.deaths || {}).civilians || 0).toLocaleString('en-US'))),
      (r.roles || []).length ? sec('Roles through time', el('ol.ob-roles', r.roles.map(x => el('li', el('span', x.role), el('span.ob-when', x.turn !== null && x.turn !== undefined ? 'from turn ' + x.turn : 'from the start'))))) : null,
      (r.positions || []).length ? sec('Positions held at death', el('ul.ob-list', r.positions.map(p => el('li', p)))) : null,
      ((r.deaths || {}).conflicts || []).length ? sec('Their wars', el('ul.ob-list', r.deaths.conflicts.map(c => el('li',
        `${c.name} — ${c.side}${c.active ? ' (still raging)' : ''}: ${c.enemyKilled.toLocaleString('en-US')} enemy dead, ${c.ownLost.toLocaleString('en-US')} of their own, ${c.civilians.toLocaleString('en-US')} civilians`)))) : null,
      ((r.deaths || {}).accidentList || []).length ? sec('Accidents at their sites', el('ul.ob-list', r.deaths.accidentList.map(a => el('li', `${a.title} — ${a.deaths} dead (turn ${a.turn})`)))) : null,
      Object.keys((r.actions || {}).byType || {}).length ? sec('What they did', el('div.ob-chips', Object.entries(r.actions.byType).sort((a, b) => b[1] - a[1]).map(([k, n]) => el('span', (TYPE[k] || k) + ' · ' + n)))) : null,
      ((r.actions || {}).recent || []).length ? sec('Their last acts', el('ol.ob-acts', r.actions.recent.map(a => el('li', el('span.ob-when', 'T' + a.turn), el('span', a.title + (a.detail ? ' — ' + a.detail : '')))))) : null,
      el('div.ob-end', '✝'),
      el('button.ob-out', { type: 'button', onclick: async () => { try { await POST('/api/auth/logout'); } catch (e) { } location.reload(); } }, 'Leave'));
    page.appendChild(doc);
    requestAnimationFrame(() => doc.classList.add('in'));
  }

  // A still of any pose as a PNG data URL — for checking the model and its
  // fit (the game itself always draws the live model).
  async function still(w, h, opts) {
    opts = opts || {};
    await load();
    const c = el('canvas', { style: `position:fixed; left:0; top:0; width:${w}px; height:${h}px; z-index:9999;` + (opts.bg ? 'background:' + opts.bg + ';' : '') });
    document.body.appendChild(c);
    const ctx = initGL(c);
    const v = view();
    P.crane = 0; P.spin = restSpin(); P.hammer = 0; P.trigger = 0; P.flash = 0; P.sway = 0; P.alpha = 1; P.rounds = [];
    R.only = opts.only || null;
    if (opts.gun) { Object.assign(P.gun, opts.gun); P.crane = opts.crane || 0; for (const i of opts.loaded || []) P.rounds.push({ at: 'chamber', chamber: i, slot: i }); }
    else if (opts.pose === 'load' || opts.pose === 'aim') {
      Object.assign(P.gun, opts.pose === 'load' ? loadPose(v) : aimPose(v));
      if (opts.pose === 'load') P.crane = 1;
      for (const i of opts.loaded || []) P.rounds.push({ at: 'chamber', chamber: i, slot: i });
      if (opts.tray) {
        const tp = unproject(v, w * 0.08, h * 0.85, 1.5);
        Object.assign(P.tray, { x: tp[0], y: tp[1], z: tp[2], up: 1 });
        for (let i = 0; i < opts.tray; i++) P.rounds.push({ at: 'tray', slot: i, chamber: -1 });
      }
    } else Object.assign(P.gun, stowPose(v, { left: 0, top: 0, width: w, height: h }));
    draw();
    if (opts.keep) return null;
    const url = c.toDataURL('image/png');
    R.only = null;
    release(ctx); c.remove();
    return url;
  }

  // (tests) the chambers' centres on screen during loading
  function _chamberScreen() {
    const v = view(), cyl = cylM(gunM()), rect = R.canvas.getBoundingClientRect();
    return R.data.meta.chambers.map((_, i) => { const c = mul(cyl, chamberLocal(i)); const q = project(v, [c[12], c[13], c[14]]); return [q[0] + rect.left, q[1] + rect.top]; });
  }
  return { mountStow, available, showDead, still, load, _P: P, _R: R, _chamberScreen, _pickAt: (x, y) => R.gl ? pickAt(x, y) : 0 };
})();
