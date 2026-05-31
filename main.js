/**
 * ═══════════════════════════════════════════════════════════════════
 *  M.I.L.O. — main.js
 *  Machine Intelligence & Local Operator
 * ───────────────────────────────────────────────────────────────────
 *  Architecture Overview:
 *   - MiloApp        : top-level orchestrator, wires all modules
 *   - BootManager    : splash screen sequence + particle sphere
 *   - ConnectionManager : WebSocket lifecycle to Cloudflare edge fn
 *   - AudioEngine    : PCM capture (16kHz) + playback (24kHz)
 *   - WaveformViz    : real-time canvas waveform renderer
 *   - SphereViz      : welcome-card animated particle sphere
 *   - ChatRenderer   : message feed, streaming text, rich blocks
 *   - ContentParser  : detects code/mermaid/map fences in stream
 *   - CodeRenderer   : syntax-highlighted tabbed code blocks
 *   - DiagramRenderer: Mermaid.js dynamic diagram blocks
 *   - MapRenderer    : Mapbox GL JS geographic block
 *   - SystemLog      : timestamped sidebar log
 *   - SessionClock   : hh:mm:ss session timer
 *   - TabManager     : canvas tab switching
 *   - SettingsManager: modal config persistence via localStorage
 * ═══════════════════════════════════════════════════════════════════
 */

'use strict';

/* ─── CONSTANTS ─────────────────────────────────────────────────── */
const WS_PATH          = '/api/live-stream';   // Cloudflare Pages function
const MIC_SAMPLE_RATE  = 16000;                // Gemini input requirement
const OUT_SAMPLE_RATE  = 24000;                // Gemini output rate
const PCM_BUFFER_SIZE  = 4096;                 // ScriptProcessor chunk size
const RECONNECT_DELAY  = 3000;                 // ms before reconnect attempt
const MAX_LOG_ENTRIES  = 200;                  // cap sidebar log size

/* ─── SETTINGS (persisted to localStorage) ──────────────────────── */
const DEFAULTS = {
  apiKey:       '',
  model:        'gemini-2.0-flash-exp',
  voice:        'Puck',
  mapboxToken:  '',
  systemPrompt: `You are M.I.L.O. (Machine Intelligence & Local Operator), a highly capable, voice-first AI assistant modeled after JARVIS. You are precise, efficient, technically expert, and occasionally dry-witted. Always be concise in voice responses. When outputting code, wrap it in triple backticks with a language identifier. When asked to visualize system flows or architectures, produce a Mermaid diagram in a \`\`\`mermaid block. When a query involves locations or mapping, output a JSON block tagged \`\`\`map containing an array of objects with {lat, lng, label} fields.`,
  inputSampleRate:  MIC_SAMPLE_RATE,
  outputSampleRate: OUT_SAMPLE_RATE,
};


/* ══════════════════════════════════════════════════════════════════
   UTILITY HELPERS
══════════════════════════════════════════════════════════════════ */

/** Query selector shorthand */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

/** Current wall-clock timestamp string hh:mm:ss */
const timestamp = () => new Date().toLocaleTimeString('en-US', { hour12: false });

/** Convert Float32Array PCM → Int16 PCM ArrayBuffer (Little-Endian) */
function float32ToInt16(float32Arr) {
  const int16 = new Int16Array(float32Arr.length);
  for (let i = 0; i < float32Arr.length; i++) {
    // Clamp to [-1, 1] then scale to int16 range
    const clamped = Math.max(-1, Math.min(1, float32Arr[i]));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
  }
  return int16.buffer;
}

/** ArrayBuffer → Base64 string */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Base64 → Float32Array (for 16-bit PCM playback) */
function base64ToFloat32(base64, sampleRate = OUT_SAMPLE_RATE) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
  }
  return float32;
}

/** Escape HTML special chars */
function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** Debounce */
function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}


/* ══════════════════════════════════════════════════════════════════
   SYSTEM LOG
══════════════════════════════════════════════════════════════════ */
class SystemLog {
  constructor() {
    this.el    = $('#system-log');
    this.scroll = $('#log-scroll');
    this.count  = 0;
    // Wire clear button
    $('#btn-clear-log').addEventListener('click', () => this.clear());
    this.write('M.I.L.O. subsystems loaded.', 'info');
  }

  write(msg, level = 'info') {
    if (this.count >= MAX_LOG_ENTRIES) {
      // Remove oldest entries to maintain cap
      const oldest = this.el.firstElementChild;
      if (oldest) this.el.removeChild(oldest);
    }
    const entry = document.createElement('div');
    entry.className = `log-entry log-entry--${level}`;
    entry.innerHTML = `<span class="log-ts">${timestamp()}</span><span class="log-msg">${escapeHtml(msg)}</span>`;
    this.el.appendChild(entry);
    this.count++;
    // Auto-scroll to bottom
    requestAnimationFrame(() => {
      this.scroll.scrollTop = this.scroll.scrollHeight;
    });
  }

  clear() {
    this.el.innerHTML = '';
    this.count = 0;
    this.write('Log cleared.', 'debug');
  }
}


/* ══════════════════════════════════════════════════════════════════
   SESSION CLOCK
══════════════════════════════════════════════════════════════════ */
class SessionClock {
  constructor() {
    this.el      = $('#session-time');
    this.start   = null;
    this._timer  = null;
  }

  begin() {
    this.start = Date.now();
    this._timer = setInterval(() => this._tick(), 1000);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
    this.start  = null;
    this.el.textContent = '00:00:00';
  }

  _tick() {
    if (!this.start) return;
    const s = Math.floor((Date.now() - this.start) / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2,'0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2,'0');
    const sec = String(s % 60).padStart(2,'0');
    this.el.textContent = `${h}:${m}:${sec}`;
  }
}


/* ══════════════════════════════════════════════════════════════════
   SETTINGS MANAGER
══════════════════════════════════════════════════════════════════ */
class SettingsManager {
  constructor() {
    this.cfg = { ...DEFAULTS };
    this._load();
    this._bindModal();
  }

  get(key)         { return this.cfg[key]; }
  set(key, val)    { this.cfg[key] = val; this._save(); }
  update(partial)  { Object.assign(this.cfg, partial); this._save(); }

  _load() {
    try {
      const raw = localStorage.getItem('milo_config');
      if (raw) Object.assign(this.cfg, JSON.parse(raw));
    } catch (_) { /* ignore */ }
    // Populate sidebar fields with saved values
    $('#api-key-input').value    = this.cfg.apiKey  || '';
    $('#model-select').value     = this.cfg.model   || DEFAULTS.model;
  }

  _save() {
    try { localStorage.setItem('milo_config', JSON.stringify(this.cfg)); } catch (_) {}
  }

  _bindModal() {
    const modal  = $('#settings-modal');
    const open   = () => {
      // Populate modal fields from current config
      $('#mapbox-token-input').value   = this.cfg.mapboxToken   || '';
      $('#voice-select').value         = this.cfg.voice         || DEFAULTS.voice;
      $('#system-prompt-input').value  = this.cfg.systemPrompt  || DEFAULTS.systemPrompt;
      $('#input-sample-rate').value    = this.cfg.inputSampleRate  || MIC_SAMPLE_RATE;
      $('#output-sample-rate').value   = this.cfg.outputSampleRate || OUT_SAMPLE_RATE;
      modal.classList.remove('hidden');
    };
    const close  = () => modal.classList.add('hidden');
    const save   = () => {
      this.update({
        mapboxToken:       $('#mapbox-token-input').value.trim(),
        voice:             $('#voice-select').value,
        systemPrompt:      $('#system-prompt-input').value.trim(),
        inputSampleRate:   parseInt($('#input-sample-rate').value, 10)  || MIC_SAMPLE_RATE,
        outputSampleRate:  parseInt($('#output-sample-rate').value, 10) || OUT_SAMPLE_RATE,
      });
      close();
    };

    $('#btn-settings').addEventListener('click', open);
    $('#btn-settings-close').addEventListener('click', close);
    $('#modal-backdrop').addEventListener('click', close);
    $('#btn-settings-save').addEventListener('click', save);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  }
}


/* ══════════════════════════════════════════════════════════════════
   WAVEFORM VISUALIZER
   Draws a real-time bar-style waveform on a <canvas>.
══════════════════════════════════════════════════════════════════ */
class WaveformViz {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {'in'|'out'} type  — determines bar colour
   */
  constructor(canvas, type = 'in') {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.type    = type;
    this.data    = new Float32Array(64).fill(0);
    this._raf    = null;
    this._draw();
  }

  /** Feed a Float32Array of samples; we compute energy per bucket */
  push(samples) {
    const buckets = this.data.length;
    const chunk   = Math.floor(samples.length / buckets);
    for (let b = 0; b < buckets; b++) {
      let energy = 0;
      const start = b * chunk;
      for (let i = start; i < start + chunk && i < samples.length; i++) {
        energy += samples[i] * samples[i];
      }
      // Smooth with previous value
      this.data[b] = this.data[b] * 0.5 + Math.sqrt(energy / chunk) * 0.5;
    }
  }

  /** Slowly decay toward silence */
  decay() {
    for (let i = 0; i < this.data.length; i++) this.data[i] *= 0.88;
  }

  _draw() {
    const { canvas, ctx, data } = this;
    const W = canvas.width;
    const H = canvas.height;
    const barW = (W / data.length) - 1;

    ctx.clearRect(0, 0, W, H);

    // Bar colour based on type
    const color = this.type === 'in' ? '96, 165, 250' : '167, 139, 250';

    for (let i = 0; i < data.length; i++) {
      const amplitude = Math.min(1, data[i] * 8);
      const barH = Math.max(2, amplitude * H * 0.85);
      const x = i * (barW + 1);
      const y = (H - barH) / 2;

      // Bar with slight alpha
      ctx.fillStyle = `rgba(${color}, ${0.3 + amplitude * 0.7})`;
      ctx.fillRect(x, y, barW, barH);
    }

    this._raf = requestAnimationFrame(() => this._draw());
  }

  destroy() { cancelAnimationFrame(this._raf); }
}


/* ══════════════════════════════════════════════════════════════════
   SPHERE VISUALIZER
   Animated particle sphere rendered on the welcome card canvas.
══════════════════════════════════════════════════════════════════ */
class SphereViz {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.W = this.H = 220;
    canvas.width  = this.W;
    canvas.height = this.H;
    this.particles = [];
    this.t = 0;
    this._init();
    this._draw();
  }

  _init() {
    // Generate particles on sphere surface using Fibonacci sphere
    const N = 280;
    const phi = Math.PI * (3 - Math.sqrt(5)); // golden angle
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const theta = phi * i;
      this.particles.push({
        x: Math.cos(theta) * r,
        y,
        z: Math.sin(theta) * r,
        size: 0.8 + Math.random() * 1.2,
        speed: 0.0004 + Math.random() * 0.0003,
      });
    }
  }

  _draw() {
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H / 2;
    const R  = 85; // sphere radius in pixels

    // Slow Y-axis rotation over time
    this.t += 0.004;
    const cosA = Math.cos(this.t);
    const sinA = Math.sin(this.t);

    // Project and sort by z for painter's algorithm
    const projected = this.particles.map(p => {
      const rx = p.x * cosA - p.z * sinA;
      const ry = p.y;
      const rz = p.x * sinA + p.z * cosA;
      return { rx, ry, rz, size: p.size };
    }).sort((a, b) => a.rz - b.rz);

    // Draw connection lines for nearby particles (front hemisphere only)
    for (let i = 0; i < projected.length; i++) {
      const pi = projected[i];
      if (pi.rz < -0.2) continue;
      for (let j = i + 1; j < projected.length; j++) {
        const pj = projected[j];
        if (pj.rz < -0.2) continue;
        const dx = pi.rx - pj.rx;
        const dy = pi.ry - pj.ry;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < 0.28) {
          const alpha = ((1 - dist / 0.28) * 0.18) * ((pi.rz + 1) / 2) * ((pj.rz + 1) / 2);
          ctx.beginPath();
          ctx.moveTo(cx + pi.rx * R, cy + pi.ry * R);
          ctx.lineTo(cx + pj.rx * R, cy + pj.ry * R);
          ctx.strokeStyle = `rgba(226,232,240,${alpha})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }

    // Draw particles
    for (const p of projected) {
      const depth = (p.rz + 1) / 2; // 0=back, 1=front
      const alpha = 0.2 + depth * 0.8;
      const sz    = p.size * (0.5 + depth * 0.8);
      const px    = cx + p.rx * R;
      const py    = cy + p.ry * R;

      ctx.beginPath();
      ctx.arc(px, py, sz, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(226,232,240,${alpha})`;
      ctx.fill();
    }

    requestAnimationFrame(() => this._draw());
  }
}


/* ══════════════════════════════════════════════════════════════════
   BOOT MANAGER
══════════════════════════════════════════════════════════════════ */
class BootManager {
  constructor(onComplete) {
    this.onComplete = onComplete;
    this._sphere    = null;
  }

  async run() {
    const splash  = $('#boot-splash');
    const bar     = $('#boot-bar');
    const lines   = $$('.boot-log-line');

    // Animate the particle background canvas
    this._runBootCanvas($('#boot-canvas'));

    // Sequentially reveal log lines
    for (let i = 0; i < lines.length; i++) {
      await this._delay(parseInt(lines[i].dataset.delay, 10));
      lines[i].classList.add('visible');
      bar.style.width = `${((i + 1) / lines.length) * 100}%`;
    }
    // Mark all done
    await this._delay(300);
    lines.forEach(l => l.classList.add('done'));
    await this._delay(600);

    // Fade out splash, show app
    splash.classList.add('fade-out');
    const appShell = $('#app-shell');
    appShell.classList.remove('hidden');
    appShell.style.opacity = '0';
    requestAnimationFrame(() => {
      appShell.style.transition = 'opacity 0.5s ease';
      appShell.style.opacity    = '1';
    });
    await this._delay(600);

    // Launch sphere on welcome card
    const sphereCanvas = $('#sphere-canvas');
    if (sphereCanvas) new SphereViz(sphereCanvas);

    this.onComplete();
  }

  _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  /** Simple particle field for the boot background */
  _runBootCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;

    const particles = Array.from({ length: 120 }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      size: 0.5 + Math.random() * 1.5,
    }));

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(148,163,184,0.6)';
        ctx.fill();
      });
      requestAnimationFrame(draw);
    };
    draw();

    window.addEventListener('resize', () => {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
    });
  }
}


/* ══════════════════════════════════════════════════════════════════
   TAB MANAGER
══════════════════════════════════════════════════════════════════ */
class TabManager {
  constructor() {
    this._active = 'chat';
    $$('[data-tab]', $('.canvas-tabs')).forEach(btn => {
      btn.addEventListener('click', () => this.switchTo(btn.dataset.tab));
    });
  }

  switchTo(tab) {
    this._active = tab;
    // Update tab buttons
    $$('[data-tab]', $('.canvas-tabs')).forEach(btn => {
      const isActive = btn.dataset.tab === tab;
      btn.classList.toggle('canvas-tab--active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });
    // Show/hide panels
    $('#tab-panel-chat').classList.toggle('tab-panel--active', tab === 'chat');
    $('#tab-panel-output').classList.toggle('tab-panel--active', tab === 'output');
    $('#tab-panel-chat').hidden   = tab !== 'chat';
    $('#tab-panel-output').hidden = tab !== 'output';
  }

  get active() { return this._active; }
}


/* ══════════════════════════════════════════════════════════════════
   CONTENT PARSER
   Scans streaming text for fenced blocks and emits events.
   Supports: ```lang, ```mermaid, ```map
══════════════════════════════════════════════════════════════════ */
class ContentParser {
  constructor() {
    this._buffer   = '';
    this.handlers  = {};
  }

  on(event, fn) { this.handlers[event] = fn; }
  emit(event, data) { this.handlers[event]?.(data); }

  /**
   * Feed streaming text chunk. Fires:
   *   'text'    (plainText)
   *   'code'    ({ lang, code })
   *   'diagram' ({ source })
   *   'map'     ({ locations: [{lat,lng,label}] })
   */
  feed(chunk) {
    this._buffer += chunk;
    this._process();
  }

  flush() {
    if (this._buffer.trim()) this.emit('text', this._buffer);
    this._buffer = '';
  }

  _process() {
    // Look for complete fenced block: ```lang\n...content...\n```
    const FENCE = /```(\w*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    FENCE.lastIndex = 0;
    while ((match = FENCE.exec(this._buffer)) !== null) {
      // Emit any plain text before this block
      const before = this._buffer.slice(lastIndex, match.index);
      if (before.trim()) this.emit('text', before);

      const lang    = (match[1] || 'text').toLowerCase();
      const content = match[2];

      if (lang === 'mermaid') {
        this.emit('diagram', { source: content.trim() });
      } else if (lang === 'map') {
        try {
          const locations = JSON.parse(content.trim());
          this.emit('map', { locations });
        } catch (e) {
          this.emit('text', match[0]); // fallback: show raw
        }
      } else {
        this.emit('code', { lang: lang || 'text', code: content });
      }

      lastIndex = match.index + match[0].length;
    }

    // Keep only the trailing unconsumed text (might be mid-fence)
    this._buffer = this._buffer.slice(lastIndex);
  }
}


/* ══════════════════════════════════════════════════════════════════
   CODE RENDERER
   Produces a syntax-highlighted, tabbed, copyable code block.
══════════════════════════════════════════════════════════════════ */
class CodeRenderer {
  static render(lang, code) {
    const el = document.createElement('div');
    el.className = 'code-block';
    el.innerHTML = `
      <div class="code-block__header">
        <span class="code-block__lang">${escapeHtml(lang)}</span>
        <div class="code-block__actions">
          <button class="code-block__btn js-copy" title="Copy to clipboard">COPY</button>
        </div>
      </div>
      <pre class="code-block__code">${CodeRenderer._highlight(code, lang)}</pre>
    `;
    // Wire copy button
    el.querySelector('.js-copy').addEventListener('click', function() {
      navigator.clipboard.writeText(code).then(() => {
        this.textContent = 'COPIED';
        this.classList.add('copied');
        setTimeout(() => { this.textContent = 'COPY'; this.classList.remove('copied'); }, 2000);
      });
    });
    return el;
  }

  /** Lightweight regex tokenizer — covers Python, JS, TS, Go, Rust, Bash, CSS, JSON */
  static _highlight(code, lang) {
    const escaped = escapeHtml(code);
    if (['text','txt','plaintext'].includes(lang)) return escaped;

    // Apply token patterns in order (priority matters)
    const tokens = [
      // Comments (line)
      { re: /(\/\/[^\n]*|#[^\n]*)/g, cls: 'tok-comment' },
      // Block comments
      { re: /(\/\*[\s\S]*?\*\/)/g, cls: 'tok-comment' },
      // Strings (single, double, template)
      { re: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, cls: 'tok-string' },
      // Keywords
      { re: /\b(import|export|from|default|const|let|var|function|class|return|if|else|for|while|do|switch|case|break|continue|new|delete|typeof|instanceof|in|of|async|await|try|catch|finally|throw|extends|implements|interface|type|enum|namespace|module|declare|abstract|public|private|protected|static|readonly|void|null|undefined|true|false|and|or|not|def|pass|yield|lambda|with|as|assert|global|nonlocal|del|elif|except|raise|import|from|fn|let|mut|struct|impl|trait|use|mod|pub|where|match|if|else|loop|while|for|in|return|break|continue|move|ref|Box|Arc|Rc|Vec|String|Option|Result|func|go|defer|select|chan|map|make|len|cap|append|copy|range|pkg|var|type|interface|struct|error)\b/g, cls: 'tok-keyword' },
      // Numbers
      { re: /\b(\d+\.?\d*(?:e[+-]?\d+)?|0x[\da-fA-F]+|0b[01]+|0o[0-7]+)\b/g, cls: 'tok-number' },
      // Function calls
      { re: /\b([a-zA-Z_$][\w$]*)\s*(?=\()/g, cls: 'tok-function' },
      // Types/Classes (CamelCase words)
      { re: /\b([A-Z][a-zA-Z0-9_]*)\b/g, cls: 'tok-type' },
    ];

    // Build a non-overlapping token map
    const marks = []; // {start, end, cls}
    for (const { re, cls } of tokens) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(escaped)) !== null) {
        const overlaps = marks.some(mk => m.index < mk.end && m.index + m[0].length > mk.start);
        if (!overlaps) marks.push({ start: m.index, end: m.index + m[0].length, cls });
      }
    }
    marks.sort((a, b) => a.start - b.start);

    // Reconstruct with <span> tags
    let out = '';
    let pos = 0;
    for (const mk of marks) {
      out += escaped.slice(pos, mk.start);
      out += `<span class="${mk.cls}">${escaped.slice(mk.start, mk.end)}</span>`;
      pos = mk.end;
    }
    out += escaped.slice(pos);
    return out;
  }
}


/* ══════════════════════════════════════════════════════════════════
   DIAGRAM RENDERER — Mermaid.js
══════════════════════════════════════════════════════════════════ */
class DiagramRenderer {
  static async render(source) {
    // Initialize Mermaid with dark theme matching our palette
    mermaid.initialize({
      startOnLoad:   false,
      theme:         'dark',
      themeVariables: {
        darkMode:         true,
        background:       '#161719',
        primaryColor:     '#1c1d20',
        primaryTextColor: '#e2e8f0',
        primaryBorderColor: '#374151',
        lineColor:        '#94a3b8',
        secondaryColor:   '#242528',
        tertiaryColor:    '#1c1d20',
      },
    });

    const wrap = document.createElement('div');
    wrap.className = 'diagram-block';
    wrap.innerHTML = `
      <div class="diagram-block__header">
        <span class="diagram-block__label">◈ DIAGRAM — MERMAID</span>
      </div>
      <div class="diagram-block__body">
        <div class="mermaid-render-target"></div>
      </div>
    `;

    const target = wrap.querySelector('.mermaid-render-target');
    try {
      const id   = `milo-diag-${Date.now()}`;
      const { svg } = await mermaid.render(id, source);
      target.innerHTML = svg;
    } catch (err) {
      target.innerHTML = `<pre style="color:#f87171;font-size:0.75rem;padding:1rem;">[Diagram error: ${escapeHtml(err.message)}]</pre>`;
    }
    return wrap;
  }
}


/* ══════════════════════════════════════════════════════════════════
   MAP RENDERER — Mapbox GL JS
══════════════════════════════════════════════════════════════════ */
class MapRenderer {
  /**
   * @param {Array<{lat:number, lng:number, label:string}>} locations
   * @param {string} token  Mapbox public access token
   */
  static render(locations, token) {
    const wrap = document.createElement('div');
    wrap.className = 'map-block';
    const mapId = `milo-map-${Date.now()}`;
    wrap.innerHTML = `
      <div class="map-block__header">
        <span class="map-block__label">◈ MAP — ${locations.length} LOCATION${locations.length !== 1 ? 'S' : ''}</span>
      </div>
      <div id="${mapId}" class="map-block__container"></div>
    `;

    // Defer map init until element is in DOM
    setTimeout(() => {
      if (!token) {
        $(`#${mapId}`).innerHTML = `<div style="padding:1rem;font-family:var(--font-mono);font-size:0.72rem;color:#f87171;">Mapbox token required. Add it in Settings.</div>`;
        return;
      }
      mapboxgl.accessToken = token;
      const map = new mapboxgl.Map({
        container: mapId,
        style:     'mapbox://styles/mapbox/dark-v11',
        center:    [locations[0].lng, locations[0].lat],
        zoom:      locations.length === 1 ? 10 : 4,
      });

      map.on('load', () => {
        map.addControl(new mapboxgl.NavigationControl(), 'top-right');
        locations.forEach(loc => {
          const marker = document.createElement('div');
          marker.style.cssText = `
            width:10px; height:10px; border-radius:50%;
            background:#e2e8f0; border:2px solid rgba(226,232,240,0.5);
            box-shadow: 0 0 8px rgba(226,232,240,0.5);
          `;
          new mapboxgl.Marker({ element: marker })
            .setLngLat([loc.lng, loc.lat])
            .setPopup(new mapboxgl.Popup({ offset: 10, closeButton: false })
              .setHTML(`<span style="font-family:var(--font-mono);font-size:0.72rem;">${escapeHtml(loc.label)}</span>`))
            .addTo(map);
        });
        // Fit bounds if multiple markers
        if (locations.length > 1) {
          const bounds = locations.reduce(
            (b, l) => b.extend([l.lng, l.lat]),
            new mapboxgl.LngLatBounds([locations[0].lng, locations[0].lat], [locations[0].lng, locations[0].lat])
          );
          map.fitBounds(bounds, { padding: 60, maxZoom: 12 });
        }
      });
    }, 0);

    return wrap;
  }
}


/* ══════════════════════════════════════════════════════════════════
   CHAT RENDERER
   Manages the message feed: user msgs, MILO streaming responses,
   and rich block injection.
══════════════════════════════════════════════════════════════════ */
class ChatRenderer {
  constructor(settings, tabManager, log) {
    this.settings   = settings;
    this.tabs       = tabManager;
    this.log        = log;
    this.feed       = $('#chat-feed');
    this.chatScroll = $('#chat-scroll');
    this.outputEl   = $('#output-canvas');
    this.outputEmpty = $('#output-empty');

    // Current streaming bubble reference
    this._activeBubble = null;
    this._activeText   = '';
    this._parser       = null;

    // Output canvas clear
    $('#btn-clear-output').addEventListener('click', () => this._clearOutput());
  }

  /** Add a user message bubble */
  addUser(text) {
    const msg = this._createBubble('user', 'YOU', text);
    this.feed.appendChild(msg);
    this._scrollBottom();
  }

  /** Begin a new MILO streaming response */
  beginMiloStream() {
    // Create thinking indicator first
    const thinking = this._createThinking();
    this.feed.appendChild(thinking);
    this._scrollBottom();

    this._parser = new ContentParser();
    this._activeText = '';
    this._activeBubble = null;
    this._thinking = thinking;

    // Wire parser events
    this._parser.on('text', text => this._onStreamText(text));
    this._parser.on('code',    ({ lang, code }) => this._onCode(lang, code));
    this._parser.on('diagram', ({ source })     => this._onDiagram(source));
    this._parser.on('map',     ({ locations })  => this._onMap(locations));
  }

  /** Feed a text chunk into the current stream */
  feedStreamChunk(chunk) {
    // Remove thinking indicator on first real content
    if (this._thinking) {
      this._thinking.remove();
      this._thinking = null;
    }
    this._parser?.feed(chunk);
    this._scrollBottom();
  }

  /** Finalize current stream */
  endStream() {
    this._parser?.flush();
    if (this._activeBubble) {
      // Remove streaming cursor
      this._activeBubble.classList.remove('stream-cursor');
    }
    this._activeBubble = null;
    this._parser = null;
    this._scrollBottom();
  }

  /** Add an error message */
  addError(msg) {
    const el = document.createElement('div');
    el.className = 'msg msg--milo';
    el.innerHTML = `
      <div class="msg__avatar">ERR</div>
      <div class="msg__bubble" style="border-color:rgba(248,113,113,0.3);color:#f87171;">
        <div class="msg__meta">
          <span class="msg__sender" style="color:#f87171;">ERROR</span>
          <span class="msg__ts">${timestamp()}</span>
        </div>
        ${escapeHtml(msg)}
      </div>
    `;
    this.feed.appendChild(el);
    this._scrollBottom();
  }

  /* ── Private helpers ─────────────────────────────────────────── */

  _onStreamText(text) {
    if (!this._activeBubble) {
      const msg = this._createBubble('milo', 'M.I.L.O.', '');
      msg.classList.add('msg--milo');
      this.feed.appendChild(msg);
      this._activeBubble = msg.querySelector('.msg__bubble p') || (() => {
        const p = document.createElement('p');
        msg.querySelector('.msg__bubble').appendChild(p);
        return p;
      })();
      this._activeBubble = msg.querySelector('.msg__bubble .bubble-text');
    }
    this._activeText += text;
    this._activeBubble.innerHTML = this._renderInlineMarkdown(this._activeText);
    this._activeBubble.closest('.msg__bubble').classList.add('stream-cursor');
    this._scrollBottom();
  }

  async _onCode(lang, code) {
    if (this._activeBubble) {
      this._activeBubble.closest('.msg__bubble').classList.remove('stream-cursor');
    }
    const block = CodeRenderer.render(lang, code);
    // Add to chat bubble
    const msgEl = this._activeBubble?.closest('.msg') || this._appendMiloBlock();
    msgEl.querySelector('.msg__bubble').appendChild(block);

    // Also push to output canvas
    this._pushToOutput(CodeRenderer.render(lang, code));
    this.log.write(`Code block rendered: ${lang}`, 'ok');
    this._scrollBottom();
  }

  async _onDiagram(source) {
    const block = await DiagramRenderer.render(source);
    const msgEl = this._activeBubble?.closest('.msg') || this._appendMiloBlock();
    msgEl.querySelector('.msg__bubble').appendChild(block);
    this._pushToOutput(await DiagramRenderer.render(source));
    this.log.write('Mermaid diagram rendered.', 'ok');
    this._scrollBottom();
  }

  _onMap(locations) {
    const token = this.settings.get('mapboxToken');
    const block = MapRenderer.render(locations, token);
    const msgEl = this._activeBubble?.closest('.msg') || this._appendMiloBlock();
    msgEl.querySelector('.msg__bubble').appendChild(block);
    this._pushToOutput(MapRenderer.render(locations, token));
    this.tabs.switchTo('output');
    this.log.write(`Map rendered: ${locations.length} location(s).`, 'ok');
    this._scrollBottom();
  }

  _appendMiloBlock() {
    const msg = this._createBubble('milo', 'M.I.L.O.', '');
    this.feed.appendChild(msg);
    return msg;
  }

  _pushToOutput(el) {
    this.outputEmpty.classList.add('hidden');
    this.outputEl.appendChild(el);
  }

  _clearOutput() {
    this.outputEl.innerHTML = '';
    this.outputEl.appendChild(this.outputEmpty);
    this.outputEmpty.classList.remove('hidden');
  }

  _createBubble(role, label, text) {
    const msg = document.createElement('div');
    msg.className = `msg msg--${role}`;
    msg.setAttribute('role', 'listitem');
    msg.innerHTML = `
      <div class="msg__avatar">${label.slice(0,3)}</div>
      <div class="msg__bubble">
        <div class="msg__meta">
          <span class="msg__sender">${escapeHtml(label)}</span>
          <span class="msg__ts">${timestamp()}</span>
        </div>
        <span class="bubble-text">${this._renderInlineMarkdown(escapeHtml(text))}</span>
      </div>
    `;
    if (role === 'user') {
      // Users on right — reorder avatar
      msg.style.flexDirection = 'row-reverse';
    }
    return msg;
  }

  _createThinking() {
    const el = document.createElement('div');
    el.className = 'msg msg--milo msg-thinking';
    el.innerHTML = `
      <div class="msg__avatar">MLO</div>
      <div class="msg__bubble">
        <div class="thinking-dots">
          <span></span><span></span><span></span>
        </div>
      </div>
    `;
    return el;
  }

  /** Minimal inline markdown: **bold**, *italic*, \`code\` */
  _renderInlineMarkdown(text) {
    return text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,     '<em>$1</em>')
      .replace(/`([^`]+)`/g,     '<code>$1</code>');
  }

  _scrollBottom() {
    requestAnimationFrame(() => {
      this.chatScroll.scrollTop = this.chatScroll.scrollHeight;
    });
  }
}


/* ══════════════════════════════════════════════════════════════════
   AUDIO ENGINE
   Handles:
     • Microphone capture → 16kHz mono Float32 → Int16 PCM → Base64
     • Incoming 24kHz PCM base64 → AudioBuffer → queued playback
     • Waveform data feeds
══════════════════════════════════════════════════════════════════ */
class AudioEngine {
  constructor(settings, log, micViz, outViz) {
    this.settings = settings;
    this.log      = log;
    this.micViz   = micViz;
    this.outViz   = outViz;

    this._micCtx         = null;  // AudioContext for capture
    this._outCtx         = null;  // AudioContext for playback
    this._mediaStream    = null;
    this._processorNode  = null;
    this._sourceNode     = null;
    this._analyserNode   = null;
    this._playbackQueue  = [];    // { buffer: Float32Array }[]
    this._isPlaying      = false;
    this._nextPlayTime   = 0;

    // Callbacks wired by ConnectionManager
    this.onPcmChunk = null; // (base64: string) => void
  }

  /** Request mic permission and set up 16kHz capture pipeline */
  async startCapture() {
    const inputRate = this.settings.get('inputSampleRate') || MIC_SAMPLE_RATE;

    // Create AudioContext at NATIVE rate — we resample internally
    this._micCtx = new AudioContext();

    this._mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount:     1,
        sampleRate:       inputRate,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
      },
      video: false,
    });

    this._sourceNode = this._micCtx.createMediaStreamSource(this._mediaStream);

    // Analyser for waveform viz
    this._analyserNode = this._micCtx.createAnalyser();
    this._analyserNode.fftSize = 256;
    this._sourceNode.connect(this._analyserNode);

    // If native rate differs from target 16kHz, create an OfflineAudioContext
    // resampler chain via ScriptProcessorNode
    const nativeRate  = this._micCtx.sampleRate;
    const targetRate  = inputRate;
    const ratio       = nativeRate / targetRate;
    const bufferSize  = PCM_BUFFER_SIZE;

    // ScriptProcessor (deprecated but universally supported; AudioWorklet path below)
    this._processorNode = this._micCtx.createScriptProcessor(bufferSize, 1, 1);
    this._processorNode.onaudioprocess = (e) => {
      const inputData  = e.inputBuffer.getChannelData(0); // Float32 at native rate
      const resampled  = this._resample(inputData, ratio);
      // Feed waveform
      this.micViz.push(resampled);
      // Convert to 16-bit PCM and base64
      if (this.onPcmChunk && this._capturing) {
        const pcmBuffer = float32ToInt16(resampled);
        const b64       = arrayBufferToBase64(pcmBuffer);
        this.onPcmChunk(b64);
      }
    };

    this._sourceNode.connect(this._processorNode);
    this._processorNode.connect(this._micCtx.destination); // must connect for Chrome
    this._capturing = false; // wait for PTT press

    this.log.write(`Mic capture ready (native ${nativeRate}Hz → target ${targetRate}Hz).`, 'audio');
  }

  /** Start streaming PCM to WebSocket */
  startStreaming()  { this._capturing = true; }

  /** Stop streaming (but keep mic active) */
  stopStreaming()   { this._capturing = false; }

  /** Fully stop and release microphone */
  stopCapture() {
    this._capturing = false;
    this._processorNode?.disconnect();
    this._sourceNode?.disconnect();
    this._analyserNode?.disconnect();
    this._mediaStream?.getTracks().forEach(t => t.stop());
    this._micCtx?.close();
    this._micCtx = null;
    this._mediaStream = null;
  }

  /** Simple linear resampling: downsample Float32 from nativeRate → targetRate */
  _resample(input, ratio) {
    if (ratio === 1) return input;
    const outputLength = Math.floor(input.length / ratio);
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const srcIdx = i * ratio;
      const lo     = Math.floor(srcIdx);
      const hi     = Math.min(lo + 1, input.length - 1);
      const frac   = srcIdx - lo;
      output[i]    = input[lo] * (1 - frac) + input[hi] * frac;
    }
    return output;
  }

  /** Enqueue a Base64-encoded 16-bit PCM chunk for playback at 24kHz */
  enqueueAudio(base64) {
    const outputRate = this.settings.get('outputSampleRate') || OUT_SAMPLE_RATE;
    const float32    = base64ToFloat32(base64, outputRate);
    this.outViz.push(float32);

    // Ensure playback context exists
    if (!this._outCtx) {
      this._outCtx    = new AudioContext({ sampleRate: outputRate });
      this._nextPlayTime = this._outCtx.currentTime;
    }

    const buf = this._outCtx.createBuffer(1, float32.length, outputRate);
    buf.getChannelData(0).set(float32);

    const source = this._outCtx.createBufferSource();
    source.buffer = buf;
    source.connect(this._outCtx.destination);

    // Schedule after last chunk for gapless playback
    const now = this._outCtx.currentTime;
    if (this._nextPlayTime < now) this._nextPlayTime = now;
    source.start(this._nextPlayTime);
    this._nextPlayTime += buf.duration;
  }

  /** Stop and flush any pending audio */
  stopPlayback() {
    this._nextPlayTime = 0;
    if (this._outCtx) {
      this._outCtx.close();
      this._outCtx = null;
    }
  }

  /** Poll analyser node for waveform decay when not speaking */
  tick() {
    if (!this._analyserNode) { this.micViz.decay(); return; }
    const buf = new Float32Array(this._analyserNode.frequencyBinCount);
    this._analyserNode.getFloatTimeDomainData(buf);
    this.micViz.push(buf);
    this.outViz.decay();
  }
}


/* ══════════════════════════════════════════════════════════════════
   CONNECTION MANAGER
   Manages the WebSocket connection to the Cloudflare edge function,
   which proxies to the Gemini Multimodal Live API.

   Message protocol (JSON envelopes):
     Client → Server:
       { type: 'init',   apiKey, model, systemPrompt, voice }
       { type: 'audio',  data: base64_pcm }
       { type: 'text',   text }
       { type: 'end_audio' }

     Server → Client:
       { type: 'text',       text }           – partial or full text
       { type: 'audio',      data: base64 }   – PCM audio chunk
       { type: 'turn_end'  }                  – model finished turn
       { type: 'error',      message }
       { type: 'connected' }
══════════════════════════════════════════════════════════════════ */
class ConnectionManager {
  constructor(settings, chat, audio, log, clock) {
    this.settings = settings;
    this.chat     = chat;
    this.audio    = audio;
    this.log      = log;
    this.clock    = clock;

    this._ws       = null;
    this._state    = 'disconnected'; // disconnected | connecting | connected
    this._sendBytes = 0;
    this._recvBytes = 0;
    this._lastPing  = 0;

    this._pingInterval = null;
    this._statsInterval = null;
  }

  get isConnected() { return this._state === 'connected'; }

  /** Open WebSocket and send init handshake */
  async connect(apiKey, model) {
    if (this._state !== 'disconnected') return;
    this._setState('connecting');

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}${WS_PATH}`;
    this.log.write(`Connecting to ${wsUrl}...`, 'info');

    this._ws = new WebSocket(wsUrl);
    this._ws.binaryType = 'arraybuffer';

    this._ws.onopen = () => {
      this.log.write('WebSocket open. Sending init handshake...', 'ok');
      // Send initialization packet
      this._send({
        type:         'init',
        apiKey:       apiKey,
        model:        model,
        systemPrompt: this.settings.get('systemPrompt'),
        voice:        this.settings.get('voice'),
        inputSampleRate:  this.settings.get('inputSampleRate')  || MIC_SAMPLE_RATE,
        outputSampleRate: this.settings.get('outputSampleRate') || OUT_SAMPLE_RATE,
      });
    };

    this._ws.onmessage = (event) => {
      this._recvBytes += typeof event.data === 'string' ? event.data.length : event.data.byteLength;
      try {
        const msg = JSON.parse(event.data);
        this._handleMessage(msg);
      } catch (e) {
        this.log.write(`Unparseable WS frame: ${e.message}`, 'warn');
      }
    };

    this._ws.onerror = (err) => {
      this.log.write('WebSocket error.', 'error');
      this._setState('disconnected');
    };

    this._ws.onclose = (e) => {
      this.log.write(`WebSocket closed (${e.code}).`, 'warn');
      this._setState('disconnected');
      this.clock.stop();
      clearInterval(this._pingInterval);
      clearInterval(this._statsInterval);
    };

    // Wire audio engine PCM callback
    this.audio.onPcmChunk = (b64) => {
      if (this.isConnected) {
        this._send({ type: 'audio', data: b64 });
      }
    };

    // Start a stats polling interval
    this._statsInterval = setInterval(() => this._updateStats(), 1000);
  }

  /** Send a text message */
  sendText(text) {
    if (!this.isConnected) return;
    this.chat.addUser(text);
    this._send({ type: 'text', text });
    this.log.write(`Text sent: "${text.slice(0,40)}..."`, 'info');
  }

  /** Signal end of mic audio turn */
  endAudioTurn() {
    if (!this.isConnected) return;
    this._send({ type: 'end_audio' });
    this.log.write('Audio turn ended.', 'audio');
  }

  /** Gracefully disconnect */
  disconnect() {
    if (this._ws) {
      this._ws.close(1000, 'User disconnected');
      this._ws = null;
    }
    this.audio.stopCapture();
    this.audio.stopPlayback();
    this._setState('disconnected');
    this.clock.stop();
    clearInterval(this._pingInterval);
    clearInterval(this._statsInterval);
    this.log.write('Session terminated.', 'warn');
  }

  /* ── Private ──────────────────────────────────────────────────── */

  _handleMessage(msg) {
    switch (msg.type) {

      case 'connected':
        this._setState('connected');
        this.log.write('Gemini Live API connected.', 'ok');
        this.clock.begin();
        this._pingInterval = setInterval(() => {
          this._lastPing = Date.now();
          this._send({ type: 'ping' });
        }, 5000);
        break;

      case 'pong':
        $('#telem-ping').textContent = `${Date.now() - this._lastPing}ms`;
        break;

      case 'text':
        // First text chunk starts the stream
        if (!this._streaming) {
          this.chat.beginMiloStream();
          this._streaming = true;
          this._setCanvasStatus('thinking');
        }
        this.chat.feedStreamChunk(msg.text || '');
        break;

      case 'audio':
        this.audio.enqueueAudio(msg.data);
        this._setCanvasStatus('speaking');
        break;

      case 'turn_end':
        this.chat.endStream();
        this._streaming = false;
        this._setCanvasStatus('idle');
        this.log.write('Turn complete.', 'ok');
        break;

      case 'error':
        this.chat.addError(msg.message || 'Unknown error from server.');
        this.log.write(`Server error: ${msg.message}`, 'error');
        this._setCanvasStatus('error');
        break;

      default:
        this.log.write(`Unknown message type: ${msg.type}`, 'debug');
    }
  }

  _send(payload) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      const str = JSON.stringify(payload);
      this._ws.send(str);
      this._sendBytes += str.length;
    }
  }

  _setState(state) {
    this._state = state;
    // Update UI chrome
    const orb  = $('#status-orb');
    const dot  = $('#conn-dot');
    const text = $('#conn-text');
    const btn  = $('#btn-disconnect');
    const btnC = $('#btn-connect');

    if (state === 'connected') {
      orb.className  = 'topbar__orb online';
      dot.className  = 'conn-status__dot online';
      text.textContent = 'LIVE';
      btn.disabled   = false;
      btnC.querySelector('#btn-connect-label').textContent = 'DISCONNECT';
      btnC.classList.add('connected');
      btnC.classList.remove('connecting');
      $('#panel-connect').classList.add('active');
      $('#panel-audio').classList.add('active');
      $('#btn-mic').disabled = false;
      $('#text-input').disabled = false;
      $('#btn-send').disabled = false;
      this._setCanvasStatus('idle');
    } else if (state === 'connecting') {
      orb.className  = 'topbar__orb warning';
      dot.className  = 'conn-status__dot warning';
      text.textContent = 'CONNECTING';
      btnC.classList.add('connecting');
      btnC.querySelector('#btn-connect-label').textContent = 'CONNECTING...';
    } else {
      orb.className  = 'topbar__orb';
      dot.className  = 'conn-status__dot';
      text.textContent = 'OFFLINE';
      btn.disabled   = true;
      btnC.querySelector('#btn-connect-label').textContent = 'INITIALIZE LINK';
      btnC.classList.remove('connected', 'connecting');
      $('#panel-connect').classList.remove('active');
      $('#panel-audio').classList.remove('active');
      $('#btn-mic').disabled = true;
      $('#text-input').disabled = true;
      $('#btn-send').disabled = true;
      this._setCanvasStatus('offline');
    }
  }

  _setCanvasStatus(state) {
    const dot  = $('#canvas-status-dot');
    const text = $('#canvas-status-text');
    dot.className = `canvas-status-dot ${state}`;
    const labels = {
      idle:     'ONLINE — READY',
      thinking: 'PROCESSING — GENERATING RESPONSE',
      speaking: 'TRANSMITTING — AUDIO PLAYBACK',
      error:    'ERROR — SEE SYSTEM LOG',
      offline:  'STANDBY — AWAITING INPUT',
    };
    text.textContent = labels[state] || 'STANDBY';
  }

  _updateStats() {
    // Rough bps calculation
    const sendBps = this._sendBytes * 8;
    const recvBps = this._recvBytes * 8;
    this._sendBytes = 0;
    this._recvBytes = 0;

    const fmt = n => n > 1000 ? `${(n/1000).toFixed(1)}kbps` : `${n}bps`;
    $('#telem-send').textContent = fmt(sendBps);
    $('#telem-recv').textContent = fmt(recvBps);

    // Animate bars (cap at 100kbps for bar width)
    const pct = (n) => `${Math.min(100, (n / 100000) * 100)}%`;
    $('#telem-bar-send').style.width = pct(sendBps);
    $('#telem-bar-recv').style.width = pct(recvBps);
  }
}


/* ══════════════════════════════════════════════════════════════════
   MILO APP — TOP-LEVEL ORCHESTRATOR
══════════════════════════════════════════════════════════════════ */
class MiloApp {
  constructor() {
    // Instantiate all subsystems
    this.settings = new SettingsManager();
    this.log      = new SystemLog();
    this.clock    = new SessionClock();
    this.tabs     = new TabManager();

    // Waveform visualizers
    this.micViz   = new WaveformViz($('#mic-canvas'), 'in');
    this.outViz   = new WaveformViz($('#out-canvas'), 'out');

    // Chat renderer
    this.chat = new ChatRenderer(this.settings, this.tabs, this.log);

    // Audio engine
    this.audio = new AudioEngine(this.settings, this.log, this.micViz, this.outViz);

    // Connection manager
    this.conn = new ConnectionManager(
      this.settings, this.chat, this.audio, this.log, this.clock
    );

    // Boot manager
    this.boot = new BootManager(() => this._onBooted());
  }

  /** Entry point */
  init() {
    this.boot.run();
  }

  /** Called once boot animation completes */
  _onBooted() {
    this.log.write('Boot sequence complete.', 'ok');
    this._bindControls();
    this._startAudioTick();
  }

  /** Wire all UI interactions */
  _bindControls() {

    // ── CONNECT / DISCONNECT button ─────────────────────────────
    $('#btn-connect').addEventListener('click', async () => {
      if (this.conn.isConnected) {
        this.conn.disconnect();
        return;
      }
      const apiKey = $('#api-key-input').value.trim();
      if (!apiKey) {
        this.log.write('API key is required.', 'error');
        $('#api-key-input').focus();
        return;
      }
      // Save key + model to settings
      this.settings.update({
        apiKey,
        model: $('#model-select').value,
      });
      // Start mic capture in parallel
      try {
        await this.audio.startCapture();
        this.log.write('Microphone access granted.', 'ok');
      } catch (err) {
        this.log.write(`Mic error: ${err.message}`, 'error');
      }
      // Open WebSocket
      await this.conn.connect(apiKey, $('#model-select').value);
    });

    // ── DISCONNECT button in topbar ──────────────────────────────
    $('#btn-disconnect').addEventListener('click', () => this.conn.disconnect());

    // ── API KEY eye toggle ───────────────────────────────────────
    $('#btn-toggle-key').addEventListener('click', () => {
      const inp = $('#api-key-input');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    // ── PUSH-TO-TALK mic button ──────────────────────────────────
    const micBtn   = $('#btn-mic');
    const micLabel = $('#mic-label');

    const startTalk = () => {
      if (!this.conn.isConnected) return;
      this.audio.startStreaming();
      micBtn.classList.add('recording');
      micLabel.textContent = 'LISTENING...';
      this.log.write('Mic streaming started.', 'audio');
      // Resume audio context if suspended (browser autoplay policy)
      this.audio._micCtx?.resume();
    };
    const stopTalk = () => {
      this.audio.stopStreaming();
      this.conn.endAudioTurn();
      micBtn.classList.remove('recording');
      micLabel.textContent = 'PUSH TO SPEAK';
      this.log.write('Mic streaming stopped.', 'audio');
    };

    micBtn.addEventListener('mousedown',  startTalk);
    micBtn.addEventListener('mouseup',    stopTalk);
    micBtn.addEventListener('mouseleave', stopTalk);
    micBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startTalk(); }, { passive: false });
    micBtn.addEventListener('touchend',   (e) => { e.preventDefault(); stopTalk(); },  { passive: false });

    // Spacebar PTT when textarea not focused
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && document.activeElement !== $('#text-input')) {
        e.preventDefault();
        if (!micBtn.classList.contains('recording')) startTalk();
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && document.activeElement !== $('#text-input')) {
        if (micBtn.classList.contains('recording')) stopTalk();
      }
    });

    // ── TEXT INPUT ───────────────────────────────────────────────
    const textInput = $('#text-input');
    const sendBtn   = $('#btn-send');

    const sendText = () => {
      const text = textInput.value.trim();
      if (!text || !this.conn.isConnected) return;
      this.conn.sendText(text);
      textInput.value = '';
      textInput.style.height = 'auto';
    };

    sendBtn.addEventListener('click', sendText);
    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
    });

    // Auto-resize textarea
    textInput.addEventListener('input', () => {
      textInput.style.height = 'auto';
      textInput.style.height = Math.min(textInput.scrollHeight, 160) + 'px';
    });

    // ── OUTPUT CANVAS: EXPORT ────────────────────────────────────
    $('#btn-export-output').addEventListener('click', () => {
      const html  = $('#output-canvas').innerHTML;
      const blob  = new Blob([`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{background:#111214;color:#e2e8f0;font-family:monospace;padding:2rem}</style></head><body>${html}</body></html>`], { type: 'text/html' });
      const a     = document.createElement('a');
      a.href      = URL.createObjectURL(blob);
      a.download  = `milo-output-${Date.now()}.html`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  /** Continuous audio tick for waveform decay */
  _startAudioTick() {
    const tick = () => {
      this.audio.tick();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}


/* ─── BOOTSTRAP ─────────────────────────────────────────────────── */
const app = new MiloApp();
app.init();
JSEOF
