#!/usr/bin/env node
/**
 * xplane-td-analyze.mjs — анализатор NDJSON-трейса из `xplane-td-capture.mjs`.
 * Read-only офлайн-разбор: детект WOW-переходов (onground_any false→true),
 * VS касания (сырой кадр перехода), профиль по AGL (100/50/40/20/10 ft),
 * знаки тангажа/крена и подтверждение per-gear on_ground.
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'C:/Users/Igor/AppData/Local/Temp/opencode/xp-td.ndjson';
const M = 3.28084;
const raw = readFileSync(path, 'utf8').trim().split('\n');
const rows = [];
for (const line of raw) {
  const row = JSON.parse(line);
  if (row._meta) continue;
  rows.push(row);
}
console.log(`rows: ${rows.length}`);

const key = {
  lat: 'sim/flightmodel/position/latitude',
  lon: 'sim/flightmodel/position/longitude',
  elev: 'sim/flightmodel/position/elevation',
  agl: 'sim/flightmodel/position/y_agl',
  vs: 'sim/flightmodel/position/vh_ind_fpm',
  gs: 'sim/flightmodel/position/groundspeed',
  ias: 'sim/flightmodel/position/indicated_airspeed',
  psi: 'sim/flightmodel/position/true_psi',
  theta: 'sim/flightmodel/position/true_theta',
  phi: 'sim/flightmodel/position/true_phi',
  g: 'sim/flightmodel/forces/g_nrml',
  og: 'sim/flightmodel/failures/onground_any',
  g0: 'sim/flightmodel2/gear/on_ground[0]',
  g1: 'sim/flightmodel2/gear/on_ground[1]',
  g2: 'sim/flightmodel2/gear/on_ground[2]',
  paused: 'sim/time/paused',
  speed: 'sim/time/sim_speed',
};

const state = { prevGround: null, airborneSince: null, maxAgl: 0, lastAirVs: null, events: [] };
for (const r of rows) {
  const og = r[key.og];
  if (og === undefined) continue;
  const ground = og !== 0;
  const aglFt = r[key.agl] !== undefined ? r[key.agl] * M : null;
  if (aglFt !== null && ground === false) state.maxAgl = Math.max(state.maxAgl, aglFt);
  if (ground === false && r[key.vs] !== undefined && Number.isFinite(r[key.vs])) {
    state.lastAirVs = r[key.vs];
  }
  if (ground === false && state.airborneSince === null) state.airborneSince = r.t;
  if (state.prevGround === false && ground === true) {
    const airS = state.airborneSince ? (r.t - state.airborneSince) / 1000 : 0;
    state.events.push({
      t: r.t,
      vs: r[key.vs],
      aglFt,
      gs: r[key.gs],
      ias: r[key.ias],
      theta: r[key.theta],
      phi: r[key.phi],
      g: r[key.g],
      g0: r[key.g0],
      g1: r[key.g1],
      g2: r[key.g2],
      airDurationS: airS,
      maxAglFt: state.maxAgl,
      lastAirVs: state.lastAirVs,
    });
    state.airborneSince = null;
    state.maxAgl = 0;
  }
  state.prevGround = ground;
}

console.log(`\nWOW transitions (air->ground): ${state.events.length}`);
for (const e of state.events) {
  const reliable = e.maxAglFt > 30 && e.airDurationS >= 10;
  console.log(
    `  t=${e.t} vs_raw=${e.vs?.toFixed(1)} fpm  agl_at_frame=${e.aglFt?.toFixed(1)} ft ` +
      `gs=${(e.gs * 1.943844).toFixed(1)} kt ias=${e.ias?.toFixed(1)} kt ` +
      `gear_on_ground=${e.g0}/${e.g1}/${e.g2} air=${e.airDurationS.toFixed(1)}s maxAgl=${e.maxAglFt.toFixed(0)}ft ` +
      `lastAirVs=${e.lastAirVs?.toFixed(1)} reliable=${reliable}`,
  );
}

// Profile: before each reliable touchdown, VS at AGL thresholds.
for (const e of state.events) {
  if (!(e.maxAglFt > 30 && e.airDurationS >= 10)) continue;
  console.log(`\n--- VS profile before touchdown @ ${e.t} ---`);
  const thresholds = [100, 50, 40, 20, 10];
  const windowStart = e.t - 120000;
  const seg = rows.filter((r) => r.t >= windowStart && r.t <= e.t && r[key.og] === 0);
  const firstAtOrBelow = new Map();
  for (const r of seg) {
    const aglFt = r[key.agl] !== undefined ? r[key.agl] * M : null;
    if (aglFt === null) continue;
    for (const th of thresholds) {
      if (aglFt <= th && !firstAtOrBelow.has(th)) firstAtOrBelow.set(th, r);
    }
  }
  for (const th of thresholds) {
    const r = firstAtOrBelow.get(th);
    if (!r) {
      console.log(`  ${th} ft: n/a`);
      continue;
    }
    console.log(
      `  ${th} ft: vs=${r[key.vs]?.toFixed(1)} fpm (gs=${(r[key.gs] * 1.943844).toFixed(1)} kt, theta=${r[key.theta]?.toFixed(1)})`,
    );
  }
  // min (most negative) VS in last 2000ms airborne + g peak after contact
  const near = seg.filter((r) => r.t >= e.t - 3000);
  const minVs = near.reduce(
    (m, r) => (r[key.vs] < (m?.vs ?? Infinity) ? { vs: r[key.vs], t: r.t } : m),
    null,
  );
  console.log(`  min |sink| last 3s airborne: ${minVs ? minVs.vs.toFixed(1) : 'n/a'} fpm`);
  const after = rows.filter((r) => r.t >= e.t && r.t <= e.t + 2000);
  const gPeak = after.reduce((m, r) => Math.max(m, r[key.g] ?? 0), 0);
  console.log(`  g peak in [touchdown, +2s]: ${gPeak.toFixed(3)}`);
  console.log(`  VS at contact frame (raw): ${e.vs?.toFixed(1)} fpm`);
}

// Sign evidence: airborne pitch/roll/g ranges
const air = rows.filter((r) => r[key.og] === 0 && r[key.agl] !== undefined);
const airborne = air.filter((r) => r[key.agl] * M > 100);
if (airborne.length) {
  const range = (k) => {
    let min = Infinity,
      max = -Infinity;
    for (const r of airborne) {
      const v = r[k];
      if (Number.isFinite(v)) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    return [min, max];
  };
  console.log(`\nAirborne (>100 ft AGL, ${airborne.length} frames) ranges:`);
  for (const [label, k] of [
    ['true_theta(pitch)', key.theta],
    ['true_phi(roll)', key.phi],
    ['g_nrml', key.g],
    ['true_psi', key.psi],
    ['vs_fpm', key.vs],
  ]) {
    const [mn, mx] = range(k);
    console.log(`  ${label}: min=${mn.toFixed(2)} max=${mx.toFixed(2)}`);
  }
}

// pause/timewarp observations
const paused = rows.filter((r) => r[key.paused] !== undefined && r[key.paused] !== 0).length;
const warp = rows.filter(
  (r) => r[key.speed] !== undefined && Math.abs(r[key.speed] - 1) > 0.01,
).length;
console.log(`\nrows with paused!=0: ${paused}; rows with sim_speed!=1: ${warp}`);
console.log(`capture span: ${((rows[rows.length - 1].t - rows[0].t) / 1000).toFixed(0)} s`);
