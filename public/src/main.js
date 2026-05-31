/**
 * ═══════════════════════════════════════════════════════════════════
 * M.I.L.O. — main.js
 * Machine Intelligence & Local Operator
 * ═══════════════════════════════════════════════════════════════════
 */

'use strict';

const WS_PATH          = '/api/live-stream';   // Cloudflare Pages function pipeline
const MIC_SAMPLE_RATE  = 16000;                // Gemini input configuration
const OUT_SAMPLE_RATE  = 24000;                // Gemini output rate configuration
const PCM_BUFFER_SIZE  = 4096;                 
const RECONNECT_DELAY  = 3000;                 
const MAX_LOG_ENTRIES  = 200;                  

const DEFAULTS = {
  apiKey:       '',
  model:        'gemini-2.0-flash-exp',
  voice:        'Puck',
  mapboxToken:  '',
  systemPrompt: `You are M.I.L.O. (Machine Intelligence & Local Operator), a highly capable, voice-first AI assistant modeled after JARVIS. You are precise, efficient, technically expert, and occasionally dry-witted. Always be concise in voice responses. When outputting code, wrap it in triple backticks with a language identifier. When asked to visualize system flows or architectures, produce a Mermaid diagram in a \`\`\`mermaid block. When a query involves locations or mapping, output a JSON block tagged \`\`\`map containing an array of objects with {lat, lng, label} fields.`,
  inputSampleRate:  MIC_SAMPLE_RATE,
  outputSampleRate: OUT_SAMPLE_RATE,
};

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const timestamp = () => new Date().toLocaleTimeString('en-US', { hour12: false });

function float32ToInt16(float32Arr) {
  const int16 = new Int16Array(float32Arr.length);
  for (let i = 0; i < float32Arr.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32Arr[i]));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
  }
  return int16.buffer;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

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

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

class SystemLog {
  constructor() {
    this.el    = $('#system-log');
    this.scroll = $('#log-scroll');
    this.count  = 0;
    $('#btn-clear-log').addEventListener('click', () => this.clear());
    this.write('M.I.L.O. subsystems loaded.', 'info');
  }

  write(msg, level = 'info') {
    if (this.count >= MAX_LOG_ENTRIES) {
      const oldest = this.el.firstElementChild;
      if (oldest) this.el.removeChild(oldest);
    }
    const entry = document.createElement('div');
    entry.className = `log-entry log-entry--${level}`;
    entry.innerHTML = `<span class="log-ts">${timestamp()}</span><span class="log-msg">${escapeHtml(msg)}</span>`;
    this.el.appendChild(entry);
    this.count++;
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
    } catch (_) {}
    $('#api-key-input').value    = this.cfg.apiKey  || '';
    $('#model-select').value     = this.cfg.model   || DEFAULTS.model;
  }
  _save() {
    try { localStorage.setItem('milo_config', JSON.stringify(this.cfg)); } catch (_) {}
  }
  _bindModal() {
    const modal  = $('#settings-modal');
    const open   = () => {
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

class WaveformViz {
  constructor(canvas, type = 'in') {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.type    = type;
    this.data    = new Float32Array(64).fill(0);
    this._raf    = null;
    this._draw();
  }
  push(samples) {
    const buckets = this.data.length;
    const chunk   = Math.floor(samples.length / buckets);
    for (let b = 0; b < buckets; b++) {
      let energy = 0;
      const start = b * chunk;
      for (let i = start; i < start + chunk && i < samples.length; i++) {
        energy += samples[i] * samples[i];
      }
      this.data[b] = this.data[b] * 0.5 + Math.sqrt(energy / chunk) * 0.5;
    }
  }
  decay() {
    for (let i = 0; i < this.data.length; i++) this.data[i] *= 0.88;
  }
  _draw() {
    const { canvas, ctx, data } = this;
    const W = canvas.width;
    const H = canvas.height;
    const barW = (W / data.length) - 1;
    ctx.clearRect(0, 0, W, H);
    const color = this.type === 'in' ? '148, 163, 184' : '226, 232, 240';
    for (let i = 0; i < data.length; i++) {
      const amplitude = Math.min(1, data[i] * 8);
      const barH = Math.max(2, amplitude * H * 0.85);
      const x = i * (barW + 1);
      const y = (H - barH) / 2;
      ctx.fillStyle = `rgba(${color}, ${0.3 + amplitude * 0.7})`;
      ctx.fillRect(x, y, barW, barH);
    }
    this._raf = requestAnimationFrame(() => this._draw());
  }
  destroy() { cancelAnimationFrame(this._raf); }
}

class SphereViz {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = this.H = 220;
    canvas.width = this.W;
    canvas.height = this.H;
    this.particles = [];
    this.t = 0;
    this._init();
    this._draw();
  }
  _init() {
    const N = 280;
    const phi = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const theta = phi * i;
      this.particles.push({
        x: Math.cos(theta) * r,
        y: y,
        z: Math.sin(theta) * r,
        ox: Math.cos(theta) * r,
        oy: y,
        oz: Math.sin(theta) * r
      });
    }
  }
  updateFeedback(volume) {
    const factor = 1.0 + volume * 1.5;
    for (let p of this.particles) {
      p.x = p.ox * factor;
      p.y = p.oy * factor;
      p.z = p.oz * factor;
    }
  }
  _draw() {
    const { ctx, W, H, particles } = this;
    ctx.clearRect(0, 0, W, H);
    this.t += 0.006;
    const cx = W / 2, cy = H / 2, radius = 72;
    const cosT = Math.cos(this.t), sinT = Math.sin(this.t);
    
    ctx.fillStyle = 'rgba(226, 232, 240, 0.75)';
    for (let p of particles) {
      let x1 = p.x * cosT - p.z * sinT;
      let z1 = p.z * cosT + p.x * sinT;
      let y1 = p.y;
      
      let x2 = x1;
      let y2 = y1 * Math.cos(this.t * 0.5) - z1 * Math.sin(this.t * 0.5);
      let z2 = z1 * Math.cos(this.t * 0.5) + y1 * Math.sin(this.t * 0.5);
      
      const depth = (z2 + 1.5) / 3;
      const sz = Math.max(0.5, depth * 2.2);
      const scrX = cx + x2 * radius;
      const scrY = cy + y2 * radius;
      
      if (scrX >= 0 && scrX <= W && scrY >= 0 && scrY <= H) {
        ctx.globalAlpha = Math.max(0.1, depth * 0.8);
        ctx.beginPath();
        ctx.arc(scrX, scrY, sz, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1.0;
    this._raf = requestAnimationFrame(() => this._draw());
  }
  destroy() { cancelAnimationFrame(this._raf); }
}

class ChatRenderer {
  constructor() {
    this.feed = $('#chat-feed');
    this._activeBubble = null;
    this._activeText = '';
  }
  clearWelcome() {
    const card = $('#welcome-card');
    if (card) card.remove();
  }
  
  // FIXED: Reference management flow correctly assigned here to fix crashing loops
  _onStreamText(text) {
    this.clearWelcome();
    if (!this._activeBubble) {
      const msg = this._createBubble('milo', 'M.I.L.O.', '');
      this.feed.appendChild(msg);
      this._activeBubble = msg.querySelector('.bubble-text');
    }
    this._activeText += text;
    this._activeBubble.innerHTML = this._renderInlineMarkdown(this._activeText);
    this._scrollBottom();
  }

  resetStreamTarget() {
    this._activeBubble = null;
    this._activeText = '';
  }

  _createBubble(sender, label, text) {
    const wrap = document.createElement('div');
    wrap.className = `msg-wrap msg-wrap--${sender}`;
    wrap.innerHTML = `
      <div class="msg__meta">
        <span class="msg__label">${label}</span>
        <span class="msg__time">${timestamp()}</span>
      </div>
      <div class="msg__bubble">
        <div class="bubble-text">${this._renderInlineMarkdown(text)}</div>
      </div>
    `;
    return wrap;
  }

  _renderInlineMarkdown(txt) {
    return escapeHtml(txt)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  }

  _scrollBottom() {
    requestAnimationFrame(() => { this.feed.scrollTop = this.feed.scrollHeight; });
  }
}

// Minimal placeholder stubs to guarantee system boot stability
class BootManager { constructor() { setTimeout(() => $('#app-shell').classList.remove('hidden'), 500); } }
class ConnectionManager { constructor() { this.isConnected = false; } }
class AudioEngine { constructor() { this.isActive = false; } }
class ContentParser { constructor() {}}
class TabManager { constructor() {}}

class MiloApp {
  constructor() {
    this.log      = new SystemLog();
    this.clock    = new SessionClock();
    this.settings = new SettingsManager();
    this.chat     = new ChatRenderer();
    
    const sCanvas = $('#sphere-canvas');
    if (sCanvas) this.sphere = new SphereViz(sCanvas);
    
    this.boot = new BootManager();
    this.log.write('M.I.L.O. Workspace initialized fully.', 'success');
  }
}

window.addEventListener('DOMContentLoaded', () => { window.app = new MiloApp(); });
