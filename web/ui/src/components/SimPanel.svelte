<script>
  // Bench controls for `?sim=1`: freeze the flight model or pin attitude /
  // altitude / speed with the sliders, so OSD states that are rare in the
  // scripted circuit (level, knife-edge, zero speed, ceiling) can be checked.
  import { onMount } from 'svelte';

  let { sim } = $props();
  let open = $state(new URLSearchParams(location.search).has('simpane'));
  let manual = $state(false);
  let paused = $state(false);
  let vals = $state({ pitch: 0, roll: 0, alt: 0, speed: 0 });

  onMount(() => {
    // SimFeed is plain JS (no runes), so poll it while the panel is open.
    const iv = setInterval(() => {
      if (manual) return;
      const f = sim.flight;
      vals = { pitch: f.pitch, roll: f.roll, alt: f.alt, speed: f.speed };
    }, 120);
    return () => clearInterval(iv);
  });

  function toggleManual() {
    manual = !manual;
    sim.setManual(manual ? { ...vals } : null);
  }
  function togglePause() {
    paused = !paused;
    sim.paused = paused;
  }
  function set(key, raw) {
    vals = { ...vals, [key]: Number(raw) };
    if (manual) sim.setManual({ ...vals });
  }
</script>

<div class="simwrap">
  {#if !open}
    <button class="chip" type="button" onclick={() => (open = true)} title="Flight simulator controls">SIM</button>
  {:else}
    <div class="card">
      <div class="head">
        <span class="title">Flight sim</span>
        <button class="x" type="button" onclick={() => (open = false)} aria-label="Hide simulator controls">×</button>
      </div>
      <div class="row">
        <button class="tgl" class:on={manual} type="button" onclick={toggleManual}>Manual</button>
        <button class="tgl" class:on={paused} type="button" onclick={togglePause}>{paused ? 'Frozen' : 'Freeze'}</button>
      </div>
      <label class="sl">
        <span>Pitch</span><input type="range" min="-45" max="45" step="0.5" value={vals.pitch}
          oninput={(e) => set('pitch', e.currentTarget.value)} disabled={!manual} />
        <b>{vals.pitch.toFixed(1)}°</b>
      </label>
      <label class="sl">
        <span>Roll</span><input type="range" min="-75" max="75" step="0.5" value={vals.roll}
          oninput={(e) => set('roll', e.currentTarget.value)} disabled={!manual} />
        <b>{vals.roll.toFixed(1)}°</b>
      </label>
      <label class="sl">
        <span>Alt</span><input type="range" min="0" max="400" step="1" value={vals.alt}
          oninput={(e) => set('alt', e.currentTarget.value)} disabled={!manual} />
        <b>{vals.alt.toFixed(0)} m</b>
      </label>
      <label class="sl">
        <span>Speed</span><input type="range" min="0" max="45" step="0.5" value={vals.speed}
          oninput={(e) => set('speed', e.currentTarget.value)} disabled={!manual} />
        <b>{vals.speed.toFixed(1)} m/s</b>
      </label>
      <div class="hint">Turn on <b>Manual</b> to drive the values, <b>Freeze</b> to hold the current frame.</div>
    </div>
  {/if}
</div>

<style>
  .simwrap { position: absolute; left: 12px; bottom: 12px; z-index: 6; }
  .chip { font: inherit; font-size: 11px; letter-spacing: 0.08em; padding: 4px 9px; border-radius: 999px;
    color: #ffcf6b; background: rgb(20 18 8 / 0.72); border: 1px solid rgb(255 207 107 / 0.45); cursor: pointer; }
  .card { width: 248px; padding: 10px 12px 8px; border-radius: var(--radius-md, 8px);
    background: rgb(10 13 20 / 0.9); border: 1px solid var(--color-neutral-700, #333a4a);
    color: var(--color-text, #e8ecf5); font-size: 12px; box-shadow: 0 8px 24px rgb(0 0 0 / 0.4); }
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .title { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-neutral-400, #9aa3b5); }
  .x { background: none; border: 0; color: inherit; font-size: 16px; line-height: 1; cursor: pointer; padding: 0 2px; }
  .row { display: flex; gap: 6px; margin-bottom: 8px; }
  .tgl { flex: 1; font: inherit; font-size: 11px; padding: 4px 0; cursor: pointer; border-radius: 5px;
    background: transparent; color: var(--color-neutral-300, #c2c9d8); border: 1px solid var(--color-neutral-700, #333a4a); }
  .tgl.on { color: #0b1016; background: #8ff0c8; border-color: #8ff0c8; }
  .sl { display: grid; grid-template-columns: 42px 1fr 58px; align-items: center; gap: 6px; margin: 3px 0; }
  .sl span { color: var(--color-neutral-400, #9aa3b5); }
  .sl b { font-weight: 500; text-align: right; font-variant-numeric: tabular-nums; }
  .sl input { width: 100%; accent-color: #8ff0c8; }
  .hint { margin-top: 7px; font-size: 10.5px; line-height: 1.35; color: var(--color-neutral-500, #7c8598); }
  .hint b { color: var(--color-neutral-300, #c2c9d8); font-weight: 500; }
</style>
