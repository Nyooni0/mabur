<script>
  import { OSD_DEFAULTS } from '../lib/ui.svelte.js';
  let { osd, onChange } = $props();

  function set(key, value) {
    onChange({ ...osd, [key]: value });
  }
  function num(key, e) {
    const v = Number(e.currentTarget.value);
    if (Number.isFinite(v)) set(key, v);
  }
</script>

<div class="osd-panel">
  <p class="hint">Changes apply immediately to the OSD canvas.</p>

  <h3>Lens</h3>
  <label class="field">
    <span>FOV diagonal <em>{osd.fovDiag}°</em></span>
    <input type="range" min="60" max="170" step="1" value={osd.fovDiag}
      oninput={(e) => num('fovDiag', e)} />
  </label>

  <h3>Gimbal</h3>
  <label class="field">
    <span>Camera pitch offset <em>{osd.camPitch}°</em></span>
    <input type="range" min="-30" max="40" step="0.5" value={osd.camPitch}
      oninput={(e) => num('camPitch', e)} />
  </label>
  <div class="two">
    <label class="field">
      <span>Pitch RC</span>
      <input type="number" min="1" max="16" value={osd.gimbalPitchChannel}
        oninput={(e) => num('gimbalPitchChannel', e)} />
    </label>
    <label class="field">
      <span>Pitch strength <em>{osd.gimbalPitchStrength}°</em></span>
      <input type="range" min="0" max="90" step="1" value={osd.gimbalPitchStrength}
        oninput={(e) => num('gimbalPitchStrength', e)} />
    </label>
  </div>
  <label class="check">
    <input type="checkbox" checked={osd.gimbalYawEnabled}
      onchange={(e) => set('gimbalYawEnabled', e.currentTarget.checked)} />
    <span>Use RC yaw for the gimbal</span>
  </label>
  <div class="two" class:disabled={!osd.gimbalYawEnabled}>
    <label class="field">
      <span>Yaw RC</span>
      <input type="number" min="1" max="16" value={osd.gimbalYawChannel}
        oninput={(e) => num('gimbalYawChannel', e)} />
    </label>
    <label class="field">
      <span>Yaw strength <em>{osd.gimbalYawStrength}°</em></span>
      <input type="range" min="0" max="90" step="1" value={osd.gimbalYawStrength}
        oninput={(e) => num('gimbalYawStrength', e)} />
    </label>
  </div>
  <label class="field">
    <span>Throttle RC</span>
    <input type="number" min="1" max="16" value={osd.throttleChannel}
      oninput={(e) => num('throttleChannel', e)} />
  </label>

  <h3>Warnings</h3>
  <label class="field">
    <span>AoA first threshold <em>{osd.aoaWarn}°</em></span>
    <input type="range" min="0" max="30" step="1" value={osd.aoaWarn}
      oninput={(e) => num('aoaWarn', e)} />
  </label>
  <label class="field">
    <span>AoA critical threshold <em>{osd.aoaCritical}°</em></span>
    <input type="range" min="0" max="40" step="1" value={osd.aoaCritical}
      oninput={(e) => num('aoaCritical', e)} />
  </label>
  <label class="field">
    <span>Stall speed <em>{osd.stallSpeed} km/h</em></span>
    <input type="range" min="20" max="100" step="1" value={osd.stallSpeed}
      oninput={(e) => num('stallSpeed', e)} />
  </label>

  <h3>Motion</h3>
  <label class="field">
    <span>Smoothing <em>{osd.smoothingMs} ms</em></span>
    <input type="range" min="0" max="500" step="10" value={osd.smoothingMs}
      oninput={(e) => num('smoothingMs', e)} />
  </label>

  <button class="btn btn-ghost reset" type="button" onclick={() => onChange({ ...OSD_DEFAULTS })}>
    Reset OSD options
  </button>
</div>

<style>
  .osd-panel { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px 24px; }
  .hint { margin: 0; font-size: 11px; color: var(--color-neutral-400); line-height: 1.4; }
  h3 { margin: 8px 0 0; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
       color: var(--color-neutral-400); }
  .field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
  .field > span { display: flex; justify-content: space-between; gap: 8px; }
  .field em { font-style: normal; color: var(--color-accent-300); }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .two.disabled { opacity: .38; pointer-events: none; }
  .check { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  input[type="number"] { width: 100%; }
  .reset { align-self: flex-start; margin-top: 10px; }
</style>
